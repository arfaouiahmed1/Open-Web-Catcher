#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [switch]$Yes
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "_common.ps1")

$context = Get-OwcContext -CallerPath $MyInvocation.MyCommand.Path
Assert-OwcProjectFiles -Context $context
Assert-DockerAvailable

Write-OwcHeader "Open Web Catcher - Stop"
Write-OwcInfo "Compose file: $($context.ComposeFile)"

if (-not (Test-OwcServicePresent -Context $context)) {
    Write-OwcInfo "The stack is not running."
    return
}

$serviceState = Get-OwcServiceState -Context $context
if ($serviceState -ne "running") {
    Write-OwcInfo "The stack already exists but is not running (state: $serviceState)."
    return
}

if (-not (Confirm-OwcAction -Prompt "Stop the compose stack now?" -DefaultYes -Yes:$Yes)) {
    Write-OwcInfo "Stop cancelled."
    return
}

$startedAt = Get-Date
Write-OwcStep "Stopping stack..."
Invoke-OwcComposeChecked -Context $context -Arguments @("stop") | Out-Null

$duration = Format-OwcDuration -Duration ((Get-Date) - $startedAt)
Write-OwcDivider
Write-OwcSuccess "Stack stopped in $duration."
