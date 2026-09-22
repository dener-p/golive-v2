# Regenerates helper/assets/tray.png (32x32 RGBA) from web/public/favicon.png.
# Run after updating the favicon, then commit the regenerated tray.png.
# Requires the .NET System.Drawing assembly (Windows PowerShell 5.1).
$ErrorActionPreference = 'Stop'

$srcPath = Resolve-Path 'web\public\favicon.png'
$outDir = Join-Path (Resolve-Path '.').Path 'helper\assets'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$outPath = Join-Path $outDir 'tray.png'

Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile($srcPath.Path)
$bmp = New-Object System.Drawing.Bitmap 32, 32, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($src, 0, 0, 32, 32)
} finally {
    $g.Dispose()
    $src.Dispose()
}
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "wrote $outPath"