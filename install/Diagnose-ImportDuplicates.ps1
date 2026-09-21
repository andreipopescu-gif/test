param(
  [Parameter(Mandatory = $true)]
  [string]$CsvPath,
  [string]$BaseUrl = "http://localhost:8080"
)

if (-not (Test-Path $CsvPath)) { throw "Fisier inexistent: $CsvPath" }

$assets = Invoke-RestMethod -Uri "$BaseUrl/api/assets"
$bySerial = @{}
$byTag = @{}
foreach ($a in $assets) {
  if ($a.serialNumber) { $bySerial[$a.serialNumber.ToLower()] = $a }
  if ($a.assetTag)     { $byTag[$a.assetTag.ToLower()] = $a }
}

$rows = Import-Csv -Path $CsvPath
$seenSerial = @{}
$seenTag = @{}
$line = 1
$issues = @()

foreach ($row in $rows) {
  $line++
  $serial = [string]($row.'Serial number' ?? $row.'Serial Number' ?? '').Trim()
  $tag = [string]($row.'Device name' ?? $row.'Device Name' ?? $row.'Management name' ?? '').Trim()
  if (-not $serial -and -not $tag) { continue }

  if ($serial) {
    $sk = $serial.ToLower()
    if ($seenSerial.ContainsKey($sk)) {
      $issues += [pscustomobject]@{ Line = $line; Type = 'CSV duplicate serial'; Serial = $serial; AssetTag = $tag; Detail = "Also on line $($seenSerial[$sk])" }
    } else { $seenSerial[$sk] = $line }
    if ($bySerial.ContainsKey($sk)) {
      $issues += [pscustomobject]@{ Line = $line; Type = 'Serial in DB'; Serial = $serial; AssetTag = $tag; Detail = "DB tag: $($bySerial[$sk].assetTag)" }
    }
  }

  if ($tag) {
    $tk = $tag.ToLower()
    if ($seenTag.ContainsKey($tk)) {
      $issues += [pscustomobject]@{ Line = $line; Type = 'CSV duplicate tag'; Serial = $serial; AssetTag = $tag; Detail = "Also on line $($seenTag[$tk])" }
    } else { $seenTag[$tk] = $line }
    if ($byTag.ContainsKey($tk)) {
      $db = $byTag[$tk]
      if (-not $serial -or $db.serialNumber.ToLower() -ne $serial.ToLower()) {
        $issues += [pscustomobject]@{ Line = $line; Type = 'Tag in DB (serial differs)'; Serial = $serial; AssetTag = $tag; Detail = "DB serial: $($db.serialNumber)" }
      }
    }
  }
}

Write-Host "Assets in DB: $($assets.Count)" -ForegroundColor Cyan
Write-Host "CSV rows: $($rows.Count)" -ForegroundColor Cyan
if (-not $issues.Count) {
  Write-Host "No serial/tag conflicts found between CSV and DB." -ForegroundColor Green
} else {
  Write-Host "Conflicts ($($issues.Count)):" -ForegroundColor Yellow
  $issues | Format-Table -AutoSize
}
