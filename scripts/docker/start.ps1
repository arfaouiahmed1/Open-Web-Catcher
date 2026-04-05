#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [switch]$Yes,
    [switch]$NoWait,
    [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "_common.ps1")

$context = Get-OwcContext -CallerPath $MyInvocation.MyCommand.Path
Assert-DockerAvailable

Write-OwcSection "Start"
Write-OwcInfo "Container: $($context.Container)"
Write-OwcInfo "Image: $($context.ImageRef)"

if (-not (Test-Path $context.ConfigsDir)) {
    throw "Required directory '$($context.ConfigsDir)' was not found."
}

if (-not (Confirm-OwcAction -Prompt "Start container '$($context.Container)' from $($context.ImageRef)?" -DefaultYes -Yes:$Yes)) {
    Write-OwcInfo "Start cancelled."
    return
}

if (-not (Test-Path $context.DataDir)) {
    New-Item -ItemType Directory -Path $context.DataDir -Force | Out-Null
    Write-OwcInfo "Created data directory at '$($context.DataDir)'."
}

if (-not (Test-Path $context.EnvFile)) {
    if (Test-Path $context.ExampleEnvFile) {
        Write-OwcWarn "No .env file was found. The container will start with current shell environment defaults only."
        Write-OwcInfo "Tip: copy '$($context.ExampleEnvFile)' to '$($context.EnvFile)' when you want a persistent setup."
    }

    if (-not (Confirm-OwcAction -Prompt "Continue without a local .env file?" -DefaultYes -Yes:$Yes)) {
        Write-OwcInfo "Start cancelled."
        return
    }
}

if (-not (Test-OwcImageExists -ImageRef $context.ImageRef)) {
    Write-OwcWarn "Image '$($context.ImageRef)' was not found locally."
    if (-not (Confirm-OwcAction -Prompt "Build it now?" -DefaultYes -Yes:$Yes)) {
        Write-OwcInfo "Start cancelled."
        return
    }

    $useCache = Resolve-OwcBuildUsesCache -Yes:$Yes
    Write-OwcInfo "Building missing image $(if ($useCache) { 'with cache' } else { 'without cache' })..."
    Invoke-OwcBuild -Context $context -NoCache:(-not $useCache)
}

if (Test-OwcContainerExists -Container $context.Container) {
    if (Test-OwcContainerRunning -Container $context.Container) {
        Write-OwcWarn "Container '$($context.Container)' is already running."
        if (-not (Confirm-OwcAction -Prompt "Recreate it?" -DefaultYes:$false -Yes:$Yes)) {
            Write-OwcInfo "Keeping the existing running container."
            Show-OwcEndpoints -Context $context
            return
        }

        Write-OwcInfo "Stopping existing container '$($context.Container)'..."
        Invoke-DockerChecked -Arguments @("stop", $context.Container)
    }
    else {
        if (-not (Confirm-OwcAction -Prompt "Container '$($context.Container)' already exists but is stopped. Recreate it?" -DefaultYes -Yes:$Yes)) {
            Write-OwcInfo "Start cancelled."
            return
        }
    }

    Write-OwcInfo "Removing existing container '$($context.Container)'..."
    Invoke-DockerChecked -Arguments @("rm", $context.Container)
}

$runArgs = @("run", "-d", "--name", $context.Container)
if (Test-Path $context.EnvFile) {
    $runArgs += @("--env-file", $context.EnvFile)
}

$runArgs += @(
    "-p", "8000:8000",
    "-p", "7860:7860",
    "-v", "$($context.DataDir):/app/data",
    "-v", "$($context.ConfigsDir):/app/configs:ro",
    "--shm-size=2g",
    "--restart", "unless-stopped",
    $context.ImageRef
)

Write-OwcInfo "Launching container '$($context.Container)'..."
$runResult = Invoke-DockerCapture -Arguments $runArgs
if ($runResult.ExitCode -ne 0) {
    throw "Docker run failed.`n$($runResult.Text)"
}

if ($runResult.Text) {
    Write-OwcInfo "Container ID: $($runResult.Text)"
}

if (-not $NoWait) {
    Wait-OwcContainerHealthy -Container $context.Container -TimeoutSeconds $TimeoutSeconds
}
else {
    Write-OwcInfo "Skipping health wait because -NoWait was supplied."
}

Write-OwcSuccess "Container '$($context.Container)' is up."
Show-OwcEndpoints -Context $context
