[CmdletBinding()]
param(
  [string]$Repository = 'firestone321/pos_bridge',
  [string]$InstallDirectory = '',
  [switch]$Install
)

$ErrorActionPreference = 'Stop'
$taskName = 'Firestone Smokehouse POS Hardware Bridge'
$updaterTaskName = 'Firestone Smokehouse POS Bridge Daily Update'
$installDirectory = if ([string]::IsNullOrWhiteSpace($InstallDirectory)) { Split-Path -Parent $PSScriptRoot } else { [IO.Path]::GetFullPath($InstallDirectory) }
$stateDirectory = Join-Path $installDirectory 'updater-state'
$statePath = Join-Path $stateDirectory 'state.json'
$releasesDirectory = Join-Path $installDirectory 'releases'
$healthUri = 'http://127.0.0.1:17891/health'
$statusUri = 'http://127.0.0.1:17891/printer/status'
$apiHeaders = @{ 'User-Agent' = 'Firestone-Smokehouse-POS-Bridge-Updater'; 'Accept' = 'application/vnd.github+json' }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Get-CurrentReleaseTag {
  if (Test-Path -LiteralPath $statePath) {
    try { return [string](Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json).tag } catch { }
  }
  $manifestPath = Join-Path $installDirectory 'release.json'
  if (Test-Path -LiteralPath $manifestPath) {
    try { return [string](Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).tag } catch { }
  }
  return ''
}

function Test-BridgeHealthy {
  try {
    $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 5
    $printer = Invoke-RestMethod -Uri $statusUri -TimeoutSec 8
    return [bool]($health.ok -and $printer.ok -and $printer.printer.configured -and $printer.printer.found)
  } catch { return $false }
}

function Wait-BridgeHealthy {
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (Test-BridgeHealthy) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Start-BridgeTask {
  Start-ScheduledTask -TaskName $taskName
  if (-not (Wait-BridgeHealthy)) { throw 'Bridge failed its health and printer discovery checks.' }
}

function Install-DailyTask {
  $scriptPath = Join-Path $PSScriptRoot 'update-production.ps1'
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $action = New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Repository "{1}" -InstallDirectory "{2}"' -f $scriptPath, $Repository, $installDirectory) -WorkingDirectory $installDirectory
  $trigger = New-ScheduledTaskTrigger -Daily -At '10:00AM'
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
  Register-ScheduledTask -TaskName $updaterTaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Checks published Firestone Smokehouse POS bridge releases daily and installs verified updates.' -Force | Out-Null
}

if ($Install) {
  $required = @('dist\server.js', 'node_modules', '.env', 'scripts\update-production.ps1')
  foreach ($relativePath in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $installDirectory $relativePath))) { throw "Required production installation file is missing: $relativePath" }
  }
  if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) { throw "The bridge startup task '$taskName' is not installed." }
  if (-not (Test-BridgeHealthy)) { throw 'The bridge must be running with a discoverable printer before enabling the updater.' }
  New-Item -ItemType Directory -Path $stateDirectory, $releasesDirectory -Force | Out-Null
  if (-not (Get-CurrentReleaseTag)) {
    $localPackage = Get-Content -LiteralPath (Join-Path $installDirectory 'package.json') -Raw | ConvertFrom-Json
    $initialTag = "v$($localPackage.version)"
    @{ tag = $initialTag; installedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
  }
  Install-DailyTask
  Write-Output "Daily automatic updates installed. Current release: $(Get-CurrentReleaseTag). Task: $updaterTaskName (10:00 AM while the cashier is logged in; missed runs start at the next logon)."
  exit 0
}

