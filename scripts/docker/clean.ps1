#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [switch]$Volumes,
    [switch]$RemoveImage,
    [switch]$PruneBuildCache,
    [switch]$Yes,
    [switch]$NoPrompt
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "_common.ps1")

$context = Get-OwcContext -CallerPath $MyInvocation.MyCommand.Path
Assert-OwcProjectFiles -Context $context
Assert-DockerAvailable

Write-OwcHeader "Open Web Catcher - Clean"
Write-OwcInfo "Compose file: $($context.ComposeFile)"
Write-OwcInfo "Image: $($context.ImageRef)"

if (-not (Confirm-OwcAction -Prompt "Remove the compose stack resources now?" -DefaultYes:$false -Yes:$Yes -NoPrompt:$NoPrompt)) {
    Write-OwcInfo "Clean cancelled."
    return
}

$startedAt = Get-Date

$downArgs = @("down", "--remove-orphans")
if ($Volumes) {
    $downArgs += "--volumes"
}
if ($RemoveImage) {
    $downArgs += @("--rmi", "local")
}

Write-OwcStep "Removing compose resources..."
Invoke-OwcComposeChecked -Context $context -Arguments $downArgs | Out-Null

if ($PruneBuildCache) {
    Write-OwcStep "Pruning Docker builder cache..."
    Invoke-DockerChecked -Arguments @("builder", "prune", "-f") | Out-Null
}

$duration = Format-OwcDuration -Duration ((Get-Date) - $startedAt)
Write-OwcDivider
Write-OwcSuccess "Cleanup finished in $duration."
