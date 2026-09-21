param(
  [string]$InstallPath = "C:\Apps\ItInventory",
  [string]$BackupPath = "C:\Apps\ItInventory\data\backups"
)

$ErrorActionPreference = "Stop"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$destination = Join-Path $BackupPath "itinventory-$stamp"

New-Item -ItemType Directory -Force -Path $destination | Out-Null

$db = Join-Path $InstallPath "data\app.db.json"
$uploads = Join-Path $InstallPath "data\uploads"

if (Test-Path $db) {
  Copy-Item $db -Destination (Join-Path $destination "app.db.json") -Force
}

if (Test-Path $uploads) {
  Copy-Item $uploads -Destination (Join-Path $destination "uploads") -Recurse -Force
}

Compress-Archive -Path (Join-Path $destination "*") -DestinationPath "$destination.zip" -Force
Remove-Item $destination -Recurse -Force

Write-Host "Backup creat: $destination.zip"
