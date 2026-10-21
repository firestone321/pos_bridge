[CmdletBinding()]
param(
  [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $projectRoot 'release'
}
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$releaseName = "smokehouse-pos-bridge-$($package.version)-production"
$stageName = "$releaseName-stage-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$stagingDirectory = Join-Path $OutputDirectory $stageName
$archivePath = Join-Path $OutputDirectory "$releaseName.zip"

if (Test-Path -LiteralPath $stagingDirectory) { throw "Release folder already exists: $stagingDirectory" }
if (Test-Path -LiteralPath $archivePath) { throw "Release archive already exists: $archivePath" }

& npm run build
if ($LASTEXITCODE -ne 0) { throw 'Bridge build failed.' }

New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'dist') -Destination $stagingDirectory -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts') -Destination $stagingDirectory -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'package.json') -Destination $stagingDirectory
Copy-Item -LiteralPath (Join-Path $projectRoot 'package-lock.json') -Destination $stagingDirectory
Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination $stagingDirectory
Copy-Item -LiteralPath (Join-Path $projectRoot 'PRODUCTION-SETUP.md') -Destination $stagingDirectory
# Keep device-specific production credentials and printer settings on the target
# computer. Release archives must contain code and dependencies only.
@{ tag = "v$($package.version)"; version = $package.version } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stagingDirectory 'release.json') -Encoding utf8

Push-Location $stagingDirectory
try {
  & npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed.' }
} finally {
  Pop-Location
}

Compress-Archive -Path (Join-Path $stagingDirectory '*') -DestinationPath $archivePath -CompressionLevel Optimal
$hash = Get-FileHash -LiteralPath $archivePath -Algorithm SHA256
Write-Output "Release folder: $stagingDirectory"
Write-Output "Release archive: $archivePath"
Write-Output "SHA256: $($hash.Hash)"
Set-Content -LiteralPath "$archivePath.sha256" -Value "$($hash.Hash)  $releaseName.zip" -Encoding ascii
