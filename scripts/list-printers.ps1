$ErrorActionPreference = 'Stop'
@(
  Get-CimInstance -ClassName Win32_Printer |
    Sort-Object Name |
    ForEach-Object {
      [pscustomobject]@{
        name = [string]$_.Name
        status = switch ([int]$_.PrinterStatus) { 3 { 'Idle' } 4 { 'Printing' } 5 { 'Warmup' } 7 { 'Offline' } default { "Status $($_.PrinterStatus)" } }
        workOffline = [bool]$_.WorkOffline
      }
    }
) | ConvertTo-Json -Compress
