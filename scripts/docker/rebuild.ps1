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
Invoke-OwcComposeChecked -Context $context -Arguments (@("rm", "-f", "-s") + $context.StartServices) | Out-Null

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