New-Item -ItemType Directory -Path $stateDirectory, $releasesDirectory -Force | Out-Null
$lockPath = Join-Path $stateDirectory 'update.lock'
$lock = $null
try {
  $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch {
  Write-Output 'Another updater instance is already running.'
  exit 0
}

try {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repository/releases/latest" -Headers $apiHeaders -TimeoutSec 20
  $tag = [string]$release.tag_name
  if ([string]::IsNullOrWhiteSpace($tag) -or $tag -notmatch '^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$') { throw 'Latest GitHub release has no valid semantic-version tag.' }
  if ($tag -eq (Get-CurrentReleaseTag)) {
    Write-Output "Already on latest release $tag."
    exit 0
  }

  $asset = @($release.assets | Where-Object { $_.name -eq "smokehouse-pos-bridge-$($tag.TrimStart('v'))-production.zip" } | Select-Object -First 1)
  $checksumAsset = @($release.assets | Where-Object { $_.name -eq "smokehouse-pos-bridge-$($tag.TrimStart('v'))-production.zip.sha256" } | Select-Object -First 1)
  if ($asset.Count -ne 1 -or $checksumAsset.Count -ne 1) { throw "Release $tag must include its production ZIP and SHA-256 checksum assets." }

  $downloadPath = Join-Path $stateDirectory "$tag.zip.download"
  $checksumPath = Join-Path $stateDirectory "$tag.zip.sha256.download"
  Invoke-WebRequest -Uri $asset[0].browser_download_url -Headers $apiHeaders -OutFile $downloadPath -TimeoutSec 120
  Invoke-WebRequest -Uri $checksumAsset[0].browser_download_url -Headers $apiHeaders -OutFile $checksumPath -TimeoutSec 30
  $expectedHash = ([string](Get-Content -LiteralPath $checksumPath -Raw)).Trim().Split(' ')[0].ToUpperInvariant()
  $actualHash = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($expectedHash -notmatch '^[A-F0-9]{64}$' -or $actualHash -ne $expectedHash) { throw 'Release archive SHA-256 verification failed.' }

  $candidate = Join-Path $releasesDirectory $tag
  if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate -Recurse -Force }
  New-Item -ItemType Directory -Path $candidate | Out-Null
  Expand-Archive -LiteralPath $downloadPath -DestinationPath $candidate -Force
  $manifestPath = Join-Path $candidate 'release.json'
  if (-not (Test-Path -LiteralPath (Join-Path $candidate 'dist\server.js')) -or -not (Test-Path -LiteralPath (Join-Path $candidate 'node_modules')) -or -not (Test-Path -LiteralPath (Join-Path $candidate 'scripts\update-production.ps1'))) {
    throw 'Release archive is missing required application files.'
  }
  if (Test-Path -LiteralPath (Join-Path $candidate '.env')) { throw 'Release archive contains a .env file; refusing to install it.' }

  $previousTag = Get-CurrentReleaseTag
  $previousPath = Join-Path $releasesDirectory $previousTag
  $localRoot = $installDirectory.TrimEnd('\') + '\'
  $candidateRoot = $candidate.TrimEnd('\') + '\'
  $filesToReplace = @('dist', 'node_modules', 'scripts\send-raw-printer.ps1', 'scripts\printer-status.ps1', 'scripts\install-startup.ps1', 'scripts\install-production.ps1', 'scripts\build-release.ps1', 'scripts\update-production.ps1', 'package.json', 'release.json')
  $backup = Join-Path $stateDirectory "backup-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $backup | Out-Null
  Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
  Start-Sleep -Seconds 2
  try {
    foreach ($relativePath in $filesToReplace) {
      $currentPath = Join-Path $installDirectory $relativePath
      if (Test-Path -LiteralPath $currentPath) {
        $destination = Join-Path $backup $relativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Move-Item -LiteralPath $currentPath -Destination $destination
      }
      $sourcePath = Join-Path $candidate $relativePath
      if (Test-Path -LiteralPath $sourcePath) {
        $destination = Join-Path $installDirectory $relativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $destination -Recurse
      }
    }
    @{ tag = $tag; installedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $installDirectory 'release.json') -Force
    Start-BridgeTask
  } catch {
    try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch { }
    foreach ($relativePath in $filesToReplace) {
      $currentPath = Join-Path $installDirectory $relativePath
      if (Test-Path -LiteralPath $currentPath) { Remove-Item -LiteralPath $currentPath -Recurse -Force }
      $backupPath = Join-Path $backup $relativePath
      if (Test-Path -LiteralPath $backupPath) {
        $destination = Join-Path $installDirectory $relativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Move-Item -LiteralPath $backupPath -Destination $destination
      }
    }
    Start-BridgeTask
    throw "Update to $tag failed and was rolled back: $($_.Exception.Message)"
  }

  @{ tag = $tag; installedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
  Get-ChildItem -LiteralPath $releasesDirectory -Directory | Where-Object Name -ne $tag | Sort-Object LastWriteTime -Descending | Select-Object -Skip 1 | Remove-Item -Recurse -Force
  Remove-Item -LiteralPath $backup -Recurse -Force
  Write-Output "Installed and health-checked release $tag. Previous release retained for rollback."
} finally {
  if ($null -ne $lock) { $lock.Dispose() }
}
