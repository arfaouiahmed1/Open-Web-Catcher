#!/usr/bin/env pwsh
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$container = if ($env:OWC_CONTAINER) { $env:OWC_CONTAINER } else { "owc" }

$existingContainerId = (& docker ps -aq -f "name=^$container$").Trim()
if ($existingContainerId) {
    Write-Host "Restarting '$container'..."
    & docker restart $container | Out-Null
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
    Write-Host "Restarted."
}
else {
    Write-Host "Container '$container' not found - run scripts/docker/start.ps1 first."
    exit 1
}