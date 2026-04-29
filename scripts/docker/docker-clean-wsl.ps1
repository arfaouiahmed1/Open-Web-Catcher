#Requires -Version 5.1
<#
.SYNOPSIS
    Deep Docker cleanup + WSL2 VHDX compaction.

.PARAMETER Level
    1 = dangling images, stopped containers, build cache (safe, default)
    2 = ALL unused images + unused volumes (aggressive, prompts unless -Yes)
    3 = Level 2 + wsl --shutdown + VHDX compact (frees disk on host)

.PARAMETER Volumes
    Also prune named volumes (warns about postgres_data). Applies at Level 2+.

.PARAMETER Yes
    Skip all confirmation prompts.

.EXAMPLE
    .\docker-clean-wsl.ps1
    .\docker-clean-wsl.ps1 -Level 2 -Yes
    .\docker-clean-wsl.ps1 -Level 3 -Volumes
#>
param(
    [ValidateSet(1, 2, 3)]
    [int]$Level = 1,
    [switch]$Volumes,
    [switch]$Yes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $ScriptDir '_common.ps1')

function Confirm-Action {
    param([string]$Message)
    if ($Yes) { return $true }
    Write-Host ""
    Write-Host $Message -ForegroundColor Yellow
    $response = Read-Host "Continue? [y/N]"
    return $response -match '^[Yy]$'
}

function Format-Bytes {
    param([long]$Bytes)
    if ($Bytes -ge 1GB) { return "{0:F2} GB" -f ($Bytes / 1GB) }
    if ($Bytes -ge 1MB) { return "{0:F2} MB" -f ($Bytes / 1MB) }
    return "{0:F2} KB" -f ($Bytes / 1KB)
}

Assert-DockerAvailable

$startTime = Get-Date
Write-Host ""
Write-Host "Docker + WSL cleanup  [Level $Level]" -ForegroundColor Cyan
Write-Host ("=" * 44)

# Level 1: safe prune
Write-Host ""
Write-Host "[1/3] Pruning stopped containers..." -ForegroundColor Gray
docker container prune -f | Out-Null

Write-Host "[2/3] Pruning dangling images..." -ForegroundColor Gray
docker image prune -f | Out-Null

Write-Host "[3/3] Pruning build cache..." -ForegroundColor Gray
docker builder prune -f | Out-Null

Write-Host "Level 1 done." -ForegroundColor Green

# Level 2: aggressive image + volume prune
if ($Level -ge 2) {
    $msg = "Level 2 will remove ALL unused images (not just dangling)."
    if ($Volumes) {
        $msg += "`nWARNING: -Volumes will also prune unused named volumes (may delete postgres_data if stack is down)."
    }

    if (-not (Confirm-Action $msg)) {
        Write-Host "Skipped Level 2." -ForegroundColor Yellow
    } else {
        Write-Host ""
        Write-Host "Pruning ALL unused images..." -ForegroundColor Gray
        docker image prune -af | Out-Null

        if ($Volumes) {
            Write-Host "Pruning unused volumes..." -ForegroundColor Gray
            docker volume prune -f | Out-Null
        }

        Write-Host "Level 2 done." -ForegroundColor Green
    }
}

# Level 3: WSL shutdown + VHDX compact
if ($Level -ge 3) {
    $msg = "Level 3 shuts down WSL2 then compacts the VHDX disk image. Docker will need to restart."

    if (-not (Confirm-Action $msg)) {
        Write-Host "Skipped Level 3." -ForegroundColor Yellow
    } else {
        $vhdxCandidates = @(
            "$env:LOCALAPPDATA\Docker\wsl\disk\docker_data.vhdx",
            "$env:LOCALAPPDATA\Docker\wsl\data\ext4.vhdx"
        )
        $vhdxPath = $vhdxCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

        if ($vhdxPath) {
            $sizeBefore = (Get-Item $vhdxPath).Length
            Write-Host ""
            Write-Host "VHDX: $vhdxPath" -ForegroundColor Gray
            Write-Host "Size before: $(Format-Bytes $sizeBefore)" -ForegroundColor Gray
        } else {
            Write-Host "VHDX not found at expected paths; will still shut down WSL." -ForegroundColor Yellow
        }

        Write-Host "Shutting down WSL2..." -ForegroundColor Gray
        wsl --shutdown
        Start-Sleep -Seconds 3

        if ($vhdxPath) {
            Write-Host "Compacting VHDX (this may take a minute)..." -ForegroundColor Gray

            $optimized = $false
            try {
                $cmd = Get-Command Optimize-VHD -ErrorAction SilentlyContinue
                if ($cmd) {
                    Optimize-VHD -Path $vhdxPath -Mode Full
                    $optimized = $true
                }
            } catch {
                # fall through to diskpart
            }

            if (-not $optimized) {
                $tmpScript = [System.IO.Path]::GetTempFileName() + ".txt"
                $lines = @(
                    ('select vdisk file="' + $vhdxPath + '"'),
                    'attach vdisk readonly',
                    'compact vdisk',
                    'detach vdisk',
                    'exit'
                )
                [System.IO.File]::WriteAllLines($tmpScript, $lines, [System.Text.Encoding]::ASCII)

                $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
                try {
                    if ($isAdmin) {
                        diskpart /s $tmpScript | Out-Null
                    } else {
                        Write-Host "  diskpart needs elevation -- UAC prompt will appear" -ForegroundColor Yellow
                        $proc = Start-Process -FilePath 'diskpart.exe' -ArgumentList ('/s', $tmpScript) -Verb RunAs -Wait -PassThru
                        if ($proc.ExitCode -ne 0) {
                            Write-Host ("  diskpart exited {0} -- compaction may be incomplete." -f $proc.ExitCode) -ForegroundColor Yellow
                        }
                    }
                } finally {
                    Remove-Item $tmpScript -ErrorAction SilentlyContinue
                }
            }

            $sizeAfter = (Get-Item $vhdxPath).Length
            $saved = $sizeBefore - $sizeAfter
            Write-Host "Size after:  $(Format-Bytes $sizeAfter)" -ForegroundColor Gray
            Write-Host "Saved:       $(Format-Bytes $saved)" -ForegroundColor Green
        }

        Write-Host "Level 3 done. Restart Docker Desktop to resume." -ForegroundColor Green
    }
}

$elapsed = (Get-Date) - $startTime
Write-Host ""
Write-Host ("Finished in {0:F1}s" -f $elapsed.TotalSeconds) -ForegroundColor Cyan