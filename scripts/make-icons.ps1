Add-Type -AssemblyName System.Drawing

function New-Mark([int]$size, [bool]$transparent) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  if ($transparent) {
    $g.Clear([System.Drawing.Color]::Transparent)
  } else {
    $g.Clear([System.Drawing.Color]::FromArgb(255, 0, 0, 0))
  }
  $pad = $size * 0.22
  $penW = [Math]::Max(2, $size * 0.045)
  $cyan = [System.Drawing.Color]::FromArgb(255, 0, 240, 255)
  $pink = [System.Drawing.Color]::FromArgb(255, 255, 0, 85)
  $pen = New-Object System.Drawing.Pen $cyan, $penW
  $pen.StartCap = 'Round'
  $pen.EndCap = 'Round'
  $g.DrawEllipse($pen, $pad, $pad, $size - 2 * $pad, $size - 2 * $pad)
  $cut = New-Object System.Drawing.Pen $pink, ($penW * 1.35)
  $cut.StartCap = 'Round'
  $cut.EndCap = 'Round'
  $a = $size * 0.30
  $b = $size * 0.70
  $g.DrawLine($cut, $b, $a, $a, $b)
  $g.Dispose()
  return $bmp
}

function Save-Png($bmp, $path) {
  $dir = Split-Path $path
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$res = Join-Path $PSScriptRoot "..\android\app\src\main\res"
$legacy = @{ mdpi = 48; hdpi = 72; xhdpi = 96; xxhdpi = 144; xxxhdpi = 192 }
$fg = @{ mdpi = 108; hdpi = 162; xhdpi = 216; xxhdpi = 324; xxxhdpi = 432 }

foreach ($d in $legacy.Keys) {
  $n = $legacy[$d]
  $dir = Join-Path $res "mipmap-$d"
  Save-Png (New-Mark $n $false) (Join-Path $dir "ic_launcher.png")
  Save-Png (New-Mark $n $false) (Join-Path $dir "ic_launcher_round.png")
  Save-Png (New-Mark $fg[$d] $true) (Join-Path $dir "ic_launcher_foreground.png")
}

$store = Join-Path $PSScriptRoot "..\store-assets"
Save-Png (New-Mark 512 $false) (Join-Path $store "play-icon-512.png")

Get-ChildItem (Join-Path $res "drawable*") -Filter "splash.png" -Recurse | ForEach-Object {
  $img = [System.Drawing.Image]::FromFile($_.FullName)
  $w = $img.Width
  $h = $img.Height
  $img.Dispose()
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Black)
  $g.Dispose()
  $bmp.Save($_.FullName, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

Write-Output "icons written"
