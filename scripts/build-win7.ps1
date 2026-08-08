[CmdletBinding()]
param(
  [string]$OutputZip = '',
  [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'package.win7.json') | ConvertFrom-Json
$releaseVersion = if ($Version) { $Version.TrimStart('v') } else { [string]$package.version }
if ($releaseVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Win7 package version must be valid semver.' }
$defaultZip = Join-Path $repoRoot ('dist\PancakeDesktopAIShortcutBot-{0}-Win7-x64.zip' -f $releaseVersion)
$zipPath = if ($OutputZip) { [IO.Path]::GetFullPath($OutputZip) } else { $defaultZip }
$outputDirectory = Split-Path -Parent $zipPath
$stageRoot = Join-Path ([IO.Path]::GetTempPath()) ("pancake-win7-build-{0}" -f $PID)
$stage = Join-Path $stageRoot 'PancakeDesktopAIShortcutBot-v3-Win7'

function Copy-RequiredPath([string]$relativePath) {
  $source = Join-Path $repoRoot $relativePath
  $destination = Join-Path $stage $relativePath
  if (-not (Test-Path -LiteralPath $source)) { throw "Missing required path: $relativePath" }
  $parent = Split-Path -Parent $destination
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

try {
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm.cmd is required on the build machine.' }
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'node.exe is required on the build machine.' }

  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  Copy-RequiredPath 'src'
  Copy-RequiredPath 'extensions'
  Copy-RequiredPath 'package.win7.json'
  Copy-RequiredPath 'package.win7-lock.json'
  Copy-RequiredPath 'scripts/win7-updater.js'
  Copy-RequiredPath 'start-win7.bat'
  Copy-RequiredPath '.env.example'
  Copy-RequiredPath 'README.md'

  if ($Version) {
    & node (Join-Path $repoRoot 'scripts/set-release-version.js') --version $releaseVersion --file (Join-Path $stage 'package.win7.json') --file (Join-Path $stage 'package.win7-lock.json')
    if ($LASTEXITCODE -ne 0) { throw "Failed to set staged release version: $LASTEXITCODE" }
  }

  $launcher = Get-Content -Raw -LiteralPath (Join-Path $stage 'start-win7.bat')
  if ($launcher -notmatch 'electron\.exe"\s+"%~dp0\.') { throw 'Win7 launcher must pass the app directory as "%~dp0.".' }
  if ($launcher -match 'electron\.exe"\s+"%~dp0"') { throw 'Win7 launcher contains the unsafe trailing-quote app path.' }

  & node (Join-Path $repoRoot 'scripts/audit-artifact.js') $stage
  if ($LASTEXITCODE -ne 0) { throw "Artifact audit failed with exit code $LASTEXITCODE" }

  Move-Item -LiteralPath (Join-Path $stage 'package.win7.json') -Destination (Join-Path $stage 'package.json') -Force
  Move-Item -LiteralPath (Join-Path $stage 'package.win7-lock.json') -Destination (Join-Path $stage 'package-lock.json') -Force

  Push-Location $stage
  try {
    & npm.cmd ci --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }

  $electronPath = Join-Path $stage 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path -LiteralPath $electronPath)) { throw 'Electron 22 runtime was not installed into the staging directory.' }

  New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -CompressionLevel Optimal
  Write-Output "Created $zipPath"
} finally {
  if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
}
