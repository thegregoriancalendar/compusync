'use strict';

const { validatePublicPath, DEFAULT_LIMITS } = require('./workspace.cjs');

const MAX_CHUNK_BYTES = 128 * 1024;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,80}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const MODIFIERS = new Set(['shift', 'control', 'alt', 'meta']);
const POINTER_BUTTONS = new Set(['left', 'middle', 'right']);
const NAMED_KEYS = new Set([
  'Backspace', 'Delete', 'Tab', 'Enter', 'Escape', 'Space',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert',
  'Shift', 'Control', 'Alt', 'Meta',
  ...Array.from({ length: 12 }, (_value, index) => `F${index + 1}`),
]);

class CapabilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CapabilityError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CapabilityError(code, message);
}

function object(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_PAYLOAD', 'Capability payload must be an object.');
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) fail('INVALID_PAYLOAD', 'Capability payload contains an unsupported field.');
  if (required.some((key) => !Object.hasOwn(value, key))) fail('INVALID_PAYLOAD', 'Capability payload is missing a required field.');
}

function identifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail('INVALID_PAYLOAD', `${label} is invalid.`);
  return value;
}

function publicPath(value, allowRoot = true) {
  try { return validatePublicPath(value, { allowRoot }); }
  catch { fail('INVALID_PAYLOAD', 'Workspace path is invalid.'); }
}

function finite(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail('INVALID_PAYLOAD', `${label} is outside its allowed range.`);
  return value;
}

function safeInteger(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_PAYLOAD', `${label} is outside its allowed range.`);
  return value;
}

function canonicalBase64(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('INVALID_PAYLOAD', 'Transfer chunk data is not canonical base64.');
  const data = Buffer.from(value, 'base64');
  if (!data.length || data.length > MAX_CHUNK_BYTES || data.toString('base64') !== value) fail('INVALID_PAYLOAD', 'Transfer chunk data has an invalid size or encoding.');
  return value;
}

function modifiers(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MODIFIERS.size || value.some((item) => !MODIFIERS.has(item)) || new Set(value).size !== value.length) fail('INVALID_PAYLOAD', 'Program input modifiers are invalid.');
  return [...value];
}

function keyCode(value, character = false) {
  if (typeof value !== 'string' || !value || value.length > 32) fail('INVALID_PAYLOAD', 'Program key input is invalid.');
  if (character) {
    if (/[^\t\n\r\x20-\u{10ffff}]/u.test(value) || [...value].length > 8) fail('INVALID_PAYLOAD', 'Program text input is invalid.');
  } else if (!NAMED_KEYS.has(value) && ([...value].length !== 1 || /[\x00-\x1f\x7f]/.test(value))) {
    fail('INVALID_PAYLOAD', 'Program key input is invalid.');
  }
  return value;
}

function programInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') fail('INVALID_PAYLOAD', 'Program input is invalid.');
  switch (value.type) {
    case 'mouseMove':
      object(value, ['type', 'x', 'y', 'modifiers'], ['type', 'x', 'y']);
      return { type: value.type, x: finite(value.x, 0, 8192, 'x'), y: finite(value.y, 0, 8192, 'y'), modifiers: modifiers(value.modifiers) };
    case 'mouseDown':
    case 'mouseUp':
      object(value, ['type', 'x', 'y', 'button', 'clickCount', 'modifiers'], ['type', 'x', 'y', 'button']);
      if (!POINTER_BUTTONS.has(value.button)) fail('INVALID_PAYLOAD', 'Program pointer button is invalid.');
      return {
        type: value.type,
        x: finite(value.x, 0, 8192, 'x'),
        y: finite(value.y, 0, 8192, 'y'),
        button: value.button,
        clickCount: value.clickCount === undefined ? 1 : safeInteger(value.clickCount, 1, 3, 'clickCount'),
        modifiers: modifiers(value.modifiers),
      };
    case 'mouseWheel':
      object(value, ['type', 'x', 'y', 'deltaX', 'deltaY', 'modifiers'], ['type', 'x', 'y', 'deltaX', 'deltaY']);
      return {
        type: value.type,
        x: finite(value.x, 0, 8192, 'x'),
        y: finite(value.y, 0, 8192, 'y'),
        deltaX: finite(value.deltaX, -2048, 2048, 'deltaX'),
        deltaY: finite(value.deltaY, -2048, 2048, 'deltaY'),
        modifiers: modifiers(value.modifiers),
      };
    case 'keyDown':
    case 'keyUp':
      object(value, ['type', 'keyCode', 'modifiers', 'isAutoRepeat'], ['type', 'keyCode']);
      if (value.isAutoRepeat !== undefined && typeof value.isAutoRepeat !== 'boolean') fail('INVALID_PAYLOAD', 'Program key repeat flag is invalid.');
      return { type: value.type, keyCode: keyCode(value.keyCode), modifiers: modifiers(value.modifiers), ...(value.isAutoRepeat === undefined ? {} : { isAutoRepeat: value.isAutoRepeat }) };
    case 'char':
      object(value, ['type', 'keyCode', 'modifiers'], ['type', 'keyCode']);
      return { type: value.type, keyCode: keyCode(value.keyCode, true), modifiers: modifiers(value.modifiers) };
    default:
      fail('INVALID_PAYLOAD', 'Program input type is not supported.');
  }
}

