#!/usr/bin/env pwsh
[CmdletBinding()]
param(
    [switch]$Build,
    [switch]$NoCache,
    [switch]$Yes,
    [switch]$NoWait,
    [int]$TimeoutSeconds = 240
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "_common.ps1")

$context = Get-OwcContext -CallerPath $MyInvocation.MyCommand.Path
Assert-OwcProjectFiles -Context $context
Assert-DockerAvailable
Ensure-OwcDataDir -Context $context
Ensure-OwcEnvFile -Context $context -Yes:$Yes

Write-OwcHeader "Open Web Catcher - Start"
Write-OwcInfo "Compose file: $($context.ComposeFile)"
Write-OwcInfo "Service: $($context.Service)"
Write-OwcInfo "Tools service: $($context.ToolService)"
Write-OwcInfo "Playwright tools service: $($context.PlaywrightToolService)"
Write-OwcInfo "Web service: $($context.WebService)"
Write-OwcInfo "Container: $($context.Container)"
Write-OwcInfo "Tools container: $($context.ToolContainer)"
Write-OwcInfo "Playwright tools container: $($context.PlaywrightToolContainer)"
Write-OwcInfo "Web container: $($context.WebContainer)"

$needsBuild = $Build -or `
    -not (Test-OwcImageExists -ImageRef $context.ImageRef) -or `
    -not (Test-OwcImageExists -ImageRef $context.ToolImageRef) -or `
    -not (Test-OwcImageExists -ImageRef $context.PlaywrightToolImageRef) -or `
    -not (Test-OwcImageExists -ImageRef $context.WebImageRef)
if ($needsBuild) {
    $useCache = Resolve-OwcBuildUsesCache -NoCache:$NoCache -Yes:$Yes
    Write-OwcStep "Building stack images $(if ($useCache) { 'with cache' } else { 'without cache' })..."
    Invoke-OwcBuild -Context $context -NoCache:(-not $useCache)
}

$startedAt = Get-Date
Write-OwcDivider
Write-OwcStep "Starting stack..."
Invoke-OwcComposeChecked -Context $context -Arguments (@("up", "-d", "--remove-orphans") + $context.StartServices) | Out-Null

if (-not $NoWait) {
    Write-OwcStep "Waiting for application health..."
    Wait-OwcServiceHealthy -Context $context -TimeoutSeconds $TimeoutSeconds
}
else {
    Write-OwcWarn "Skipping health wait because -NoWait was supplied."
}

$duration = Format-OwcDuration -Duration ((Get-Date) - $startedAt)
Write-OwcDivider
Write-OwcSuccess "Stack is up after $duration."
Show-OwcEndpoints -Context $context

Write-Host ""
Write-Host "  Next.js Operator Console  ->  $($context.ConsoleUrl)" -ForegroundColor Magenta
Write-Host "    /              Dashboard        KPIs, cost trends, provider analytics" -ForegroundColor DarkGray
Write-Host "    /live          Live studio      SSE workflow graph + event stream"     -ForegroundColor DarkGray
Write-Host "    /agents        Agent lab        Run a single agent and inspect trace"  -ForegroundColor DarkGray
Write-Host "    /tools         Tool playground  Call MCP tools directly"               -ForegroundColor DarkGray
Write-Host "    /runs          Run explorer     Drill-downs and history"               -ForegroundColor DarkGray
Write-Host "    /providers     Provider intel   m3u8 / IP / whois lookup"             -ForegroundColor DarkGray
Write-Host "    /evaluations   Eval lab         Synthetic, mocked and live suites"    -ForegroundColor DarkGray
Write-Host "    /settings      Pricing config   Model cost configuration"             -ForegroundColor DarkGray
Write-Host ""

Show-OwcComposeStatus -Context $context
