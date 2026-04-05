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
Assert-DockerAvailable

Write-OwcSection "Build"
Write-OwcInfo "Image: $($context.ImageRef)"

$useCache = Resolve-OwcBuildUsesCache -NoCache:$NoCache -Yes:$Yes
Write-OwcInfo "Mode: $(if ($useCache) { 'with cache' } else { 'without cache' })"

Invoke-OwcBuild -Context $context -NoCache:(-not $useCache)
