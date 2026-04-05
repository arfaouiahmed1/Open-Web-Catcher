#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [switch]$Yes,
    [int]$TimeoutSeconds = 180,
    [Parameter(ValueFromRemainingArguments = $true)]
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
Assert-DockerAvailable

Write-OwcSection "Test"
Write-OwcInfo "Container: $($context.Container)"

if (-not $PytestArgs -or $PytestArgs.Count -eq 0) {
    $PytestArgs = @("tests/")
}

if (-not (Test-OwcContainerExists -Container $context.Container) -or -not (Test-OwcContainerRunning -Container $context.Container)) {
    Write-OwcWarn "Container '$($context.Container)' is not running."
    if (-not (Confirm-OwcAction -Prompt "Start it now before running tests?" -DefaultYes -Yes:$Yes)) {
        Write-OwcInfo "Test run cancelled."
        return
    }

    & (Join-Path $context.ScriptDir "start.ps1") -Yes -TimeoutSeconds $TimeoutSeconds
}
else {
    Wait-OwcContainerHealthy -Container $context.Container -TimeoutSeconds $TimeoutSeconds
}

$pytestList = [System.Collections.Generic.List[string]]::new()
foreach ($arg in $PytestArgs) {
    [void]$pytestList.Add($arg)
}

Add-PytestDefaultArg -ArgsList $pytestList -MatchValues @("--tb") -ValueToAdd @("--tb=short")
Add-PytestDefaultArg -ArgsList $pytestList -MatchValues @("-v", "--verbose") -ValueToAdd @("-v")
Add-PytestDefaultArg -ArgsList $pytestList -MatchValues @("--asyncio-mode") -ValueToAdd @("--asyncio-mode=auto")

$pytestPreview = $pytestList -join " "
if (-not (Confirm-OwcAction -Prompt "Run pytest in '$($context.Container)' with: $pytestPreview ?" -DefaultYes -Yes:$Yes)) {
    Write-OwcInfo "Test run cancelled."
    return
}

$execArgs = @("exec") + (Get-OwcDockerExecFlags) + @($context.Container, "/app/.venv/bin/python", "-m", "pytest") + $pytestList
& docker @execArgs
if ($LASTEXITCODE -ne 0) {
    throw "pytest failed with exit code $LASTEXITCODE."
}

Write-OwcSuccess "Tests finished successfully."
