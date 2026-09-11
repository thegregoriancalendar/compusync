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
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetPhysicalCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool GetPhysicalCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
'@
[void][CompuSyncTestMouse]::SetThreadDpiAwarenessContext([IntPtr](-4))
$originalPoint = New-Object CompuSyncTestMouse+Point
[void][CompuSyncTestMouse]::GetPhysicalCursorPos([ref]$originalPoint)
try {
  if (-not [CompuSyncTestMouse]::SetPhysicalCursorPos($StartX, $StartY)) { throw "Cannot move the desktop pointer: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  Start-Sleep -Milliseconds 120
  [CompuSyncTestMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  for ($step = 1; $step -le 24; $step++) {
    $nextX = [int]($StartX + ($EndX - $StartX) * $step / 24)
    $nextY = [int]($StartY + ($EndY - $StartY) * $step / 24)
    [void][CompuSyncTestMouse]::SetPhysicalCursorPos($nextX, $nextY)
    Start-Sleep -Milliseconds 20
  }
  Start-Sleep -Milliseconds 120
} finally {
  [CompuSyncTestMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  [void][CompuSyncTestMouse]::SetPhysicalCursorPos($originalPoint.X, $originalPoint.Y)
}
