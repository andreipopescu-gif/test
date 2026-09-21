# Genereaza install\Run-ItInventory.cmd din template (ruleaza din folderul aplicatiei).
param(
  [string]$InstallPath = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
)

$ErrorActionPreference = "Stop"
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js nu este in PATH." }

$template = Join-Path $InstallPath "install\Run-ItInventory.cmd.template"
if (-not (Test-Path $template)) { throw "Lipseste $template" }

$port = [Environment]::GetEnvironmentVariable("PORT", "Machine")
if (-not $port) { $port = "8080" }

$body = (Get-Content -Raw $template) `
  -replace '__INSTALL_DIR__', $InstallPath `
  -replace '__PORT__', $port `
  -replace '__NODE_PATH__', $node.Source

$out = Join-Path $InstallPath "install\Run-ItInventory.cmd"
Set-Content -Path $out -Value $body -Encoding ASCII
Write-Host "Creat: $out"
Write-Host "Test: cmd /c `"$out`""
