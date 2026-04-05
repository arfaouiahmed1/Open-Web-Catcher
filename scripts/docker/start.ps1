#!/usr/bin/env pwsh
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = (Resolve-Path (Join-Path $scriptDir "..\..")).Path

$container = if ($env:OWC_CONTAINER) { $env:OWC_CONTAINER } else { "owc" }
$image = if ($env:OWC_IMAGE) { $env:OWC_IMAGE } else { "open-web-catcher" }
$tag = if ($env:OWC_TAG) { $env:OWC_TAG } else { "latest" }
$imageRef = "$image`:$tag"

$envFile = Join-Path $rootDir ".env"
$dataDir = Join-Path $rootDir "data"
$configsDir = Join-Path $rootDir "configs"

$runningContainerId = (& docker ps -q -f "name=^$container$").Trim()
if ($runningContainerId) {
    Write-Host "Stopping existing container '$container'..."
    & docker stop $container | Out-Null
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

$existingContainerId = (& docker ps -aq -f "name=^$container$").Trim()
if ($existingContainerId) {
    & docker rm $container | Out-Null
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

$runArgs = @("run", "-d", "--name", $container)
if (Test-Path $envFile) {
    $runArgs += @("--env-file", $envFile)
}

$runArgs += @(
    "-p", "8000:8000",
    "-p", "7860:7860",
    "-v", "$dataDir:/app/data",
    "-v", "$configsDir:/app/configs:ro",
    "--shm-size=2g",
    "--restart", "unless-stopped",
    $imageRef
)

Write-Host "Starting container '$container' from $imageRef..."
& docker @runArgs
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host "Container '$container' started."
Write-Host "  FastAPI  -> http://localhost:8000"
Write-Host "  Gradio   -> http://localhost:7860"
Write-Host "  API docs -> http://localhost:8000/docs"