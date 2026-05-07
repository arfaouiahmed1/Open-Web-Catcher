#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [switch]$Yes,
    [int]$TimeoutSeconds = 240
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "_common.ps1")

# Restart reuses ports already held by the running stack's docker proxies; strict
# mode would mistake those for foreign holders. Use auto.
$global:OwcStrictPorts = $false
Reset-OwcReservedPorts

$context = Get-OwcContext -CallerPath $MyInvocation.MyCommand.Path
Assert-OwcProjectFiles -Context $context
Assert-DockerAvailable
Ensure-OwcDataDir -Context $context
Ensure-OwcEnvFile -Context $context -Yes:$Yes

Write-OwcHeader "Open Web Catcher - Restart"
Write-OwcInfo "Compose file: $($context.ComposeFile)"
Write-OwcInfo "Service: $($context.Service)"

$startedAt = Get-Date
if (Test-OwcServicePresent -Context $context) {
    $serviceState = Get-OwcServiceState -Context $context
    if ($serviceState -eq "running") {
        if (-not (Confirm-OwcAction -Prompt "Restart the compose stack now?" -DefaultYes -Yes:$Yes)) {
            Write-OwcInfo "Restart cancelled."
            return
        }

        Write-OwcStep "Restarting stack..."
        Invoke-OwcComposeChecked -Context $context -Arguments (@("restart") + $context.StartServices) | Out-Null
    }
    else {
        Write-OwcWarn "Stack exists but is not running (state: $serviceState). Starting it instead."
        Invoke-OwcComposeChecked -Context $context -Arguments (@("start") + $context.StartServices) | Out-Null
    }
}
else {
    Write-OwcWarn "Stack is not running. Starting it instead."
    Invoke-OwcComposeChecked -Context $context -Arguments (@("up", "-d", "--remove-orphans") + $context.StartServices) | Out-Null
}

Write-OwcStep "Waiting for application health..."
Wait-OwcServiceHealthy -Context $context -TimeoutSeconds $TimeoutSeconds

$duration = Format-OwcDuration -Duration ((Get-Date) - $startedAt)
Write-OwcDivider
Write-OwcSuccess "Stack ready after $duration."
Show-OwcEndpoints -Context $context
Show-OwcComposeStatus -Context $context
