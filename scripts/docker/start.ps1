#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [switch]$Build,
    [switch]$NoCache,
    [switch]$Yes,
    [switch]$NoWait,
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

Write-OwcHeader "Open Web Catcher - Start"
Write-OwcInfo "Compose file: $($context.ComposeFile)"
Write-OwcInfo "Service: $($context.Service)"
Write-OwcInfo "Container: $($context.Container)"

$needsBuild = $Build -or -not (Test-OwcImageExists -ImageRef $context.ImageRef)
if ($needsBuild) {
    $useCache = Resolve-OwcBuildUsesCache -NoCache:$NoCache -Yes:$Yes
    Write-OwcStep "Building application image $(if ($useCache) { 'with cache' } else { 'without cache' })..."
    Invoke-OwcBuild -Context $context -NoCache:(-not $useCache)
}

$startedAt = Get-Date
Write-OwcDivider
Write-OwcStep "Starting stack..."
Invoke-OwcComposeChecked -Context $context -Arguments @("up", "-d", "--remove-orphans") | Out-Null

if (-not $NoWait) {
    Write-OwcStep "Waiting for application health..."
    Wait-OwcServiceHealthy -Context $context -TimeoutSeconds $TimeoutSeconds
}
else {
    Write-OwcWarn "Skipping health wait because -NoWait was supplied."
}

$duration = Format-OwcDuration -Duration ((Get-Date) - $startedAt)
Write-OwcDivider
Write-OwcSuccess "Stack is up after $duration."
Show-OwcEndpoints -Context $context
Show-OwcComposeStatus -Context $context