const VALIDATORS = Object.freeze({
  'workspace.list'(payload) {
    object(payload, ['path'], []);
    return { path: publicPath(payload.path ?? '', true) };
  },
  'workspace.mkdir'(payload) {
    object(payload, ['path']);
    return { path: publicPath(payload.path, false) };
  },
  'workspace.rename'(payload) {
    object(payload, ['from', 'to']);
    return { from: publicPath(payload.from, false), to: publicPath(payload.to, false) };
  },
  'workspace.delete'(payload) {
    object(payload, ['path']);
    return { path: publicPath(payload.path, false) };
  },
  'transfer.start'(payload) {
    object(payload, ['transferId', 'name', 'target', 'size', 'sha256'], ['transferId', 'name', 'size', 'sha256']);
    const name = publicPath(payload.name, false);
    if (name.includes('/')) fail('INVALID_PAYLOAD', 'Transfer name must contain one path segment.');
    if (typeof payload.sha256 !== 'string' || !SHA256.test(payload.sha256)) fail('INVALID_PAYLOAD', 'Transfer SHA-256 is invalid.');
    return {
      transferId: identifier(payload.transferId, 'Transfer ID'),
      name,
      target: publicPath(payload.target ?? '', true),
      size: safeInteger(payload.size, 0, DEFAULT_LIMITS.maxFileBytes, 'Transfer size'),
      sha256: payload.sha256.toLowerCase(),
    };
  },
  'transfer.chunk'(payload) {
    object(payload, ['transferId', 'offset', 'data']);
    return {
      transferId: identifier(payload.transferId, 'Transfer ID'),
      offset: safeInteger(payload.offset, 0, DEFAULT_LIMITS.maxFileBytes, 'Transfer offset'),
      data: canonicalBase64(payload.data),
    };
  },
  'transfer.finish'(payload) {
    object(payload, ['transferId']);
    return { transferId: identifier(payload.transferId, 'Transfer ID') };
  },
  'transfer.abort'(payload) {
    object(payload, ['transferId']);
    return { transferId: identifier(payload.transferId, 'Transfer ID') };
  },
  'program.launch'(payload) {
    object(payload, ['app', 'path']);
    if (payload.app !== 'text-editor') fail('INVALID_PAYLOAD', 'Only the bundled text editor can be launched.');
    return { app: 'text-editor', path: publicPath(payload.path, false) };
  },
  'program.input'(payload) {
    object(payload, ['programId', 'input']);
    return { programId: identifier(payload.programId, 'Program ID'), input: programInput(payload.input) };
  },
  'program.close'(payload) {
    object(payload, ['programId']);
    return { programId: identifier(payload.programId, 'Program ID') };
  },
});

const CAPABILITY_METHODS = Object.freeze(Object.keys(VALIDATORS));

function isKnownCapability(method) {
  return typeof method === 'string' && Object.hasOwn(VALIDATORS, method);
}

function validateCapabilityRequest(method, payload) {
  if (!isKnownCapability(method)) fail('UNKNOWN_CAPABILITY', 'Unknown capability.');
  return VALIDATORS[method](payload);
}

class CapabilityAuthority {
  constructor(grants = CAPABILITY_METHODS) {
    if (!Array.isArray(grants) || grants.some((method) => !isKnownCapability(method))) fail('INVALID_GRANT', 'Authority contains an unknown capability.');
    this.grants = new Set(grants);
  }

  allows(method) {
    return this.grants.has(method) && isKnownCapability(method);
  }

  validate(method, payload) {
    if (!this.allows(method)) fail('UNAUTHORIZED', 'This connection is not allowed to use that capability.');
    return validateCapabilityRequest(method, payload);
  }

  methods() {
    return [...this.grants];
  }
}

module.exports = {
  CAPABILITY_METHODS,
  CapabilityAuthority,
  CapabilityError,
  MAX_CHUNK_BYTES,
  isKnownCapability,
  validateCapabilityRequest,
};
