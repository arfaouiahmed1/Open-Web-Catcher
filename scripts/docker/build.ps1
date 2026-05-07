#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Build the Open Web Catcher Docker images.

.DESCRIPTION
    Validates the working tree, Dockerfiles, and Docker daemon before invoking
    `docker compose build`. By default uses the layer cache; pass -NoCache to
    force a clean rebuild, or -Yes to suppress the cache prompt in interactive
    sessions.
#>
[CmdletBinding()]
param(
    [switch]$NoCache,
    [switch]$Yes,
    [string[]]$Service
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "_common.ps1")

# Build is a planning step; do not strict-check ports here.
$global:OwcStrictPorts = $false
Reset-OwcReservedPorts

$context = Get-OwcContext -CallerPath $MyInvocation.MyCommand.Path
Assert-OwcProjectFiles -Context $context
Assert-DockerAvailable
Ensure-OwcDataDir -Context $context

# Verify Dockerfiles exist before delegating to compose so failures are obvious.
$expectedDockerfiles = @(
    @{ Service = $context.Service;                 Path = $context.Dockerfile }
    @{ Service = $context.ToolService;             Path = (Join-Path $context.RootDir "Dockerfile.tools") }
    @{ Service = $context.PlaywrightToolService;   Path = (Join-Path $context.RootDir "Dockerfile.tools.playwright") }
    @{ Service = $context.WebService;              Path = (Join-Path $context.RootDir "Dockerfile.web") }
)
foreach ($entry in $expectedDockerfiles) {
    if (-not (Test-Path $entry.Path)) {
        throw "Missing Dockerfile for service '$($entry.Service)' at '$($entry.Path)'."
    }
}

$selectedServices = if ($Service -and $Service.Count -gt 0) { $Service } else { $context.BuildServices }
$invalid = $selectedServices | Where-Object { $context.BuildServices -notcontains $_ }
if ($invalid) {
    throw "Unknown service name(s): $($invalid -join ', '). Valid services: $($context.BuildServices -join ', ')."
}

Write-OwcHeader "Open Web Catcher - Build"
Write-OwcInfo "Compose file: $($context.ComposeFile)"
Write-OwcInfo "Services: $($selectedServices -join ', ')"
Write-OwcInfo "Image: $($context.ImageRef)"
Write-OwcInfo "Tools image: $($context.ToolImageRef)"
Write-OwcInfo "Playwright tools image: $($context.PlaywrightToolImageRef)"
Write-OwcInfo "Web image: $($context.WebImageRef)"

$useCache = Resolve-OwcBuildUsesCache -NoCache:$NoCache -Yes:$Yes -NoPrompt
Write-OwcInfo "Mode: $(if ($useCache) { 'with cache' } else { 'without cache (clean)' })"
Write-OwcDivider

$startedAt = Get-Date
$buildArgs = @("--progress", "plain", "build")
if (-not $useCache) { $buildArgs += "--no-cache" }
$buildArgs += $selectedServices

try {
    Invoke-OwcComposeChecked -Context $context -Arguments $buildArgs | Out-Null
}
catch {
    Write-OwcFail "Build failed for: $($selectedServices -join ', ')"
    throw
}

$duration = Format-OwcDuration -Duration ((Get-Date) - $startedAt)
Write-OwcDivider
Write-OwcSuccess "Build finished in $duration ($(($selectedServices) -join ', '))."
