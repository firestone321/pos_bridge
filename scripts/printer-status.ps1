[CmdletBinding()]
param([Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$PrinterName)

$ErrorActionPreference = 'Stop'
$escapedName = $PrinterName.Replace("'", "''")
$printer = Get-CimInstance -ClassName Win32_Printer -Filter "Name='$escapedName'" | Select-Object -First 1
if ($null -eq $printer) {
  [pscustomobject]@{ found = $false } | ConvertTo-Json -Compress
  exit 0
}

$statusText = switch ([int]$printer.PrinterStatus) {
  3 { 'Idle' }
  4 { 'Printing' }
  5 { 'Warmup' }
  7 { 'Offline' }
  default { "Windows printer status $($printer.PrinterStatus)" }
}
[pscustomobject]@{
  found = $true
  name = [string]$printer.Name
  workOffline = [bool]$printer.WorkOffline
  printerStatus = [int]$printer.PrinterStatus
  detectedErrorState = [int]$printer.DetectedErrorState
  statusText = $statusText
} | ConvertTo-Json -Compress
