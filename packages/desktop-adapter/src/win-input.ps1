# Desktop input/capture helper for Swarm QA on Windows.
# Usage: powershell -File win-input.ps1 -Action <name> [-Payload <base64 JSON>]   → prints one JSON object.
param([string]$Action, [string]$Payload = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SwarmInput {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
"@
[SwarmInput]::SetProcessDPIAware() | Out-Null

$p = @{}
if ($Payload) { $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json }
function Out-Result($value) { $value | ConvertTo-Json -Compress -Depth 5 }
function Has($name) { return $null -ne $p.PSObject.Properties[$name] -and $null -ne $p.$name }

function Get-Pointer {
    $pt = New-Object SwarmInput+POINT
    [SwarmInput]::GetCursorPos([ref]$pt) | Out-Null
    return @{ x = $pt.X; y = $pt.Y }
}
# Glides the pointer along an eased path so a person watching can follow it.
function Move-Smooth([int]$x, [int]$y) {
    $from = Get-Pointer
    $steps = 14
    for ($i = 1; $i -le $steps; $i++) {
        $eased = 1 - [math]::Pow(1 - ($i / $steps), 3)
        [SwarmInput]::SetCursorPos([int]($from.x + ($x - $from.x) * $eased), [int]($from.y + ($y - $from.y) * $eased)) | Out-Null
        Start-Sleep -Milliseconds 8
    }
}
$buttons = @{ left = @(0x2, 0x4); right = @(0x8, 0x10); middle = @(0x20, 0x40) }
$vk = @{
    ctrl = 0x11; control = 0x11; shift = 0x10; alt = 0x12; win = 0x5B; meta = 0x5B; super = 0x5B; cmd = 0x5B
    enter = 0x0D; return = 0x0D; tab = 0x09; esc = 0x1B; escape = 0x1B; space = 0x20; backspace = 0x08; delete = 0x2E; del = 0x2E; insert = 0x2D
    left = 0x25; up = 0x26; right = 0x27; down = 0x28; arrowleft = 0x25; arrowup = 0x26; arrowright = 0x27; arrowdown = 0x28
    home = 0x24; end = 0x23; pageup = 0x21; pagedown = 0x22
}
function Get-Vk([string]$name) {
    $key = $name.Trim().ToLower()
    if ($vk.ContainsKey($key)) { return [byte]$vk[$key] }
    if ($key -match '^f(\d{1,2})$') { return [byte](0x6F + [int]$Matches[1]) }
    if ($key.Length -eq 1) { return [byte][char]$key.ToUpper() }
    throw "Unknown key: $name"
}

switch ($Action) {
    'status' {
        $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
        Out-Result @{ width = $b.Width; height = $b.Height; originX = $b.X; originY = $b.Y; pointer = (Get-Pointer) }
    }
    'move' { Move-Smooth $p.x $p.y; Out-Result (Get-Pointer) }
    'click' {
        if ((Has 'x') -and (Has 'y')) { Move-Smooth $p.x $p.y }
        $name = 'left'; if (Has 'button') { $name = [string]$p.button }
        $flags = $buttons[$name]; if (-not $flags) { $flags = $buttons['left'] }
        $count = 1; if (Has 'count') { $count = [math]::Max(1, [int]$p.count) }
        for ($i = 0; $i -lt $count; $i++) {
            [SwarmInput]::mouse_event($flags[0], 0, 0, 0, [UIntPtr]::Zero)
            [SwarmInput]::mouse_event($flags[1], 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 80
        }
        Out-Result (Get-Pointer)
    }
    'drag' {
        Move-Smooth $p.fromX $p.fromY
        [SwarmInput]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 80
        Move-Smooth $p.toX $p.toY
        Start-Sleep -Milliseconds 80; [SwarmInput]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
        Out-Result (Get-Pointer)
    }
    'scroll' {
        if ((Has 'x') -and (Has 'y')) { Move-Smooth $p.x $p.y }
        # Positive deltaY scrolls down (web convention); Windows wheel data is positive for up, 120 per notch.
        if ((Has 'deltaY') -and $p.deltaY -ne 0) { [SwarmInput]::mouse_event(0x800, 0, 0, [int](-1 * $p.deltaY * 1.2), [UIntPtr]::Zero) }
        if ((Has 'deltaX') -and $p.deltaX -ne 0) { [SwarmInput]::mouse_event(0x1000, 0, 0, [int]($p.deltaX * 1.2), [UIntPtr]::Zero) }
        Out-Result @{ ok = $true }
    }
    'type' {
        # SendKeys treats + ^ % ~ ( ) { } [ ] as commands: wrap each in braces to type it literally.
        $text = [regex]::Replace([string]$p.text, '[+^%~(){}\[\]]', { param($m) '{' + $m.Value + '}' })
        $text = $text -replace "`r`n", '{ENTER}' -replace "`n", '{ENTER}' -replace "`t", '{TAB}'
        [System.Windows.Forms.SendKeys]::SendWait($text)
        Out-Result @{ ok = $true }
    }
    'key' {
        $codes = @(([string]$p.keys).Split('+') | Where-Object { $_.Trim() } | ForEach-Object { Get-Vk $_ })
        foreach ($code in $codes) { [SwarmInput]::keybd_event($code, 0, 0, [UIntPtr]::Zero) }
        Start-Sleep -Milliseconds 40
        [array]::Reverse($codes)
        foreach ($code in $codes) { [SwarmInput]::keybd_event($code, 0, 0x2, [UIntPtr]::Zero) }
        Out-Result @{ ok = $true }
    }
    'screenshot' {
        $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $x = $b.X; $y = $b.Y; $w = $b.Width; $h = $b.Height
        if (Has 'region') { $x = [int]$p.region.x; $y = [int]$p.region.y; $w = [int]$p.region.width; $h = [int]$p.region.height }
        $bmp = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
        $g.Dispose()
        if ((Has 'maxWidth') -and $p.maxWidth -gt 0 -and $w -gt $p.maxWidth) {
            $nh = [int]($h * $p.maxWidth / $w)
            $small = New-Object System.Drawing.Bitmap $bmp, ([int]$p.maxWidth), $nh
            $bmp.Dispose(); $bmp = $small
        }
        $quality = 60; if (Has 'quality') { $quality = [int]$p.quality }
        $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
        $params = New-Object System.Drawing.Imaging.EncoderParameters 1
        $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, $codec, $params)
        Out-Result @{ data = [Convert]::ToBase64String($ms.ToArray()); mimeType = 'image/jpeg'; width = $bmp.Width; height = $bmp.Height }
        $bmp.Dispose()
    }
    default { throw "Unknown action: $Action" }
}
