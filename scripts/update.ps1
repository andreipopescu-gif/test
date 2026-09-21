#Requires -Version 5.1
<#
.SYNOPSIS
  Update IT Inventory on the Windows server with a delta zip (or folder), restart service, health-check.

.DESCRIPTION
  1. Stops the Node service (or process listening on PORT)
  2. Copies files from -Source (zip or folder) into -AppDir
  3. Never overwrites data\app.db.json or data\uploads unless -IncludeData
  4. Starts the service again
  5. Hits /api/dashboard (and /api/health) until OK or timeout

.EXAMPLE
  .\scripts\update.ps1 -Source C:\temp\it-inventory-delta.zip -AppDir C:\invapp -ServiceName ITInventory

.EXAMPLE
  .\scripts\update.ps1 -Source .\dist -AppDir C:\invapp -Port 8080
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Source,

  [string]$AppDir = "C:\invapp",

  [string]$ServiceName = "",

  [int]$Port = 8080,

  [switch]$IncludeData,

  [int]$HealthTimeoutSec = 60
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

if (-not (Test-Path $AppDir)) {
  throw "AppDir not found: $AppDir"
}

$staging = Join-Path $env:TEMP ("itinv-update-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $staging | Out-Null

try {
  Write-Step "Prepare source"
  if (Test-Path $Source -PathType Leaf) {
    if ($Source -like "*.zip") {
      Expand-Archive -Path $Source -DestinationPath $staging -Force
    } else {
      throw "Source file must be a .zip (got $Source)"
    }
  } elseif (Test-Path $Source -PathType Container) {
    Copy-Item -Path (Join-Path $Source "*") -Destination $staging -Recurse -Force
  } else {
    throw "Source not found: $Source"
  }

  # If zip contained a single root folder, use that
  $children = Get-ChildItem $staging
  if ($children.Count -eq 1 -and $children[0].PSIsContainer) {
    $staging = $children[0].FullName
  }

  Write-Step "Stop app"
  if ($ServiceName -and (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  } else {
    Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
      ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
  }

  Write-Step "Copy files (preserve data unless -IncludeData)"
  $excludeNames = @("node_modules", ".git", "data")
  Get-ChildItem -Path $staging -Force | ForEach-Object {
    $name = $_.Name
    if ($excludeNames -contains $name -and -not $IncludeData) {
      Write-Host "  skip $name"
      return
    }
    $dest = Join-Path $AppDir $name
    if ($_.PSIsContainer) {
      if ($name -eq "data" -and -not $IncludeData) { return }
      Copy-Item -Path $_.FullName -Destination $dest -Recurse -Force
    } else {
      Copy-Item -Path $_.FullName -Destination $dest -Force
    }
    Write-Host "  copy $name"
  }

  # Always keep live DB / uploads if present in target
  if (-not $IncludeData) {
    Write-Host "  preserved $AppDir\data (app.db.json + uploads)"
  }

  Write-Step "Start app"
  if ($ServiceName -and (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
    Start-Service -Name $ServiceName
  } else {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw "node.exe not found in PATH; start the service manually." }
    Start-Process -FilePath $node.Source -ArgumentList "src\server.js" -WorkingDirectory $AppDir -WindowStyle Hidden
  }

  Write-Step "Health check"
  $deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
  $ok = $false
  while ((Get-Date) -lt $deadline) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 5
      $dash = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/dashboard" -TimeoutSec 5
      if ($health.ok -and $dash) {
        Write-Host "OK health + dashboard" -ForegroundColor Green
        $ok = $true
        break
      }
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  if (-not $ok) { throw "Health check failed after ${HealthTimeoutSec}s" }

  Write-Step "Update complete"
} finally {
  Remove-Item -Path (Join-Path $env:TEMP "itinv-update-*") -Recurse -Force -ErrorAction SilentlyContinue
}
