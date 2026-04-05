#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [switch]$Yes,
    [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "_common.ps1")

$context = Get-OwcContext -CallerPath $MyInvocation.MyCommand.Path
Assert-DockerAvailable

Write-OwcSection "Restart"
Write-OwcInfo "Container: $($context.Container)"

if (-not (Test-OwcContainerExists -Container $context.Container)) {
    Write-OwcWarn "Container '$($context.Container)' does not exist."
    if (-not (Confirm-OwcAction -Prompt "Start it now instead?" -DefaultYes -Yes:$Yes)) {
        Write-OwcInfo "Restart cancelled."
        return
    }

    & (Join-Path $context.ScriptDir "start.ps1") -Yes -TimeoutSeconds $TimeoutSeconds
    return
}

if (Test-OwcContainerRunning -Container $context.Container) {
    if (-not (Confirm-OwcAction -Prompt "Restart container '$($context.Container)' now?" -DefaultYes -Yes:$Yes)) {
        Write-OwcInfo "Restart cancelled."
        return
    }

    Invoke-DockerChecked -Arguments @("restart", $context.Container)
    Wait-OwcContainerHealthy -Container $context.Container -TimeoutSeconds $TimeoutSeconds
    Write-OwcSuccess "Container '$($context.Container)' restarted."
    Show-OwcEndpoints -Context $context
    return
}

if (-not (Confirm-OwcAction -Prompt "Container '$($context.Container)' is stopped. Start it now?" -DefaultYes -Yes:$Yes)) {
    Write-OwcInfo "Restart cancelled."
    return
}

Invoke-DockerChecked -Arguments @("start", $context.Container)
Wait-OwcContainerHealthy -Container $context.Container -TimeoutSeconds $TimeoutSeconds
Write-OwcSuccess "Container '$($context.Container)' started."
Show-OwcEndpoints -Context $context
