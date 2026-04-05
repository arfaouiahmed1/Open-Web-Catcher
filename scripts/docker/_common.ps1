Set-StrictMode -Version Latest

function Get-OwcContext {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CallerPath
    )

    $scriptDir = Split-Path -Parent $CallerPath
    $rootDir = (Resolve-Path (Join-Path $scriptDir "..\..")).Path

    $image = if ($env:OWC_IMAGE) { $env:OWC_IMAGE } else { "open-web-catcher" }
    $tag = if ($env:OWC_TAG) { $env:OWC_TAG } else { "latest" }
    $container = if ($env:OWC_CONTAINER) { $env:OWC_CONTAINER } else { "owc" }

    [pscustomobject]@{
        ScriptDir = $scriptDir
        RootDir = $rootDir
        Image = $image
        Tag = $tag
        ImageRef = "$image`:$tag"
        Container = $container
        EnvFile = Join-Path $rootDir ".env"
        ExampleEnvFile = Join-Path $rootDir ".env.example"
        DataDir = Join-Path $rootDir "data"
        ConfigsDir = Join-Path $rootDir "configs"
        Dockerfile = Join-Path $rootDir "Dockerfile"
        HealthUrl = "http://localhost:8000/health"
    }
}

function Test-OwcInteractive {
    try {
        return [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected
    }
    catch {
        return $false
    }
}

function Write-OwcSection {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host ""
    Write-Host "== $Message =="
}

function Write-OwcInfo {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "[info] $Message"
}

function Write-OwcWarn {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "[warn] $Message" -ForegroundColor Yellow
}

function Write-OwcSuccess {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "[ok] $Message" -ForegroundColor Green
}

function Confirm-OwcAction {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Prompt,
        [switch]$DefaultYes,
        [switch]$Yes,
        [switch]$NoPrompt
    )

    if ($Yes) {
        return $true
    }

    if ($NoPrompt -or -not (Test-OwcInteractive)) {
        return [bool]$DefaultYes
    }

    $suffix = if ($DefaultYes) { "[Y/n]" } else { "[y/N]" }

    while ($true) {
        $answer = (Read-Host "$Prompt $suffix").Trim()
        if ([string]::IsNullOrWhiteSpace($answer)) {
            return [bool]$DefaultYes
        }

        switch -Regex ($answer.ToLowerInvariant()) {
            "^(y|yes)$" { return $true }
            "^(n|no)$" { return $false }
            default { Write-OwcWarn "Please answer yes or no." }
        }
    }
}

function Assert-DockerAvailable {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "Docker CLI was not found. Install Docker Desktop or ensure 'docker' is on PATH."
    }
}

function ConvertTo-OwcCommandLineArgument {
    param([AllowNull()][string]$Value)

    if ($null -eq $Value -or $Value -eq "") {
        return '""'
    }

    if ($Value -notmatch '[\s"]') {
        return $Value
    }

    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

function Join-OwcCommandLineArguments {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    return (($Arguments | ForEach-Object { ConvertTo-OwcCommandLineArgument -Value $_ }) -join ' ')
}

function Invoke-DockerCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = "docker"
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true

    $argumentListProperty = $startInfo.GetType().GetProperty("ArgumentList")
    if ($null -ne $argumentListProperty) {
        foreach ($argument in $Arguments) {
            [void]$startInfo.ArgumentList.Add($argument)
        }
    }
    else {
        $startInfo.Arguments = Join-OwcCommandLineArguments -Arguments $Arguments
    }

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo

    $null = $process.Start()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    $output = @()
    if (-not [string]::IsNullOrWhiteSpace($stdout)) {
        $output += ($stdout.TrimEnd("`r", "`n") -split "\r?\n")
    }
    if (-not [string]::IsNullOrWhiteSpace($stderr)) {
        $output += ($stderr.TrimEnd("`r", "`n") -split "\r?\n")
    }

    $exitCode = $process.ExitCode

    [pscustomobject]@{
        Arguments = $Arguments
        ExitCode = $exitCode
        Output = $output
        Text = (($output | ForEach-Object { "$_" }) -join [Environment]::NewLine).Trim()
    }
}

