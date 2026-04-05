#!/usr/bin/env pwsh
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$container = if ($env:OWC_CONTAINER) { $env:OWC_CONTAINER } else { "owc" }

$runningContainerId = (& docker ps -q -f "name=^$container$").Trim()
if ($runningContainerId) {
    Write-Host "Stopping '$container'..."
    & docker stop $container | Out-Null
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
    Write-Host "Stopped."
}
else {
    Write-Host "Container '$container' is not running."
}