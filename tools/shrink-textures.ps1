# Rewrite the Renderpeople FBX files in public/ with external lossless 2K PNG
# diffuse textures. Reads the originals from ..\SourceArt, resizes with
# System.Drawing, and removes the embedded image payloads with fbx-texture.mjs.
#
#   powershell -ExecutionPolicy Bypass -File tools\shrink-textures.ps1 [-Size 2048]

param(
  [int]$Size = 2048,
  [string]$SourceDir = (Join-Path $PSScriptRoot '..\..\SourceArt'),
  [string]$OutputDir = (Join-Path $PSScriptRoot '..\public')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$tool = Join-Path $PSScriptRoot 'fbx-texture.mjs'
$work = Join-Path ([System.IO.Path]::GetTempPath()) 'character-poser-textures'
New-Item -ItemType Directory -Force $work | Out-Null
New-Item -ItemType Directory -Force $OutputDir | Out-Null

function Resize-Png([string]$In, [string]$Out, [int]$Edge) {
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
      $bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $bitmap.Dispose() }
    "  $($image.Width)x$($image.Height) -> ${w}x${h}"
  } finally { $image.Dispose() }
}

function Get-AssetName([string]$Name) {
  switch -Regex ($Name.ToLowerInvariant()) {
    'carla' { return 'carla' }
    'claudia' { return 'claudia' }
    'eric' { return 'eric' }
    'rin|ruth' { return 'ruth' }
    'neil|scooter' { return 'scooter' }
    default { throw "No canonical character name is configured for $Name" }
  }
}

foreach ($fbx in Get-ChildItem (Join-Path $SourceDir '*.fbx')) {
  $name = Get-AssetName $fbx.BaseName
  $original = Join-Path $work "$name.orig"
  $small = Join-Path $work "$name.$Size.png"
  $output = Join-Path $OutputDir "$name.fbx"
  $textureName = "$name.png"
  "$($fbx.Name)"
  node $tool extract $fbx.FullName $original
  if ($LASTEXITCODE -ne 0) { throw "extract failed for $($fbx.Name)" }
  Resize-Png $original $small $Size
  node $tool externalize $fbx.FullName $output $OutputDir '.' $small $textureName
  if ($LASTEXITCODE -ne 0) { throw "externalize failed for $($fbx.Name)" }
}
"Done. Work files are in $work"
