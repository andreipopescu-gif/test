Inventar IT — pornire pe Windows Server (offline)
================================================

IMPORTANT
---------
Fișierul de pornire este:
  install\Run-ItInventory.cmd
NU rula Run-ItInventory.cmd.template (doar șablon).

După Install-ItInventory.ps1, aplicația rulează din folderul
unde rulezi scriptul (ex. C:\invapp), nu din C:\Apps\ItInventory
decât dacă copiezi explicit acolo.

Test manual (înainte de serviciu)
---------------------------------
PowerShell sau CMD ca Administrator:

  cmd /c "C:\Apps\ItInventory\install\Run-ItInventory.cmd"

Browser: http://localhost:8080

Generează Run-ItInventory.cmd din template
------------------------------------------
Din folderul aplicatiei (ex. C:\invapp):

  powershell -ExecutionPolicy Bypass -File install\Create-Run-ItInventoryCmd.ps1

Instalare serviciu
------------------
  cd C:\invapp
  powershell -ExecutionPolicy Bypass -File install\Install-ItInventory.ps1

Sau totul în C:\invapp:

  powershell -ExecutionPolicy Bypass -File install\Install-ItInventory.ps1 -InstallPath C:\invapp

Reinstalare serviciu
--------------------
  Stop-Service ItInventory -Force -ErrorAction SilentlyContinue
  sc.exe delete ItInventory
  powershell -ExecutionPolicy Bypass -File install\Install-ItInventory.ps1
