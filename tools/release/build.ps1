# Builds the Windows helper release and publishes it so the backend can serve it:
#   /api/helper/latest  -> latest.json (version, file, sha256)
#   /api/helper/download -> /helper/<versioned exe>
#
# Usage (from the repo root):
#   powershell -ExecutionPolicy Bypass -File tools/release/build.ps1
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$helperDir = Join-Path $root 'helper'
$outDir = Join-Path $root 'server\public\helper'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

# --- version (single source: Cargo.toml) -----------------------------------
$cargoToml = Get-Content (Join-Path $helperDir 'Cargo.toml') -Raw
if ($cargoToml -notmatch 'version\s*=\s*"([^"]+)"') {
  throw "version not found in helper/Cargo.toml"
}
$version = $Matches[1]

# --- build ----------------------------------------------------------------
Write-Host "[release] cargo build --release (v$version)..."
Push-Location $helperDir
try {
  cargo build --release
} finally {
  Pop-Location
}
if ($LASTEXITCODE -ne 0) { throw 'cargo build --release failed' }

$src = Join-Path $helperDir 'target\release\golive-helper.exe'
if (-not (Test-Path $src)) { throw "release exe not found: $src" }

# --- publish --------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$file = "golive-helper-$version-windows-x64.exe"
Copy-Item $src (Join-Path $outDir $file) -Force

$hash = (Get-FileHash (Join-Path $outDir $file) -Algorithm SHA256).Hash.ToLowerInvariant()

$latest = @{ version = $version; file = $file; sha256 = $hash } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText((Join-Path $outDir 'latest.json'), $latest, $utf8NoBom)

Write-Host "[release] published server/public/helper/$file (sha256 $hash)"
Write-Host "[release] backend endpoints live: /api/helper/latest | /api/helper/download"