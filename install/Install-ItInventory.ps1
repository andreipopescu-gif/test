param(
  [string]$InstallPath = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [int]$Port = 8080,
  [string]$ServiceName = "ItInventory",
  [switch]$UseScheduledTaskOnly
)

$ErrorActionPreference = "Stop"

function Write-RunnerCmd {
  param([string]$TargetDir, [string]$NodeExe, [int]$ListenPort)
  $template = Join-Path $TargetDir "install\Run-ItInventory.cmd.template"
  if (-not (Test-Path $template)) { throw "Lipseste $template" }
  $out = Join-Path $TargetDir "install\Run-ItInventory.cmd"
  $body = (Get-Content -Raw -Path $template) `
    -replace '__INSTALL_DIR__', $TargetDir `
    -replace '__PORT__', "$ListenPort" `
    -replace '__NODE_PATH__', $NodeExe
  Set-Content -Path $out -Value $body -Encoding ASCII
  return $out
}

function Register-ItInventoryTask {
  param([string]$TargetDir, [string]$TaskName)
  $runner = Join-Path $TargetDir "install\Run-ItInventory.cmd"
  $action = New-ScheduledTaskAction -Execute $runner -WorkingDirectory $TargetDir
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

function Install-WindowsService {
  param([string]$NodeExe, [string]$ServerJs, [string]$Name)
  $regPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$Name"
  $imagePath = "`"$NodeExe`" `"$ServerJs`""

  $existing = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($existing) {
    if ($existing.Status -eq "Running") { Stop-Service -Name $Name -Force }
    sc.exe delete $Name | Out-Null
    Start-Sleep -Seconds 2
  }

  sc.exe create $Name binPath= $imagePath start= auto DisplayName= "InventarIT" | Out-Null
  if ($LASTEXITCODE -ne 0) { return $false }
  Set-ItemProperty -Path $regPath -Name ImagePath -Value $imagePath -ErrorAction SilentlyContinue
  Set-ItemProperty -Path $regPath -Name ObjectName -Value "LocalSystem" -ErrorAction SilentlyContinue
  sc.exe description $Name "Inventar IT - inventar obiecte IT" | Out-Null
  return $true
}

Write-Host "Instalare Inventar IT in $InstallPath"

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js nu este in PATH." }

$nodePath = $node.Source
$serverPath = Join-Path $InstallPath "src\server.js"
if (-not (Test-Path $serverPath)) { throw "Lipseste $serverPath" }

New-Item -ItemType Directory -Force -Path (Join-Path $InstallPath "data") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallPath "data\uploads") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $InstallPath "data\backups") | Out-Null

$runnerPath = Write-RunnerCmd -TargetDir $InstallPath -NodeExe $nodePath -ListenPort $Port

[Environment]::SetEnvironmentVariable("PORT", "$Port", "Machine")
[Environment]::SetEnvironmentVariable("ITINV_DB_PATH", (Join-Path $InstallPath "data\app.db.json"), "Machine")
[Environment]::SetEnvironmentVariable("ITINV_UPLOAD_PATH", (Join-Path $InstallPath "data\uploads"), "Machine")

# Opreste orice instanta veche
Stop-ScheduledTask -TaskName $ServiceName -ErrorAction SilentlyContinue
Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

$ruleName = "Inventar IT TCP $Port"
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
  try {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null
  } catch { Write-Warning "Firewall: $($_.Exception.Message)" }
}

$serviceOk = $false
if (-not $UseScheduledTaskOnly) {
  Write-Host "Incerc serviciu Windows (node direct)..."
  if (Install-WindowsService -NodeExe $nodePath -ServerJs $serverPath -Name $ServiceName) {
    try {
      Start-Service -Name $ServiceName -ErrorAction Stop
      Start-Sleep -Seconds 2
      if ((Get-Service $ServiceName).Status -eq "Running") { $serviceOk = $true }
    } catch {
      Write-Warning "Serviciul Windows nu a pornit: $($_.Exception.Message)"
      Set-Service $ServiceName -StartupType Disabled -ErrorAction SilentlyContinue
    }
  }
}

if (-not $serviceOk) {
  Write-Host "Folosesc Task Scheduler (recomandat pe acest server)..." -ForegroundColor Cyan
  Set-Service $ServiceName -StartupType Disabled -ErrorAction SilentlyContinue
  Register-ItInventoryTask -TargetDir $InstallPath -TaskName $ServiceName
  Start-ScheduledTask -TaskName $ServiceName
  Start-Sleep -Seconds 3
}

$listening = netstat -ano | Select-String ":$Port\s" | Select-String "LISTENING"
if (-not $listening) {
  Write-Host ""
  Write-Host "Aplicatia NU asculta pe portul $Port." -ForegroundColor Red
  Write-Host "Ruleaza in cmd (fereastra ramane deschisa la eroare):"
  Write-Host "  cmd /k `"$runnerPath`""
  throw "Pornire esuata."
}

Write-Host ""
Write-Host "Instalare OK: http://$env:COMPUTERNAME`:$Port" -ForegroundColor Green
Write-Host "Date: $(Join-Path $InstallPath 'data\app.db.json')"
if ($serviceOk) {
  Write-Host "Pornire: serviciu Windows $ServiceName"
} else {
  Write-Host "Pornire: Task Scheduler $ServiceName (la fiecare restart)"
}
Write-Host "Test manual: cmd /k `"$runnerPath`""
