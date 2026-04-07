#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [switch]$NoCache,
    [switch]$Yes
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "_common.ps1")

$context = Get-OwcContext -CallerPath $MyInvocation.MyCommand.Path
Assert-OwcProjectFiles -Context $context
Assert-DockerAvailable
Ensure-OwcDataDir -Context $context

Write-OwcHeader "Open Web Catcher - Build"
Write-OwcInfo "Compose file: $($context.ComposeFile)"
Write-OwcInfo "Service: $($context.Service)"
Write-OwcInfo "Image: $($context.ImageRef)"
Write-OwcInfo "Tools image: $($context.ToolImageRef)"

$useCache = Resolve-OwcBuildUsesCache -NoCache:$NoCache -Yes:$Yes
Write-OwcInfo "Mode: $(if ($useCache) { 'with cache' } else { 'without cache' })"
Write-OwcDivider

$startedAt = Get-Date
Invoke-OwcBuild -Context $context -NoCache:(-not $useCache)

$duration = Format-OwcDuration -Duration ((Get-Date) - $startedAt)
Write-OwcDivider
Write-OwcSuccess "Build finished in $duration."
