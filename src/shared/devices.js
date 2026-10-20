'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CompuSyncDevices = api;
})(typeof window === 'object' ? window : null, () => {
  const PLATFORMS = ['darwin', 'win32', 'unsupported'];
  const platformName = (platform) => platform === 'darwin' ? 'Mac' : platform === 'win32' ? 'Windows' : 'Laptop';
  const advertisedPlatform = (platform) => PLATFORMS.includes(platform) ? platform : 'unsupported';

  function normalizeMember(value) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(value.id)
      || typeof value.name !== 'string' || !value.name.length || value.name.length > 80
      || (value.platform !== undefined && !PLATFORMS.includes(value.platform))) return null;
    return { id: value.id, name: value.name, ...(value.platform === undefined ? {} : { platform: value.platform }) };
  }

  function pairingError(first, second) {
    if (first === 'unsupported' || second === 'unsupported') return 'CompuSync supports Mac-to-Mac and Mac-to-Windows connections.';
    if (first === 'win32' && second === 'win32') return 'Windows-to-Windows is not supported yet. Pair with a Mac instead.';
    // Older mixed-platform builds advertise their OS in layouts, after hello.
    return null;
  }

  function supportedPair(first, second) {
    return ['darwin', 'win32'].includes(first) && ['darwin', 'win32'].includes(second) && !pairingError(first, second);
  }

  // Keep the existing mac/windows geometry slots and macPosition preference for
  // saved-layout and wire compatibility. They are slots, never device identities:
  // the Mac occupies the first slot in mixed pairs; the host does in Mac pairs.
  // Session members are always host first, on both computers.
  function deviceSlots(members = [], layouts = {}) {
    const devices = members.map((member) => ({ ...member, platform: member.platform || layouts[member.id]?.platform }));
    for (const [id, layout] of Object.entries(layouts)) {
      if (!devices.some((device) => device.id === id)) devices.push({ id, platform: layout.platform });
    }
    const pair = devices.slice(0, 2);
    if (pair[0]?.platform === 'win32' || (pair[1]?.platform === 'darwin' && pair[0]?.platform !== 'darwin')) pair.reverse();
    if (pair.length === 1 && pair[0].platform === 'win32') return { mac: null, windows: pair[0] };
    return { mac: pair[0] || null, windows: pair[1] || null };
  }

  const sameMacPair = (slots) => slots.mac?.platform === 'darwin' && slots.windows?.platform === 'darwin';
  const layoutPosition = (position, slots) => sameMacPair(slots) && position === 'top' ? 'left' : position;

  function deviceLabel(device, slots) {
    if (!device) return 'Other laptop';
    const type = platformName(device.platform);
    if (sameMacPair(slots)) {
      const suffix = device.id === slots.mac.id ? '1' : '2';
      return device.name && device.name !== (device.id === slots.mac.id ? slots.windows.name : slots.mac.name)
        ? `${device.name} (Mac)` : `Mac ${suffix}`;
    }
    return type;
  }

  return { platformName, advertisedPlatform, normalizeMember, pairingError, supportedPair, deviceSlots, sameMacPair, layoutPosition, deviceLabel };
});
