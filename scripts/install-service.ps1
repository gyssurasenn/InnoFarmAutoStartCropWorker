<#
  install-service.ps1

  Installs this worker as a Windows Service using NSSM (https://nssm.cc/), so it starts on boot and
  restarts itself if it crashes. Same setup as the climate-alarm worker, different service name.

  NSSM isn't an npm package - download nssm.exe yourself first:
    1. https://nssm.cc/download -> get the win64 zip -> nssm-2.24\win64\nssm.exe
    2. Either put nssm.exe on your PATH, or pass its full path via -NssmPath below.

  Usage (run PowerShell as Administrator - installing a service requires it):
    .\scripts\install-service.ps1
    .\scripts\install-service.ps1 -NssmPath "C:\tools\nssm.exe"
    .\scripts\install-service.ps1 -NodeExe "C:\Program Files\nodejs\node.exe"

  -NodeExe exists because on the production server Get-Command node reported "not found" even when
  node -v worked in the same window (climate-alarm deploy, 2026-07-17).
#>

param(
  [string]$NssmPath = "nssm",
  [string]$ServiceName = "InnoFarmAutoStartCropWorker",
  [string]$NodeExe = ""
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
if (-not $NodeExe) { $NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $NodeExe -or -not (Test-Path $NodeExe)) {
  Write-Error "node.exe not found. Install Node.js first (https://nodejs.org) or pass -NodeExe 'C:\Program Files\nodejs\node.exe'."
  exit 1
}

try {
  & $NssmPath version | Out-Null
} catch {
  Write-Error "nssm not found/runnable at '$NssmPath'. Download it from https://nssm.cc/download and either add it to PATH or pass -NssmPath 'C:\path\to\nssm.exe'."
  exit 1
}

if (-not (Test-Path (Join-Path $ProjectDir ".env"))) {
  Write-Warning ".env not found in $ProjectDir - the service will fail to start until you copy .env.example to .env and fill it in."
}

New-Item -ItemType Directory -Force -Path (Join-Path $ProjectDir "logs") | Out-Null

Write-Host "Installing service '$ServiceName'..."
& $NssmPath install $ServiceName $NodeExe
& $NssmPath set $ServiceName AppParameters "src/index.js"
& $NssmPath set $ServiceName AppDirectory $ProjectDir
& $NssmPath set $ServiceName AppStdout (Join-Path $ProjectDir "logs\worker.log")
& $NssmPath set $ServiceName AppStderr (Join-Path $ProjectDir "logs\worker-error.log")
& $NssmPath set $ServiceName AppRotateFiles 1
& $NssmPath set $ServiceName AppRotateBytes 10485760
& $NssmPath set $ServiceName AppRotateOnline 1
& $NssmPath set $ServiceName Start SERVICE_AUTO_START
& $NssmPath set $ServiceName AppExit Default Restart
& $NssmPath set $ServiceName AppRestartDelay 5000
& $NssmPath set $ServiceName DisplayName "InnoFarm Auto Start Crop Worker"
& $NssmPath set $ServiceName Description "Creates and starts auto-start crops every 30 minutes (dbo.AutoStartCrop_CreatePending / _GateCheck). See README.md in the project folder."

Write-Host "Starting service..."
& $NssmPath start $ServiceName

Write-Host ""
Write-Host "Done. Check status with: nssm status $ServiceName"
Write-Host "Logs: $ProjectDir\logs\worker.log (and worker-error.log)"
Write-Host "Stop with: nssm stop $ServiceName"
Write-Host "Uninstall with: .\scripts\uninstall-service.ps1"
