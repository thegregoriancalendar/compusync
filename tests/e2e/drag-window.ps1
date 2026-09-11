param(
  [Parameter(Mandatory=$true)][int]$StartX,
  [Parameter(Mandatory=$true)][int]$StartY,
  [Parameter(Mandatory=$true)][int]$EndX,
  [Parameter(Mandatory=$true)][int]$EndY
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CompuSyncTestMouse {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
'@
[void][CompuSyncTestMouse]::SetThreadDpiAwarenessContext([IntPtr](-4))
$originalPoint = New-Object CompuSyncTestMouse+Point
[void][CompuSyncTestMouse]::GetCursorPos([ref]$originalPoint)
try {
  [void][CompuSyncTestMouse]::SetCursorPos($StartX, $StartY)
  Start-Sleep -Milliseconds 120
  [CompuSyncTestMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  for ($step = 1; $step -le 24; $step++) {
    $nextX = [int]($StartX + ($EndX - $StartX) * $step / 24)
    $nextY = [int]($StartY + ($EndY - $StartY) * $step / 24)
    [void][CompuSyncTestMouse]::SetCursorPos($nextX, $nextY)
    Start-Sleep -Milliseconds 20
  }
  Start-Sleep -Milliseconds 120
} finally {
  [CompuSyncTestMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  [void][CompuSyncTestMouse]::SetCursorPos($originalPoint.X, $originalPoint.Y)
}
