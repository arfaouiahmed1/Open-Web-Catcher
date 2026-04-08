Set-StrictMode -Version Latest

function Get-OwcContext {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CallerPath
    )

    $scriptDir = Split-Path -Parent $CallerPath
    $rootDir = (Resolve-Path (Join-Path $scriptDir "..\..")).Path

    $image = if ($env:OWC_IMAGE) { $env:OWC_IMAGE } else { "open-web-catcher" }
    $toolsImage = if ($env:OWC_TOOLS_IMAGE) { $env:OWC_TOOLS_IMAGE } else { "open-web-catcher-tools" }
    $webImage = if ($env:OWC_WEB_IMAGE) { $env:OWC_WEB_IMAGE } else { "open-web-catcher-web" }
    $tag = if ($env:OWC_TAG) { $env:OWC_TAG } else { "latest" }
    $container = if ($env:OWC_CONTAINER) { $env:OWC_CONTAINER } else { "owc" }
    $toolsContainer = if ($env:OWC_TOOLS_CONTAINER) { $env:OWC_TOOLS_CONTAINER } else { "owc-tools" }
    $webContainer = if ($env:OWC_WEB_CONTAINER) { $env:OWC_WEB_CONTAINER } else { "owc-web" }

    [pscustomobject]@{
        ScriptDir = $scriptDir
        RootDir = $rootDir
        ComposeFile = Join-Path $rootDir "docker-compose.yml"
        Image = $image
        ToolImage = $toolsImage
        WebImage = $webImage
        Tag = $tag
        ImageRef = "$image`:$tag"
        ToolImageRef = "$toolsImage`:$tag"
        WebImageRef = "$webImage`:$tag"
        Container = $container
        ToolContainer = $toolsContainer
        WebContainer = $webContainer
        Service = "owc"
        ToolService = "owc-tools"
        WebService = "owc-web"
        EnvFile = Join-Path $rootDir ".env"
        ExampleEnvFile = Join-Path $rootDir ".env.example"
        DataDir = Join-Path $rootDir "data"
        ConfigsDir = Join-Path $rootDir "configs"
        Dockerfile = Join-Path $rootDir "Dockerfile"
        HealthUrl = "http://localhost:8000/health"
        ApiUrl = "http://localhost:8000"
        ConsoleUrl = "http://localhost:3001"
        McpUrl = "http://localhost:3000"
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

function Write-OwcHeader {
    param([Parameter(Mandatory = $true)][string]$Title)
    Write-Host ""
    Write-Host "  ========================================" -ForegroundColor Cyan
    Write-Host ("  {0}" -f $Title) -ForegroundColor Cyan
    Write-Host "  ========================================" -ForegroundColor Cyan
    Write-Host ""
}

function Write-OwcSection {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host ""
    Write-Host "== $Message ==" -ForegroundColor Cyan
}

function Write-OwcDivider {
    Write-Host "----------------------------------------" -ForegroundColor DarkGray
}

function Write-OwcInfo {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "[info] $Message"
}

function Write-OwcStep {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "[step] $Message" -ForegroundColor White
}

function Write-OwcWarn {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "[warn] $Message" -ForegroundColor Yellow
}

function Write-OwcSuccess {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "[ok] $Message" -ForegroundColor Green
}

function Write-OwcFail {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "[fail] $Message" -ForegroundColor Red
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

function Format-OwcDuration {
    param([Parameter(Mandatory = $true)][TimeSpan]$Duration)

    $parts = New-Object System.Collections.Generic.List[string]
    if ($Duration.Hours -gt 0) {
        [void]$parts.Add("$($Duration.Hours) hr")
    }
    if ($Duration.Minutes -gt 0) {
        [void]$parts.Add("$($Duration.Minutes) min")
    }
    [void]$parts.Add("$($Duration.Seconds) sec")
    return ($parts -join " ")
}

function Assert-OwcProjectFiles {
    param([Parameter(Mandatory = $true)]$Context)

    if (-not (Test-Path $Context.ComposeFile)) {
        throw "Required compose file '$($Context.ComposeFile)' was not found."
    }

    if (-not (Test-Path $Context.ConfigsDir)) {
        throw "Required directory '$($Context.ConfigsDir)' was not found."
    }
}

function Ensure-OwcDataDir {
    param([Parameter(Mandatory = $true)]$Context)

    if (-not (Test-Path $Context.DataDir)) {
        New-Item -ItemType Directory -Path $Context.DataDir -Force | Out-Null
        Write-OwcInfo "Created data directory at '$($Context.DataDir)'."
    }
}

function Ensure-OwcEnvFile {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [switch]$Yes
    )

    if (Test-Path $Context.EnvFile) {
        return
    }

    if (Test-Path $Context.ExampleEnvFile) {
        Write-OwcWarn "No .env file was found."
        Write-OwcInfo "Expected: '$($Context.EnvFile)'"
        Write-OwcInfo "Template: '$($Context.ExampleEnvFile)'"

        if (Confirm-OwcAction -Prompt "Copy .env.example to .env now?" -DefaultYes -Yes:$Yes) {
            Copy-Item -Path $Context.ExampleEnvFile -Destination $Context.EnvFile
            Write-OwcSuccess "Created .env from .env.example."
            return
        }
    }

    throw "Missing required .env file. Create '$($Context.EnvFile)' before starting the stack."
}

function Invoke-DockerCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [switch]$StreamOutput
    )

    $output = New-Object System.Collections.Generic.List[string]
    $previousNativeCommandPreference = $null
    $hasNativeCommandPreference = Test-Path variable:PSNativeCommandUseErrorActionPreference
    $previousErrorActionPreference = $ErrorActionPreference
    $exitCode = 0

    try {
        if ($hasNativeCommandPreference) {
            $previousNativeCommandPreference = $PSNativeCommandUseErrorActionPreference
            $PSNativeCommandUseErrorActionPreference = $false
        }

        $ErrorActionPreference = "Continue"

        & docker @Arguments 2>&1 | ForEach-Object {
            $line = if ($_ -is [System.Management.Automation.ErrorRecord]) {
                $_.ToString()
            }
            else {
                [string]$_
            }

            if (-not [string]::IsNullOrWhiteSpace($line)) {
                $output.Add($line)
                if ($StreamOutput) {
                    Write-Host $line
                }
            }
        }

        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference

        if ($hasNativeCommandPreference) {
            $PSNativeCommandUseErrorActionPreference = $previousNativeCommandPreference
        }
    }

    [pscustomobject]@{
        Arguments = $Arguments
        ExitCode = $exitCode
        Output = $output.ToArray()
        Text = (($output.ToArray() | ForEach-Object { "$_" }) -join [Environment]::NewLine).Trim()
    }
}

