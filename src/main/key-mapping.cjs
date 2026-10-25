'use strict';

const CONTROL = 2;
const META = 8;
const SHIFT = 1;
const ALT = 4;
// Common application shortcuts, not every use of Control/Command. In particular,
// preserve Ctrl+C in Mac terminals and Ctrl+Alt combinations such as AltGr.
const COMMON_KEYS = new Set([0x04, 0x06, 0x09, 0x11, 0x12, 0x13, 0x16, 0x19, 0x1B, 0x1D]);

function platformName(value) {
  if (value === 'win32' || value === 'windows') return 'win32';
  if (value === 'darwin' || value === 'macos') return 'darwin';
  return null;
}

// A held modifier alone has no shortcut meaning yet (including during handoff).
function mapModifiers(modifiers) { return modifiers; }

// Functional equivalents from Apple's Windows keys on a Mac keyboard guide.
// https://support.apple.com/guide/mac-help/windows-keys-on-a-mac-keyboard-cpmh0152/mac
function mapKeyEvent(message, sourcePlatform, destinationPlatform) {
  const source = platformName(sourcePlatform);
  const destination = platformName(destinationPlatform);
  if (!source || !destination || source === destination) return message;
  let { code, modifiers } = message;
  const rest = modifiers & ~SHIFT;
  if (source === 'win32') {
    if (COMMON_KEYS.has(code) && rest === CONTROL) modifiers = (modifiers & ~CONTROL) | META;
    else if (code === 0x4A || code === 0x4D) {
      if (rest === 0 || rest === CONTROL) {
        code = rest === CONTROL ? (code === 0x4A ? 0x52 : 0x51) : (code === 0x4A ? 0x50 : 0x4F);
        modifiers = (modifiers & ~CONTROL) | META;
      }
    } else if ((code === 0x50 || code === 0x4F || code === 0x2A || code === 0x4C) && rest === CONTROL) {
      modifiers = (modifiers & ~CONTROL) | ALT;
    } else if (code === 0x16 && modifiers === (SHIFT | META)) {
      code = 0x21; // Windows region capture -> Shift-Command-4
    } else if (code === 0x46 && modifiers === 0) {
      code = 0x20; modifiers = SHIFT | META; // full-screen screenshot
    } else if (code === 0x47 && modifiers === 0) {
      code = 0x69; modifiers = CONTROL; // Control-F14
    }
  } else {
    if (COMMON_KEYS.has(code) && rest === META) modifiers = (modifiers & ~META) | CONTROL;
    else if ([0x50, 0x4F, 0x52, 0x51].includes(code) && rest === META) {
      const codes = { 0x50: 0x4A, 0x4F: 0x4D, 0x52: 0x4A, 0x51: 0x4D };
      const document = code === 0x52 || code === 0x51;
      code = codes[code]; modifiers = (modifiers & ~META) | (document ? CONTROL : 0);
    } else if ([0x50, 0x4F, 0x2A, 0x4C].includes(code) && rest === ALT) {
      modifiers = (modifiers & ~ALT) | CONTROL;
    } else if (code === 0x21 && modifiers === (SHIFT | META)) {
      code = 0x16; // Shift-Command-4 -> Windows-Shift-S
    } else if (code === 0x20 && modifiers === (SHIFT | META)) {
      code = 0x46; modifiers = 0;
    } else if (code === 0x69 && modifiers === CONTROL) {
      code = 0x47; modifiers = 0;
    } else if (code === 0x53 && modifiers === SHIFT) {
      modifiers = 0; // Shift-Clear -> Num Lock
    } else if (code === 0x2C && modifiers === META) {
      code = 0xE3; modifiers = META; // Spotlight -> Start
    }
  }
  const mapped = { ...message, code, modifiers };
  if (source === 'win32' && (code === 0xE3 || code === 0xE7) && !message.down) {
    mapped.shortcutOnTap = { code: 0x2C, modifiers: META }; // Start -> Spotlight
  }
  return mapped;
}

module.exports = { CONTROL, META, platformName, mapModifiers, mapKeyEvent };
