param(
  [ValidateSet('inspect', 'offscreen', 'uia')]
  [string]$Mode = 'inspect',
  [switch]$Execute
)

$ErrorActionPreference = 'Stop'
$chromeCandidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $chrome) { throw 'Google Chrome is not installed in a standard location.' }

if ($Mode -eq 'inspect') {
  [pscustomobject]@{
    Chrome = $chrome
    Running = [bool](Get-Process chrome -ErrorAction SilentlyContinue)
    Note = 'offscreen and uia modes use a disposable isolated profile and require -Execute'
  }
  exit 0
}
if (-not $Execute) { throw "The $Mode probe launches a disposable isolated Chrome. Re-run with -Execute." }

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CompuSyncProbeNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hgt, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT rect);
}
'@

$probeId = [guid]::NewGuid().ToString('N')
$profile = Join-Path $env:TEMP "compusync-chrome-probe-$probeId"
$startedAt = Get-Date
$arguments = @(
  "--user-data-dir=$profile", '--remote-debugging-port=9249', '--remote-debugging-address=127.0.0.1',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--new-window',
  'https://example.com/', 'https://example.org/'
)
$launcher = Start-Process -FilePath $chrome -ArgumentList $arguments -WindowStyle Hidden -PassThru
try {
  $windowProcess = $null
  for ($attempt = 0; $attempt -lt 50 -and -not $windowProcess; $attempt++) {
    Start-Sleep -Milliseconds 100
    $windowProcess = Get-Process chrome -ErrorAction SilentlyContinue |
      Where-Object { $_.StartTime -ge $startedAt.AddSeconds(-2) -and $_.MainWindowHandle -ne 0 } |
      Select-Object -First 1
  }
  if (-not $windowProcess) { throw 'Disposable Chrome did not create a top-level window.' }
  $handle = [IntPtr]$windowProcess.MainWindowHandle

  if ($Mode -eq 'offscreen') {
    $before = New-Object CompuSyncProbeNative+RECT
    $after = New-Object CompuSyncProbeNative+RECT
    [void][CompuSyncProbeNative]::GetWindowRect($handle, [ref]$before)
    $width = $before.Right - $before.Left
    $height = $before.Bottom - $before.Top
    [void][CompuSyncProbeNative]::SetWindowPos($handle, [IntPtr]::Zero, -20000, $before.Top, $width, $height, 0x0014)
    Start-Sleep -Milliseconds 250
    [void][CompuSyncProbeNative]::GetWindowRect($handle, [ref]$after)
    [void][CompuSyncProbeNative]::SetWindowPos($handle, [IntPtr]::Zero, $before.Left, $before.Top, $width, $height, 0x0014)
    [pscustomobject]@{
      RequestedX = -20000
      ActualX = $after.Left
      Width = $after.Right - $after.Left
      FullyOffscreen = $after.Right -lt -1000
      ProfileLeftForInspection = $profile
    }
  } else {
    Add-Type -AssemblyName UIAutomationClient
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    $all = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    $tabs = @()
    $addressValues = @()
    foreach ($element in $all) {
      if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::TabItem) {
        $tabs += $element.Current.Name
      }
      $pattern = $null
      if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        $value = ([System.Windows.Automation.ValuePattern]$pattern).Current.Value
        if ($value -match '^https?://') { $addressValues += $value }
      }
    }
    [pscustomobject]@{
      TabTitles = $tabs
      ExposedHttpValues = $addressValues
      BackgroundTabUrlsAvailable = $addressValues.Count -ge 2
      ProfileLeftForInspection = $profile
    }
  }
} finally {
  # Terminate only processes whose command line names this exact disposable profile.
  Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
    Where-Object { $_.CommandLine -like "*$profile*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if (-not $launcher.HasExited) { Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue }
}
