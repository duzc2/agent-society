# 生成 1024x1024 占位应用图标(System.Drawing,无需外部工具)
# 输出到项目根 tmp 目录(临时文件按约定放 tmp)
param(
    [string]$OutPath = (Join-Path $PSScriptRoot '..\..\tmp\app-icon.png')
)
Add-Type -AssemblyName System.Drawing
$size = 1024
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
$gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 79, 70, 229),
    [System.Drawing.Color]::FromArgb(255, 147, 51, 234),
    45
)
$g.FillEllipse($gradient, 0, 0, $size, $size)
$font = New-Object System.Drawing.Font('Segoe UI', 280, [System.Drawing.FontStyle]::Bold)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$g.DrawString('AS', $font, $white, (New-Object System.Drawing.RectangleF(0, 0, $size, $size)), $format)
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output "icon written: $OutPath"
