# Pornire la boot fara Windows Service (foloseste Task Scheduler — recomandat daca serviciul nu porneste).
param(
  [string]$InstallPath = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)),
  [string]$TaskName = "ItInventory"
)

$ErrorActionPreference = "Stop"
$runner = Join-Path $InstallPath "install\Run-ItInventory.cmd"
if (-not (Test-Path $runner)) { throw "Lipseste $runner. Genereaza Run-ItInventory.cmd mai intai." }

$action = New-ScheduledTaskAction -Execute $runner -WorkingDirectory $InstallPath
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

# Opreste serviciul Windows daca exista (evita conflict 8080)
Stop-Service ItInventory -Force -ErrorAction SilentlyContinue
Set-Service ItInventory -StartupType Disabled -ErrorAction SilentlyContinue
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3

$listen = netstat -ano | Select-String ":8080" | Select-String "LISTENING"
if ($listen) {
  Write-Host "OK — aplicatia asculta pe 8080. Deschide http://localhost:8080"
} else {
  Write-Warning "Nu vad LISTENING pe 8080. Ruleaza manual: $runner"
}
