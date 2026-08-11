$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$src = Join-Path $root 'public\app-icon.png'

if (-not (Test-Path -LiteralPath $src)) {
  throw "Missing app icon source: $src"
}

Add-Type -AssemblyName System.Drawing

function Save-ResizedPng {
  param(
    [string]$Source,
    [string]$Dest,
    [int]$Size
  )

  $img = [System.Drawing.Image]::FromFile($Source)
  try {
    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.DrawImage($img, 0, 0, $Size, $Size)
      } finally {
        $graphics.Dispose()
      }
      $bmp.Save($Dest, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $bmp.Dispose()
    }
  } finally {
    $img.Dispose()
  }
}

function Save-AdaptiveForegroundPng {
  param(
    [string]$Source,
    [string]$Dest,
    [int]$Size
  )

  $img = [System.Drawing.Image]::FromFile($Source)
  try {
    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.Clear([System.Drawing.Color]::Transparent)

        # Android adaptive icons render a 108dp layer through a roughly 72dp
        # safe mask. Drawing the complete square edge-to-edge here makes the
        # launcher crop its center and the icon appears incorrectly zoomed.
        $drawSize = [int][Math]::Round($Size * (2.0 / 3.0))
        $offset = [int][Math]::Round(($Size - $drawSize) / 2.0)
        $cornerDiameter = [int][Math]::Round($drawSize * 0.24)
        $right = $offset + $drawSize - $cornerDiameter
        $bottom = $offset + $drawSize - $cornerDiameter
        $clip = New-Object System.Drawing.Drawing2D.GraphicsPath
        try {
          $clip.AddArc($offset, $offset, $cornerDiameter, $cornerDiameter, 180, 90)
          $clip.AddArc($right, $offset, $cornerDiameter, $cornerDiameter, 270, 90)
          $clip.AddArc($right, $bottom, $cornerDiameter, $cornerDiameter, 0, 90)
          $clip.AddArc($offset, $bottom, $cornerDiameter, $cornerDiameter, 90, 90)
          $clip.CloseFigure()
          $graphics.SetClip($clip)
          $graphics.DrawImage($img, $offset, $offset, $drawSize, $drawSize)
        } finally {
          $clip.Dispose()
        }
      } finally {
        $graphics.Dispose()
      }
      $bmp.Save($Dest, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $bmp.Dispose()
    }
  } finally {
    $img.Dispose()
  }
}

$launcherSizes = @{
  'mipmap-mdpi' = 48
  'mipmap-hdpi' = 72
  'mipmap-xhdpi' = 96
  'mipmap-xxhdpi' = 144
  'mipmap-xxxhdpi' = 192
}

foreach ($entry in $launcherSizes.GetEnumerator()) {
  $dir = Join-Path $root "android\app\src\main\res\$($entry.Key)"
  Save-ResizedPng $src (Join-Path $dir 'ic_launcher.png') $entry.Value
  Save-ResizedPng $src (Join-Path $dir 'ic_launcher_round.png') $entry.Value
}

$foregroundSizes = @{
  'mipmap-mdpi' = 108
  'mipmap-hdpi' = 162
  'mipmap-xhdpi' = 216
  'mipmap-xxhdpi' = 324
  'mipmap-xxxhdpi' = 432
}

foreach ($entry in $foregroundSizes.GetEnumerator()) {
  $dir = Join-Path $root "android\app\src\main\res\$($entry.Key)"
  Save-AdaptiveForegroundPng $src (Join-Path $dir 'ic_launcher_foreground.png') $entry.Value
}

$backgroundXml = Join-Path $root 'android\app\src\main\res\values\ic_launcher_background.xml'
if (Test-Path -LiteralPath $backgroundXml) {
  [System.IO.File]::WriteAllText(
    $backgroundXml,
    "<?xml version=`"1.0`" encoding=`"utf-8`"?>`r`n<resources>`r`n    <color name=`"ic_launcher_background`">#DDF7EF</color>`r`n</resources>`r`n",
    [System.Text.UTF8Encoding]::new($false)
  )
}

Write-Host "[sync-android-icon] Android launcher icons updated from public/app-icon.png"
