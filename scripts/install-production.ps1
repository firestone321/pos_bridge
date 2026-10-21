[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'
$serverFile = Join-Path $projectRoot 'dist\server.js'
$startupScript = Join-Path $PSScriptRoot 'install-startup.ps1'
$taskName = 'Firestone Smokehouse POS Hardware Bridge'

$node = Get-Command node.exe -ErrorAction Stop
$nodeMajor = [int]((& $node.Source --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw 'Node.js 20 or newer is required.' }
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { throw 'The production .env file is missing.' }
if (-not (Test-Path -LiteralPath $serverFile -PathType Leaf)) { throw 'The compiled bridge is missing.' }

$settings = @{}
foreach ($line in Get-Content -LiteralPath $envFile) {
  if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
  $name, $value = $line -split '=', 2
  $settings[$name.Trim()] = $value.Trim()
}

if ($settings['ALLOWED_ORIGIN'] -ne 'https://admin.firestonesmokehouse.com') { throw 'ALLOWED_ORIGIN is not the production admin origin.' }
if ($settings['AUTH_MODE'] -ne 'jwks') { throw 'AUTH_MODE must be jwks in production.' }
if ($settings['BRIDGE_JWKS_URL'] -ne 'https://admin.firestonesmokehouse.com/api/pos-hardware/jwks') { throw 'BRIDGE_JWKS_URL is not the production JWKS endpoint.' }

$printerName = $settings['PRINTER_NAME']
if ([string]::IsNullOrWhiteSpace($printerName)) { throw 'PRINTER_NAME is empty.' }
Get-Printer -Name $printerName -ErrorAction Stop | Out-Null

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startupScript
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

$health = Invoke-RestMethod -Uri 'http://127.0.0.1:17891/health'
$printer = Invoke-RestMethod -Uri 'http://127.0.0.1:17891/printer/status'
if (-not $health.ok) { throw 'Bridge health check failed.' }
if (-not $printer.ok -or -not $printer.printer.configured -or -not $printer.printer.found -or $printer.printer.state -ne 'available') {
  throw 'Configured printer is not available to the bridge.'
}

$updaterScript = Join-Path $PSScriptRoot 'update-production.ps1'
if (Test-Path -LiteralPath $updaterScript) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updaterScript -Install
  if ($LASTEXITCODE -ne 0) { throw 'Daily automatic release updater installation failed.' }
}

Write-Output "Production bridge installed and running with printer: $($printer.printer.printerName)"
