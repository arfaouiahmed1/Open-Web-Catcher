#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [switch]$RemoveImage,
    [switch]$PruneBuildCache,
    [switch]$Yes,
    [switch]$NoPrompt
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "_common.ps1")

$context = Get-OwcContext -CallerPath $MyInvocation.MyCommand.Path
Assert-DockerAvailable

Write-OwcSection "Clean"
Write-OwcInfo "Container: $($context.Container)"
Write-OwcInfo "Image: $($context.ImageRef)"

$containerExists = Test-OwcContainerExists -Container $context.Container
$imageExists = Test-OwcImageExists -ImageRef $context.ImageRef

if (-not $containerExists -and -not $imageExists -and -not $PruneBuildCache) {
    Write-OwcInfo "Nothing to clean. No matching container or image was found."
    return
}

if (-not (Confirm-OwcAction -Prompt "Clean Docker artifacts for '$($context.Container)'?" -DefaultYes:$false -Yes:$Yes -NoPrompt:$NoPrompt)) {
    Write-OwcInfo "Clean cancelled."
    return
}

if ($containerExists) {
    if (Test-OwcContainerRunning -Container $context.Container) {
        Write-OwcInfo "Stopping container '$($context.Container)'..."
        Invoke-DockerChecked -Arguments @("stop", $context.Container)
    }

    Write-OwcInfo "Removing container '$($context.Container)'..."
    Invoke-DockerChecked -Arguments @("rm", "-v", $context.Container)
    Write-OwcSuccess "Removed container '$($context.Container)'."
}
else {
    Write-OwcInfo "Container '$($context.Container)' was not present."
}

$shouldRemoveImage = $RemoveImage
if (-not $RemoveImage) {
    $shouldRemoveImage = Confirm-OwcAction -Prompt "Remove image $($context.ImageRef) as well?" -DefaultYes:$false -Yes:$Yes -NoPrompt:$NoPrompt
}

if ($shouldRemoveImage) {
    if (Test-OwcImageExists -ImageRef $context.ImageRef) {
        Write-OwcInfo "Removing image '$($context.ImageRef)'..."
        Invoke-DockerChecked -Arguments @("rmi", $context.ImageRef)
        Write-OwcSuccess "Removed image '$($context.ImageRef)'."
    }
    else {
        Write-OwcInfo "Image '$($context.ImageRef)' was not present."
    }
}

$shouldPruneCache = $PruneBuildCache
if (-not $PruneBuildCache) {
    $shouldPruneCache = Confirm-OwcAction -Prompt "Prune Docker build cache too?" -DefaultYes:$false -Yes:$Yes -NoPrompt:$NoPrompt
}

if ($shouldPruneCache) {
    Write-OwcInfo "Pruning Docker build cache..."
    Invoke-DockerChecked -Arguments @("builder", "prune", "-f")
    Write-OwcSuccess "Docker build cache pruned."
}

Write-OwcSuccess "Clean complete."
