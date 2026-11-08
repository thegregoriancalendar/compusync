'use strict';

// Finds the folder a file drop should land in: the Finder / File Explorer
// window or the Desktop under the pointer. Returns null whenever that is not
// certain so the caller falls back to Downloads instead of guessing.

const childProcess = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');

const FINDER_TIMEOUT_MS = 2000;
// One line per Finder window that shows a real folder:
// id <TAB> left,top,right,bottom <TAB> POSIX path
const FINDER_WINDOWS_SCRIPT = `
tell application "Finder"
  set output to ""
  repeat with candidate in (every Finder window)
    try
      set b to bounds of candidate
      set output to output & (id of candidate) & tab & (item 1 of b) & "," & (item 2 of b) & "," & (item 3 of b) & "," & (item 4 of b) & tab & (POSIX path of (target of candidate as alias)) & linefeed
    end try
  end repeat
  return output
end tell`;

function parseFinderWindows(text) {
  const windows = [];
  for (const line of String(text).split('\n')) {
    const [id, bounds, folder] = line.split('\t');
    const [left, top, right, bottom] = String(bounds || '').split(',').map(Number);
    if (!/^\d+$/.test(id || '') || !folder || ![left, top, right, bottom].every(Number.isFinite)) continue;
    windows.push({ id, bounds: { x: left, y: top, width: right - left, height: bottom - top }, folder });
  }
  return windows;
}

const sameBounds = (a, b) => ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) <= 1);

// The CoreGraphics window list is front to back. Normal app windows live on
// layer 0; the Desktop (Finder's icon window, the wallpaper) below it.
// Windows above layer 0 are the menu bar, Dock, and floating panels — except
// full-screen transparent shields (the Dock keeps one), which are skipped.
function windowUnderPoint(windows, ownPid) {
  const displays = windows.filter((window) => window.layer < 0).map((window) => window.bounds);
  for (const window of windows) {
    if (window.pid === ownPid) continue;
    if (window.layer > 0) {
      if (displays.some((display) => sameBounds(display, window.bounds))) continue;
      return null;
    }
    if (window.layer === 0) return { kind: 'window', window };
    return windows.some((candidate) => candidate.layer < 0 && candidate.ownerName === 'Finder')
      ? { kind: 'desktop' } : null;
  }
  return null;
}

function runOsascript(execFile, script, timeout) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

async function macFolder(options) {
  const windows = options.native.windowsAtPoint?.(options.point);
  if (!Array.isArray(windows)) return null;
  const hit = windowUnderPoint(windows, options.ownPid);
  if (!hit) return null;
  if (hit.kind === 'desktop') return options.desktop || null;
  if (hit.window.ownerName !== 'Finder') return null;
  // Finder needs Automation consent; the first drop may raise the prompt and
  // fall back to Downloads while it is open.
  const finder = parseFinderWindows(await runOsascript(options.execFile, FINDER_WINDOWS_SCRIPT, options.timeout));
  const byId = finder.find((candidate) => candidate.id === hit.window.id);
  if (byId) return byId.folder;
  const byBounds = finder.filter((candidate) => sameBounds(candidate.bounds, hit.window.bounds));
  return byBounds.length === 1 ? byBounds[0].folder : null;
}

async function resolveDropFolder(options = {}) {
  const settings = {
    platform: process.platform, ownPid: process.pid, execFile: childProcess.execFile,
    timeout: FINDER_TIMEOUT_MS, ...options,
  };
  if (!settings.native || !settings.point) return null;
  let folder = null;
  if (settings.platform === 'darwin') folder = await macFolder(settings);
  else if (settings.platform === 'win32' && typeof settings.native.folderAtPoint === 'function') {
    folder = await settings.native.folderAtPoint(settings.point);
  }
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return null;
  try {
    return (await fsp.stat(folder)).isDirectory() ? path.resolve(folder) : null;
  } catch { return null; }
}

module.exports = { resolveDropFolder, windowUnderPoint, parseFinderWindows, FINDER_WINDOWS_SCRIPT };
