# Repara ImagePath serviciu ItInventory + pornire (ruleaza ca Administrator).
param(
  [string]$InstallPath = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [string]$ServiceName = "ItInventory"
)

$ErrorActionPreference = "Stop"

$node = (Get-Command node.exe).Source
$server = Join-Path $InstallPath "src\server.js"
if (-not (Test-Path $server)) { throw "Lipseste $server" }

$regPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
if (-not (Test-Path $regPath)) {
  $runner = Join-Path $InstallPath "install\Run-ItInventory.cmd"
  $bin = "`"$env:SystemRoot\System32\cmd.exe`" /c `"$runner`""
  sc.exe create $ServiceName binPath= $bin start= auto DisplayName= "InventarIT" | Out-Null
}

# ImagePath cu ghilimele corecte pentru node + server.js
$imagePath = "`"$node`" `"$server`""
Set-ItemProperty -Path $regPath -Name ImagePath -Value $imagePath
Set-ItemProperty -Path $regPath -Name ObjectName -Value "LocalSystem"

Write-Host "ImagePath setat la: $imagePath"
Write-Host (Get-ItemProperty $regPath).ImagePath

Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

$listen = netstat -ano | Select-String ":8080" | Select-String "LISTENING"
if ($listen) {
  Write-Warning "Port 8080 inca in LISTENING — opreste procesul inainte de Start-Service:"
  Write-Host $listen
}

Start-Service $ServiceName
Start-Sleep -Seconds 2
Get-Service $ServiceName
