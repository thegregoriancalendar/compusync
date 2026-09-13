'use strict';

const CONTROL = 2;
const META = 8;
const WINDOWS_TO_MAC_CODES = Object.freeze({
  0xE0: 0xE3,
  0xE4: 0xE7,
  0xE3: 0xE0,
  0xE7: 0xE4,
});

function platformName(value) {
  if (value === 'win32' || value === 'windows') return 'win32';
  if (value === 'darwin' || value === 'macos') return 'darwin';
  return null;
}

function shouldMapWindowsToMac(sourcePlatform, destinationPlatform) {
  return platformName(sourcePlatform) === 'win32' && platformName(destinationPlatform) === 'darwin';
}

function mapModifiers(modifiers, sourcePlatform, destinationPlatform) {
  if (!shouldMapWindowsToMac(sourcePlatform, destinationPlatform)) return modifiers;
  return (modifiers & ~(CONTROL | META))
    | (modifiers & CONTROL ? META : 0)
    | (modifiers & META ? CONTROL : 0);
}

function mapKeyEvent(message, sourcePlatform, destinationPlatform) {
  if (!shouldMapWindowsToMac(sourcePlatform, destinationPlatform)) return message;
  return {
    ...message,
    code: WINDOWS_TO_MAC_CODES[message.code] ?? message.code,
    modifiers: mapModifiers(message.modifiers, sourcePlatform, destinationPlatform),
  };
}

module.exports = { CONTROL, META, platformName, mapModifiers, mapKeyEvent };
