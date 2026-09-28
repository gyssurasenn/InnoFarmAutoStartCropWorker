<#
  uninstall-service.ps1
  Stops and removes the Windows Service installed by install-service.ps1.
  Run PowerShell as Administrator.
#>

param(
  [string]$NssmPath = "nssm",
  [string]$ServiceName = "InnoFarmAutoStartCropWorker"
)

$ErrorActionPreference = "Stop"

& $NssmPath stop $ServiceName
& $NssmPath remove $ServiceName confirm

Write-Host "Service '$ServiceName' removed. Log files under .\logs\ were left in place."
