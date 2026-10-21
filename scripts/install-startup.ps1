[CmdletBinding()]
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$taskName = 'Firestone Smokehouse POS Hardware Bridge'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "Removed scheduled task: $taskName"
  exit 0
}

$serverFile = Join-Path $projectRoot 'dist\server.js'
if (-not (Test-Path -LiteralPath $serverFile -PathType Leaf)) { throw 'Run npm run build before installing Windows startup.' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $node -Argument ('"{0}"' -f $serverFile) -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Description 'Starts the Firestone Smokehouse localhost POS hardware bridge.' -Force | Out-Null
Write-Output "Installed scheduled task: $taskName"
