#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [switch]$RemoveImage,
    [switch]$PruneBuildCache,
    [switch]$NoPrompt
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$container = if ($env:OWC_CONTAINER) { $env:OWC_CONTAINER } else { "owc" }
$image = if ($env:OWC_IMAGE) { $env:OWC_IMAGE } else { "open-web-catcher" }
$tag = if ($env:OWC_TAG) { $env:OWC_TAG } else { "latest" }
$imageRef = "$image`:$tag"

$runningContainerId = (& docker ps -q -f "name=^$container$").Trim()
if ($runningContainerId) {
    Write-Host "Stopping '$container'..."
    & docker stop $container | Out-Null
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

$existingContainerId = (& docker ps -aq -f "name=^$container$").Trim()
if ($existingContainerId) {
    Write-Host "Removing container '$container'..."
    & docker rm -v $container | Out-Null
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

$shouldRemoveImage = $RemoveImage
if (-not $RemoveImage -and -not $NoPrompt) {
    $answer = Read-Host "Remove image $imageRef as well? [y/N]"
    $shouldRemoveImage = $answer -match '^[Yy]$'
}

if ($shouldRemoveImage) {
    & docker rmi $imageRef | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Image removed."
    }
    else {
        Write-Host "Image not found or could not be removed."
    }
}

$shouldPruneCache = $PruneBuildCache
if (-not $PruneBuildCache -and -not $NoPrompt) {
    $answer2 = Read-Host "Prune Docker build cache? [y/N]"
    $shouldPruneCache = $answer2 -match '^[Yy]$'
}

if ($shouldPruneCache) {
    & docker builder prune -f
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

Write-Host "Clean complete."