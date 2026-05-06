#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [switch]$NoCache,
    [switch]$Yes,
    [int]$TimeoutSeconds = 240
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "_common.ps1")

# Rebuild needs to tear the stack down first, but the final web endpoint must
# stay pinned to localhost:3000. Use relaxed port checks for teardown, then wait
# for the canonical web port to reopen before starting the stack again.
$global:OwcStrictPorts = $false
Reset-OwcReservedPorts
$env:OWC_WEB_HOST_PORT = "3000"

function Wait-OwcTcpPortFree {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [int]$TimeoutSeconds = 30
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-OwcTcpPortAvailable -Port $Port) {
            return
        }

        Start-Sleep -Seconds 1
    }

    $holder = Format-OwcPortHolder -Port $Port
    throw "Timed out after $TimeoutSeconds seconds waiting for port $Port to become free ($holder). Rebuild requires http://localhost:3000/ to stay available."
}

$context = Get-OwcContext -CallerPath $MyInvocation.MyCommand.Path
Assert-OwcProjectFiles -Context $context
Assert-DockerAvailable
Ensure-OwcDataDir -Context $context
Ensure-OwcEnvFile -Context $context -Yes:$Yes

Write-OwcHeader "Open Web Catcher - Rebuild"
Write-OwcInfo "Compose file: $($context.ComposeFile)"
Write-OwcInfo "Service: $($context.Service)"
Write-OwcInfo "Image: $($context.ImageRef)"

$useCache = Resolve-OwcBuildUsesCache -NoCache:$NoCache -Yes:$Yes
Write-OwcInfo "Mode: $(if ($useCache) { 'with cache' } else { 'without cache' })"
Write-OwcDivider

$startedAt = Get-Date

Write-OwcStep "Stopping existing stack..."
Invoke-OwcComposeChecked -Context $context -Arguments @("down", "--remove-orphans") | Out-Null

Write-OwcStep "Waiting for localhost:3000 to be released..."
Wait-OwcTcpPortFree -Port 3000 -TimeoutSeconds ([Math]::Min(60, $TimeoutSeconds))

Reset-OwcReservedPorts
$context = Get-OwcContext -CallerPath $MyInvocation.MyCommand.Path
if ($context.WebHostPort -ne 3000) {
    throw "Rebuild could not bind the web interface to http://localhost:3000/. Free port 3000 and retry."
}

$env:OWC_TOOLS_HOST_PORT = "$($context.ToolsHostPort)"
$env:OWC_WEB_HOST_PORT = "$($context.WebHostPort)"
$env:OWC_TOOLS_PW_HOST_PORT = "$($context.PlaywrightToolsHostPort)"
$env:OWC_TOOLS_DEBUG_HOST_PORT = "$($context.ToolsDebugHostPort)"
$env:OWC_TOOLS_PW_DEBUG_HOST_PORT = "$($context.PlaywrightToolsDebugHostPort)"
$env:UI_CORS_ORIGINS = "http://localhost:$($context.WebHostPort),http://127.0.0.1:$($context.WebHostPort)"

Write-OwcStep "Building stack images..."
Invoke-OwcBuild -Context $context -NoCache:(-not $useCache)

Write-OwcStep "Starting stack..."
Invoke-OwcComposeChecked -Context $context -Arguments (@("up", "-d", "--remove-orphans") + $context.StartServices) | Out-Null

Write-OwcStep "Pruning dangling images..."
Invoke-DockerChecked -Arguments @("image", "prune", "-f") | Out-Null

if (-not $useCache) {
    Write-OwcStep "Pruning build cache after no-cache build..."
    Invoke-DockerChecked -Arguments @("builder", "prune", "-f") | Out-Null
}

Write-OwcStep "Waiting for application health..."
Wait-OwcServiceHealthy -Context $context -TimeoutSeconds $TimeoutSeconds

$duration = Format-OwcDuration -Duration ((Get-Date) - $startedAt)
Write-OwcDivider
Write-OwcSuccess "Rebuild completed in $duration."
Show-OwcEndpoints -Context $context
Show-OwcComposeStatus -Context $context
