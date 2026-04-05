#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$PytestArgs
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$container = if ($env:OWC_CONTAINER) { $env:OWC_CONTAINER } else { "owc" }

$runningContainerId = (& docker ps -q -f "name=^$container$").Trim()
if (-not $runningContainerId) {
    Write-Host "Container '$container' is not running. Start it first with scripts/docker/start.ps1"
    exit 1
}

if (-not $PytestArgs -or $PytestArgs.Count -eq 0) {
    $PytestArgs = @("tests/")
}

$isInteractive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected
$execFlags = if ($isInteractive) { @("-it") } else { @("-i") }

$pytestPreview = $PytestArgs -join " "
Write-Host "Running tests in '$container': pytest $pytestPreview"

$execArgs = @("exec") + $execFlags + @($container, "/app/.venv/bin/pytest") + $PytestArgs + @("--tb=short", "-v", "--asyncio-mode=auto")
& docker @execArgs
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}