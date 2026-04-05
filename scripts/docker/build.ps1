#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [switch]$NoCache
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = (Resolve-Path (Join-Path $scriptDir "..\..")).Path

$image = if ($env:OWC_IMAGE) { $env:OWC_IMAGE } else { "open-web-catcher" }
$tag = if ($env:OWC_TAG) { $env:OWC_TAG } else { "latest" }
$imageRef = "$image`:$tag"

$mode = if ($NoCache) { "no cache" } else { "with cache" }
Write-Host "Building $imageRef ($mode)..."

$buildArgs = @("build")
if ($NoCache) {
    $buildArgs += "--no-cache"
}
$buildArgs += @("-t", $imageRef, $rootDir)

& docker @buildArgs
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host "Done: $imageRef"