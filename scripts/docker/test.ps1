#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [switch]$Yes,
    [int]$TimeoutSeconds = 240,
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$PytestArgs
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "_common.ps1")

function Add-PytestDefaultArg {
    param(
        [Parameter(Mandatory = $true)]
        [System.Collections.Generic.List[string]]$ArgsList,
        [Parameter(Mandatory = $true)]
        [string[]]$MatchValues,
        [Parameter(Mandatory = $true)]
        [string[]]$ValueToAdd
    )

    foreach ($existing in $ArgsList) {
        foreach ($match in $MatchValues) {
            if ($existing -eq $match -or $existing.StartsWith("$match=")) {
                return
            }
        }
    }

    foreach ($value in $ValueToAdd) {
        [void]$ArgsList.Add($value)
    }
}

$context = Get-OwcContext -CallerPath $MyInvocation.MyCommand.Path
Assert-OwcProjectFiles -Context $context
Assert-DockerAvailable
Ensure-OwcDataDir -Context $context
Ensure-OwcEnvFile -Context $context -Yes:$Yes

Write-OwcHeader "Open Web Catcher - Test"
Write-OwcInfo "Compose file: $($context.ComposeFile)"
Write-OwcInfo "Service: $($context.Service)"

if (-not $PytestArgs -or $PytestArgs.Count -eq 0) {
    $PytestArgs = @("tests/")
}

if (-not (Test-OwcServicePresent -Context $context) -or (Get-OwcServiceState -Context $context) -ne "running") {
    Write-OwcWarn "Stack is not running. Starting it before tests."
    & (Join-Path $context.ScriptDir "start.ps1") -Yes -TimeoutSeconds $TimeoutSeconds
}
else {
    Wait-OwcServiceHealthy -Context $context -TimeoutSeconds $TimeoutSeconds
}

$pytestList = [System.Collections.Generic.List[string]]::new()
foreach ($arg in $PytestArgs) {
    [void]$pytestList.Add($arg)
}

Add-PytestDefaultArg -ArgsList $pytestList -MatchValues @("--tb") -ValueToAdd @("--tb=short")
Add-PytestDefaultArg -ArgsList $pytestList -MatchValues @("-v", "--verbose") -ValueToAdd @("-v")
Add-PytestDefaultArg -ArgsList $pytestList -MatchValues @("--asyncio-mode") -ValueToAdd @("--asyncio-mode=auto")

$pytestPreview = $pytestList -join " "
if (-not (Confirm-OwcAction -Prompt "Run pytest in service '$($context.Service)' with: $pytestPreview ?" -DefaultYes -Yes:$Yes)) {
    Write-OwcInfo "Test run cancelled."
    return
}

$startedAt = Get-Date
$execArgs = @("exec") + (Get-OwcComposeExecFlags) + @($context.Service, "/app/.venv/bin/python", "-m", "pytest") + $pytestList
$result = Invoke-OwcComposeCapture -Context $context -Arguments $execArgs -StreamOutput
if ($result.ExitCode -ne 0) {
    throw "pytest failed with exit code $($result.ExitCode)."
}

$duration = Format-OwcDuration -Duration ((Get-Date) - $startedAt)
Write-OwcDivider
Write-OwcSuccess "Tests finished successfully in $duration."
