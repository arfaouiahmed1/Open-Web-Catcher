param(
    [string]$DataDir = "data",
    [string]$BackupRoot = "data/memory-backups"
)

$ErrorActionPreference = "Stop"

$workspace = (Resolve-Path ".").Path
$resolvedData = (Resolve-Path $DataDir).Path
if (-not $resolvedData.StartsWith($workspace, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "DataDir must resolve inside the current workspace: $resolvedData"
}

$backupRootPath = Join-Path $workspace $BackupRoot
New-Item -ItemType Directory -Force -Path $backupRootPath | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $backupRootPath $stamp
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null

$files = @(
    "site_memory.db",
    "site_memory_profiles.json"
)

foreach ($file in $files) {
    $source = Join-Path $resolvedData $file
    if (Test-Path -LiteralPath $source) {
        Move-Item -LiteralPath $source -Destination (Join-Path $backupDir $file)
    }
}

$profilesPath = Join-Path $resolvedData "site_memory_profiles.json"
'{"version":1,"profiles":{}}' | Set-Content -LiteralPath $profilesPath -Encoding UTF8

Write-Output "Backed up site memory to $backupDir"