function Invoke-DockerChecked {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $result = Invoke-DockerCapture -Arguments $Arguments -StreamOutput
    if ($result.ExitCode -ne 0) {
        $details = if ($result.Text) { "`n$($result.Text)" } else { "" }
        throw "Docker command failed: docker $($Arguments -join ' ')$details"
    }

    return $result
}

function Assert-DockerAvailable {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw "Docker CLI was not found. Install Docker Desktop or ensure 'docker' is on PATH."
    }

    $composeResult = Invoke-DockerCapture -Arguments @("compose", "version")
    if ($composeResult.ExitCode -ne 0) {
        $details = if ($composeResult.Text) { "`n$($composeResult.Text)" } else { "" }
        throw "Docker Compose is not available from this Docker CLI.$details"
    }

    $daemonResult = Invoke-DockerCapture -Arguments @("version", "--format", "{{.Server.Version}}")
    if ($daemonResult.ExitCode -ne 0) {
        $details = if ($daemonResult.Text) { "`n$($daemonResult.Text)" } else { "" }
        throw "Docker CLI is installed, but the Docker daemon is not reachable. Start Docker Desktop and make sure your account can access the Docker engine.$details"
    }
}

function Get-OwcComposeBaseArguments {
    param([Parameter(Mandatory = $true)]$Context)

    return @("compose", "-f", $Context.ComposeFile, "--project-directory", $Context.RootDir)
}

function Invoke-OwcComposeCapture {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$StreamOutput
    )

    $composeArgs = (Get-OwcComposeBaseArguments -Context $Context) + $Arguments
    return Invoke-DockerCapture -Arguments $composeArgs -StreamOutput:$StreamOutput
}

function Invoke-OwcComposeChecked {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    $composeArgs = (Get-OwcComposeBaseArguments -Context $Context) + $Arguments
    return Invoke-DockerChecked -Arguments $composeArgs
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

function Test-OwcImageExists {
    param([Parameter(Mandatory = $true)][string]$ImageRef)

    $result = Invoke-DockerCapture -Arguments @("image", "inspect", $ImageRef)
    return $result.ExitCode -eq 0
}

function Get-OwcServiceContainerId {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [string]$Service = $Context.Service
    )

    $result = Invoke-OwcComposeCapture -Context $Context -Arguments @("ps", "-q", $Service)
    if ($result.ExitCode -ne 0) {
        return $null
    }

    $containerId = $result.Text.Trim()
    if ([string]::IsNullOrWhiteSpace($containerId)) {
        return $null
    }

    return $containerId
}

