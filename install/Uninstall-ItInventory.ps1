param(
  [string]$ServiceName = "ItInventory",
  [int]$Port = 8080
)

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
  sc.exe delete $ServiceName | Out-Null
}

$ruleName = "Inventar IT TCP $Port"
if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
  Remove-NetFirewallRule -DisplayName $ruleName
}

Write-Host "Service-ul a fost eliminat. Datele din folderul aplicatiei nu au fost sterse."
