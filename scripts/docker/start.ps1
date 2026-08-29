#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Start the Open Web Catcher Docker stack with fixed host ports.

.DESCRIPTION
    Default behaviour pins host ports to their canonical values (3000 web,
    3001 tools, 3002 playwright tools, 8000 api, 9222/9223 chrome debuggers).
    If any of those ports is already in use the script fails fast and reports
    the holding process so it can be freed deliberately.

    Use -AutoPort to fall back to the next free port (legacy behaviour).
    Use -CleanStale to remove stopped containers that share OWC names before
    bringing the stack up.
#>
[CmdletBinding()]
param(
    [switch]$Build,
    [switch]$NoCache,
    [switch]$Yes,
    [switch]$NoWait,
    [switch]$AutoPort,
    [switch]$CleanStale,
    [int]$TimeoutSeconds = 240
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "_common.ps1")

# Strict port mode unless caller opts out.
$global:OwcStrictPorts = -not $AutoPort
Reset-OwcReservedPorts

$context = Get-OwcContext -CallerPath $MyInvocation.MyCommand.Path
Assert-OwcProjectFiles -Context $context
Assert-DockerAvailable
Ensure-OwcDataDir -Context $context
Ensure-OwcEnvFile -Context $context -Yes:$Yes

# Surface resolved host ports to compose so containers honour the strict choice.
$env:OWC_TOOLS_HOST_PORT = "$($context.ToolsHostPort)"
$env:OWC_WEB_HOST_PORT = "$($context.WebHostPort)"
$env:OWC_TOOLS_PW_HOST_PORT = "$($context.PlaywrightToolsHostPort)"
$env:OWC_TOOLS_DEBUG_HOST_PORT = "$($context.ToolsDebugHostPort)"
$env:OWC_TOOLS_PW_DEBUG_HOST_PORT = "$($context.PlaywrightToolsDebugHostPort)"
$env:UI_CORS_ORIGINS = "http://localhost:$($context.WebHostPort),http://127.0.0.1:$($context.WebHostPort)"

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
Write-OwcInfo ("Port mode: " + (& { if ($AutoPort) { "auto (will shift on conflict)" } else { "strict (fixed)" } }))
Write-OwcInfo "MCP tools host port: $($context.ToolsHostPort)"
Write-OwcInfo "Playwright tools host port: $($context.PlaywrightToolsHostPort)"
Write-OwcInfo "Web host port: $($context.WebHostPort)"
Write-OwcInfo "Chrome debug ports: $($context.PlaywrightToolsDebugHostPort) (playwright)"
Write-OwcInfo "API host port: 8000 (fixed)"

# Fail fast if API port 8000 is held by something other than our own stopped container.
if (-not (Test-OwcTcpPortAvailable -Port 8000)) {
    if ($AutoPort) {
        Write-OwcWarn "API port 8000 is busy; AutoPort will not remap 8000 (compose pins it)."
    }
    else {
        $holder = Format-OwcPortHolder -Port 8000
        throw "API port 8000 is already in use ($holder). Free it (Stop-Process -Id <pid>) or stop the previous OWC stack with scripts/docker/stop.ps1 before retrying."
    }
}

if ($CleanStale) {
    Write-OwcStep "Removing stale OWC containers..."
    foreach ($name in @($context.Container, $context.ToolContainer, $context.PlaywrightToolContainer, $context.WebContainer, "postgres")) {
        if (Remove-OwcStaleContainer -Container $name) {
            Write-OwcInfo "Removed '$name'."
        }
    }
}

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

try {
    Invoke-OwcComposeChecked -Context $context -Arguments (@("up", "-d", "--remove-orphans") + $context.StartServices) | Out-Null
}
catch {
    Write-OwcFail "Compose up failed."
    Write-OwcWarn "Recent stack status follows so you can spot port conflicts or unhealthy services:"
    Invoke-OwcComposeCapture -Context $context -Arguments @("ps") -StreamOutput | Out-Null
    Write-OwcWarn "Last log lines from each owc service:"
    foreach ($svc in $context.StartServices) {
        Write-Host "--- $svc ---" -ForegroundColor DarkGray
        Invoke-OwcComposeCapture -Context $context -Arguments @("logs", "--no-color", "--tail", "30", $svc) -StreamOutput | Out-Null
    }
    throw
}

if (-not $NoWait) {
    Write-OwcStep "Waiting for application health..."
    try {
        Wait-OwcServiceHealthy -Context $context -TimeoutSeconds $TimeoutSeconds
    }
    catch {
        Write-OwcFail "Health wait timed out."
        Invoke-OwcComposeCapture -Context $context -Arguments @("logs", "--no-color", "--tail", "60", $context.Service) -StreamOutput | Out-Null
        throw
    }
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
Write-Host "    /providers     Provider intel   m3u8 / IP / whois lookup"              -ForegroundColor DarkGray
Write-Host "    /evaluations   Eval lab         Synthetic, mocked and live suites"     -ForegroundColor DarkGray
Write-Host "    /settings      Pricing config   Model cost configuration"              -ForegroundColor DarkGray
Write-Host ""

Show-OwcComposeStatus -Context $context
