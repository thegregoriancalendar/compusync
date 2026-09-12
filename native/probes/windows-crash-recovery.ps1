param(
  [string]$Addon = (Join-Path $PSScriptRoot '..\compusync-native.win32-x64.node'),
  [string]$Guard = (Join-Path $PSScriptRoot '..\target\release\compusync-recovery-guard.exe')
)

$ErrorActionPreference = 'Stop'
$addonPath = (Resolve-Path -LiteralPath $Addon).Path
$childPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'crash-child.cjs')).Path
$guardPath = (Resolve-Path -LiteralPath $Guard).Path

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CompuSyncCrashProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO {
    public int Size, Flags; public IntPtr Cursor; public POINT ScreenPosition;
  }
  [DllImport("user32.dll")] public static extern bool ClipCursor(IntPtr rect);
  [DllImport("user32.dll")] public static extern bool GetClipCursor(out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO info);
  [DllImport("user32.dll")] public static extern int ShowCursor(bool show);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
'@

function Read-State {
  $clip = New-Object CompuSyncCrashProbe+RECT
  [void][CompuSyncCrashProbe]::GetClipCursor([ref]$clip)
  $cursor = New-Object CompuSyncCrashProbe+CURSORINFO
  $cursor.Size = [Runtime.InteropServices.Marshal]::SizeOf($cursor)
  [void][CompuSyncCrashProbe]::GetCursorInfo([ref]$cursor)
  $virtual = [pscustomobject]@{
    Left = [CompuSyncCrashProbe]::GetSystemMetrics(76)
    Top = [CompuSyncCrashProbe]::GetSystemMetrics(77)
    Right = [CompuSyncCrashProbe]::GetSystemMetrics(76) + [CompuSyncCrashProbe]::GetSystemMetrics(78)
    Bottom = [CompuSyncCrashProbe]::GetSystemMetrics(77) + [CompuSyncCrashProbe]::GetSystemMetrics(79)
  }
  [pscustomobject]@{
    Clip = $clip
    CursorVisible = [bool]($cursor.Flags -band 1)
    ClipReleased = $clip.Left -eq $virtual.Left -and $clip.Top -eq $virtual.Top -and
      $clip.Right -eq $virtual.Right -and $clip.Bottom -eq $virtual.Bottom
  }
}

$baseline = Read-State
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = (Get-Command node).Source
$start.Arguments = '"' + $childPath + '" "' + $addonPath + '" "' + $guardPath + '"'
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.CreateNoWindow = $true
$child = [Diagnostics.Process]::Start($start)
try {
  $ready = $child.StandardOutput.ReadLine()
  if ($ready -ne 'READY') { throw "Crash child failed to initialize: $ready" }
  Start-Sleep -Milliseconds 150
  $armed = Read-State
  $child.Kill()
  [void]$child.WaitForExit(2000)
  Start-Sleep -Milliseconds 500
  $recovered = Read-State
  $cursorVisibilityObservable = $baseline.CursorVisible
  $cursorHideObserved = (-not $cursorVisibilityObservable) -or (-not $armed.CursorVisible)
  $cursorVisibilityRecovered = (-not $cursorVisibilityObservable) -or $recovered.CursorVisible
  [pscustomobject]@{
    ChildPid = $child.Id
    BaselineCursorVisible = $baseline.CursorVisible
    ArmedClipReleased = $armed.ClipReleased
    ArmedCursorVisible = $armed.CursorVisible
    RecoveredClipReleased = $recovered.ClipReleased
    RecoveredCursorVisible = $recovered.CursorVisible
    CursorVisibilityObservable = $cursorVisibilityObservable
    CursorHideObserved = $cursorHideObserved
    CursorVisibilityRecovered = $cursorVisibilityRecovered
    Passed = (-not $armed.ClipReleased) -and $recovered.ClipReleased -and
      $cursorHideObserved -and $cursorVisibilityRecovered
  }
} finally {
  if (-not $child.HasExited) { $child.Kill(); [void]$child.WaitForExit(2000) }
  [void][CompuSyncCrashProbe]::ClipCursor([IntPtr]::Zero)
  for ($i = 0; $i -lt 32; $i++) { if ([CompuSyncCrashProbe]::ShowCursor($true) -ge 0) { break } }
}