function Test-OwcServicePresent {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [string]$Service = $Context.Service
    )

    return -not [string]::IsNullOrWhiteSpace((Get-OwcServiceContainerId -Context $Context -Service $Service))
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

function Get-OwcServiceState {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [string]$Service = $Context.Service
    )

    $containerId = Get-OwcServiceContainerId -Context $Context -Service $Service
    if ([string]::IsNullOrWhiteSpace($containerId)) {
        return $null
    }

    return Get-OwcContainerState -Container $containerId
}

function Get-OwcServiceHealthStatus {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [string]$Service = $Context.Service
    )

    $containerId = Get-OwcServiceContainerId -Context $Context -Service $Service
    if ([string]::IsNullOrWhiteSpace($containerId)) {
        return $null
    }

    return Get-OwcContainerHealthStatus -Container $containerId
}

function Get-OwcComposeExecFlags {
    if (Test-OwcInteractive) {
        return @()
    }

    return @("-T")
}

function Invoke-OwcBuild {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [switch]$NoCache
    )

    $buildArgs = @("build", "--progress", "plain")
    if ($NoCache) {
        $buildArgs += "--no-cache"
    }

    $buildArgs += @($Context.ToolService, $Context.Service, $Context.WebService)
    Invoke-OwcComposeChecked -Context $Context -Arguments $buildArgs | Out-Null

    $modeLabel = if ($NoCache) { "without cache" } else { "with cache" }
    Write-OwcSuccess "Built services '$($Context.ToolService)', '$($Context.Service)', and '$($Context.WebService)' ($modeLabel)."
}

function Show-OwcEndpoints {
    param([Parameter(Mandatory = $true)]$Context)

    Write-Host ""
    Write-Host "Services:"
    Write-Host "  App health -> $($Context.HealthUrl)"
    Write-Host "  FastAPI    -> $($Context.ApiUrl)"
    Write-Host "  Console    -> $($Context.ConsoleUrl)"
    Write-Host "  MCP tools  -> $($Context.McpUrl)"
}

function Show-OwcComposeStatus {
    param([Parameter(Mandatory = $true)]$Context)

    Write-Host ""
    Write-OwcStep "Current stack status"
    Invoke-OwcComposeChecked -Context $Context -Arguments @("ps") | Out-Null
}

function Wait-OwcHttpReady {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [int]$TimeoutSeconds = 60
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $Context.HealthUrl -UseBasicParsing -TimeoutSec 10
            if ($response.StatusCode -eq 200) {
                return
            }
        }
        catch {
        }

        Start-Sleep -Seconds 2
    }

    throw "Timed out after $TimeoutSeconds seconds waiting for '$($Context.HealthUrl)' to return HTTP 200."
}

function Wait-OwcServiceHealthy {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [string]$Service = $Context.Service,
        [int]$TimeoutSeconds = 240
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastMessage = $null

    while ((Get-Date) -lt $deadline) {
        $containerId = Get-OwcServiceContainerId -Context $Context -Service $Service
        if ([string]::IsNullOrWhiteSpace($containerId)) {
            $message = "Waiting for service '$Service' container to appear..."
        }
        else {
            $state = Get-OwcContainerState -Container $containerId
            $health = Get-OwcContainerHealthStatus -Container $containerId
            $message = "Waiting for '$Service' (state: $state, health: $health)"

            $isHealthy = $state -eq "running" -and ([string]::IsNullOrWhiteSpace($health) -or $health -eq "none" -or $health -eq "healthy")
            if ($isHealthy) {
                Wait-OwcHttpReady -Context $Context -TimeoutSeconds ([Math]::Min(60, $TimeoutSeconds))
                Write-OwcSuccess "Service '$Service' is healthy."
                return
            }
        }

        if ($message -ne $lastMessage) {
            Write-OwcInfo $message
            $lastMessage = $message
        }

        Start-Sleep -Seconds 2
    }

    Write-OwcWarn "Service '$Service' did not become healthy in time. Recent status follows."
    Invoke-OwcComposeCapture -Context $Context -Arguments @("ps") -StreamOutput | Out-Null
    throw "Timed out after $TimeoutSeconds seconds waiting for service '$Service' to become healthy."
}