function Invoke-DockerChecked {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $result = Invoke-DockerCapture -Arguments $Arguments

    foreach ($line in $result.Output) {
        Write-Host $line
    }

    if ($result.ExitCode -ne 0) {
        $details = if ($result.Text) { "`n$($result.Text)" } else { "" }
        throw "Docker command failed: docker $($Arguments -join ' ')$details"
    }
}

function Test-OwcImageExists {
    param([Parameter(Mandatory = $true)][string]$ImageRef)

    $result = Invoke-DockerCapture -Arguments @("image", "inspect", $ImageRef)
    return $result.ExitCode -eq 0
}

function Test-OwcContainerExists {
    param([Parameter(Mandatory = $true)][string]$Container)

    $result = Invoke-DockerCapture -Arguments @("container", "inspect", $Container)
    return $result.ExitCode -eq 0
}

function Test-OwcContainerRunning {
    param([Parameter(Mandatory = $true)][string]$Container)

    $result = Invoke-DockerCapture -Arguments @("container", "inspect", "--format", "{{.State.Running}}", $Container)
    return $result.ExitCode -eq 0 -and $result.Text -eq "true"
}

function Get-OwcContainerState {
    param([Parameter(Mandatory = $true)][string]$Container)

    $result = Invoke-DockerCapture -Arguments @("container", "inspect", "--format", "{{.State.Status}}", $Container)
    if ($result.ExitCode -ne 0) {
        return $null
    }

    return $result.Text
}

function Get-OwcContainerHealthStatus {
    param([Parameter(Mandatory = $true)][string]$Container)

    $result = Invoke-DockerCapture -Arguments @("container", "inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", $Container)
    if ($result.ExitCode -ne 0) {
        return $null
    }

    return $result.Text
}

function Wait-OwcContainerHealthy {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Container,
        [int]$TimeoutSeconds = 180
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastHealth = $null

    while ((Get-Date) -lt $deadline) {
        if (-not (Test-OwcContainerExists -Container $Container)) {
            throw "Container '$Container' disappeared while waiting for it to become ready."
        }

        $state = Get-OwcContainerState -Container $Container
        if ($state -ne "running") {
            throw "Container '$Container' is not running. Current state: $state"
        }

        $health = Get-OwcContainerHealthStatus -Container $Container
        if ([string]::IsNullOrWhiteSpace($health) -or $health -eq "none" -or $health -eq "healthy") {
            Write-OwcSuccess "Container '$Container' is ready."
            return
        }

        if ($health -ne $lastHealth) {
            Write-OwcInfo "Waiting for '$Container' to become healthy... (status: $health)"
            $lastHealth = $health
        }

        Start-Sleep -Seconds 2
    }

    $finalHealth = Get-OwcContainerHealthStatus -Container $Container
    throw "Timed out after $TimeoutSeconds seconds waiting for '$Container'. Last health status: $finalHealth"
}

function Get-OwcDockerExecFlags {
    if (Test-OwcInteractive) {
        return @("-it")
    }

    return @("-i")
}

function Resolve-OwcBuildUsesCache {
    param(
        [switch]$NoCache,
        [switch]$Yes,
        [switch]$NoPrompt
    )

    if ($NoCache) {
        return $false
    }

    if ($Yes -or $NoPrompt -or -not (Test-OwcInteractive)) {
        return $true
    }

    return Confirm-OwcAction -Prompt "Use Docker layer cache for this build?" -DefaultYes
}

function Invoke-OwcBuild {
    param(
        [Parameter(Mandatory = $true)]
        $Context,
        [switch]$NoCache
    )

    $buildArgs = @("build")
    if ($NoCache) {
        $buildArgs += "--no-cache"
    }

    $buildArgs += @("-f", $Context.Dockerfile, "-t", $Context.ImageRef, $Context.RootDir)
    Invoke-DockerChecked -Arguments $buildArgs

    $modeLabel = if ($NoCache) { "without cache" } else { "with cache" }
    Write-OwcSuccess "Built image $($Context.ImageRef) ($modeLabel)."
}

function Show-OwcEndpoints {
    param([Parameter(Mandatory = $true)]$Context)

    Write-Host ""
    Write-Host "Services:"
    Write-Host "  FastAPI  -> http://localhost:8000"
    Write-Host "  Gradio   -> http://localhost:7860"
    Write-Host "  API docs -> http://localhost:8000/docs"
    Write-Host "  Health   -> $($Context.HealthUrl)"
}
