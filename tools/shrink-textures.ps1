# Rewrite the Renderpeople FBX files in public/ with their embedded 8K diffuse
# textures shrunk to 2K. Reads the originals from ..\SourceArt, resizes with
# System.Drawing, and splices the smaller JPEG back in with fbx-texture.mjs.
#
#   powershell -ExecutionPolicy Bypass -File tools\shrink-textures.ps1 [-Size 2048] [-Quality 90]

param(
  [int]$Size = 2048,
  [int]$Quality = 90,
  [string]$SourceDir = (Join-Path $PSScriptRoot '..\..\SourceArt'),
  [string]$OutputDir = (Join-Path $PSScriptRoot '..\public')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$tool = Join-Path $PSScriptRoot 'fbx-texture.mjs'
$work = Join-Path ([System.IO.Path]::GetTempPath()) 'character-poser-textures'
New-Item -ItemType Directory -Force $work | Out-Null

function Resize-Jpeg([string]$In, [string]$Out, [int]$Edge, [int]$JpegQuality) {
  $image = [System.Drawing.Image]::FromFile($In)
  try {
    $scale = $Edge / [Math]::Max($image.Width, $image.Height)
    $w = [Math]::Max(1, [int][Math]::Round($image.Width * $scale))
    $h = [Math]::Max(1, [int][Math]::Round($image.Height * $scale))
    $bitmap = New-Object System.Drawing.Bitmap $w, $h
    try {
      $g = [System.Drawing.Graphics]::FromImage($bitmap)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $g.DrawImage($image, 0, 0, $w, $h)
      $g.Dispose()
      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
      $params = New-Object System.Drawing.Imaging.EncoderParameters 1
      $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]$JpegQuality)
      $bitmap.Save($Out, $codec, $params)
    } finally { $bitmap.Dispose() }
    "  $($image.Width)x$($image.Height) -> ${w}x${h}"
  } finally { $image.Dispose() }
}

foreach ($fbx in Get-ChildItem (Join-Path $SourceDir '*.fbx')) {
  $name = [System.IO.Path]::GetFileNameWithoutExtension($fbx.Name)
  $original = Join-Path $work "$name.orig.jpg"
  $small = Join-Path $work "$name.$Size.jpg"
  $output = Join-Path $OutputDir $fbx.Name
  "$($fbx.Name)"
  node $tool extract $fbx.FullName $original
  if ($LASTEXITCODE -ne 0) { throw "extract failed for $($fbx.Name)" }
  Resize-Jpeg $original $small $Size $Quality
  node $tool replace $fbx.FullName $small $output
  if ($LASTEXITCODE -ne 0) { throw "replace failed for $($fbx.Name)" }
}
"Done. Work files are in $work"
