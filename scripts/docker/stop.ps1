#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [switch]$Yes
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "_common.ps1")

$context = Get-OwcContext -CallerPath $MyInvocation.MyCommand.Path
Assert-DockerAvailable

Write-OwcSection "Stop"
Write-OwcInfo "Container: $($context.Container)"

if (-not (Test-OwcContainerExists -Container $context.Container)) {
    Write-OwcInfo "Container '$($context.Container)' does not exist."
    return
}

if (-not (Test-OwcContainerRunning -Container $context.Container)) {
    Write-OwcInfo "Container '$($context.Container)' is already stopped."
    return
}

if (-not (Confirm-OwcAction -Prompt "Stop container '$($context.Container)' now?" -DefaultYes -Yes:$Yes)) {
    Write-OwcInfo "Stop cancelled."
    return
}

Invoke-DockerChecked -Arguments @("stop", $context.Container)
Write-OwcSuccess "Container '$($context.Container)' stopped."
