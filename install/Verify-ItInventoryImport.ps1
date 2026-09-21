param([string]$BaseUrl = "http://localhost:8080")

Write-Host "=== Verificare import Intune ===" -ForegroundColor Cyan

try {
  $health = Invoke-RestMethod -Uri "$BaseUrl/api/health"
  Write-Host "Health OK: importResolver=$($health.importResolver), iPhone models=$($health.iphoneModels), total models=$($health.catalogModels)"
  if ($health.importResolver -ne '2026-06-11') {
    Write-Host "ATENTIE: serverul ruleaza cod VECHI (lipseste model-resolver.js nou)." -ForegroundColor Red
  }
  if ($health.iphoneModels -lt 5) {
    Write-Host "ATENTIE: catalogul are prea putine modele iPhone. Ruleaza Add-CatalogModels.ps1" -ForegroundColor Red
  }
} catch {
  Write-Host "Nu pot accesa $BaseUrl/api/health : $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

$resolverPath = Join-Path (Split-Path $PSScriptRoot -Parent) "src\import\model-resolver.js"
if (Test-Path $resolverPath) {
  $content = Get-Content -Raw $resolverPath
  if ($content -match 'parseIphoneIntuneModel') {
    Write-Host "Fisier model-resolver.js: OK (versiune noua)" -ForegroundColor Green
  } else {
    Write-Host "Fisier model-resolver.js: VECHI" -ForegroundColor Red
  }
} else {
  Write-Host "Lipseste $resolverPath" -ForegroundColor Red
}

Write-Host ""
Write-Host "Dupa update: reporneste task-ul ItInventory, apoi Ctrl+F5 in browser."
