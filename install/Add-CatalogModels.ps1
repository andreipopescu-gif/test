param(
  [string]$BaseUrl = "http://localhost:8080",
  [string]$Actor = "IT"
)

function PhoneModel($brand, $name, $generation = "Standard") {
  @{ brandName = $brand; categoryName = "Telefon"; name = $name; generation = $generation; deviceType = "Telefon" }
}

function LaptopModel($brand, $name, $generation) {
  @{ brandName = $brand; categoryName = "Laptop"; name = $name; generation = $generation; deviceType = "Laptop" }
}

$models = @(
  (PhoneModel "Apple iPhone" "iPhone SE"),
  (PhoneModel "Apple iPhone" "iPhone SE" "2nd gen"),
  (PhoneModel "Apple iPhone" "iPhone SE" "3rd gen"),
  (PhoneModel "Apple iPhone" "iPhone 11"),
  (PhoneModel "Apple iPhone" "iPhone 13"),
  (PhoneModel "Apple iPhone" "iPhone 14"),
  (PhoneModel "Apple iPhone" "iPhone 14 Pro" "Pro"),
  (PhoneModel "Apple iPhone" "iPhone 14 Pro Max" "Pro Max"),
  (PhoneModel "Apple iPhone" "iPhone 15"),
  (PhoneModel "Apple iPhone" "iPhone 15 Pro" "Pro"),
  (PhoneModel "Apple iPhone" "iPhone 15 Pro Max" "Pro Max"),
  (PhoneModel "Apple iPhone" "iPhone 16e"),
  (PhoneModel "Apple iPhone" "iPhone 16 Pro" "Pro"),
  (PhoneModel "Samsung" "Samsung"),
  (PhoneModel "Samsung" "Galaxy S24"),
  (PhoneModel "Google" "Pixel 7"),
  (PhoneModel "Google" "Pixel 10 Pro XL"),
  (PhoneModel "Xiaomi" "Xiaomi"),
  (PhoneModel "Xiaomi" "2409BRN2CY"),
  (LaptopModel "Lenovo" "ThinkPad X13" "Gen 3")
)

$uri = "$BaseUrl/api/catalog/models"
$headers = @{ "X-Actor" = $Actor }

foreach ($model in $models) {
  $label = "$($model.brandName) $($model.name) $($model.generation)"
  try {
    $created = Invoke-RestMethod -Uri $uri -Method Post -Body ($model | ConvertTo-Json) -ContentType "application/json" -Headers $headers
    Write-Host "Adaugat: $label ($($created.id))" -ForegroundColor Green
  } catch {
    Write-Host "Exista deja sau eroare: $label" -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "Gata. Ruleaza din nou Preview import in browser."
