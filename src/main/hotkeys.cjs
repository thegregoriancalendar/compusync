'use strict';

const DEFAULT_LINK_HOTKEY = 'CommandOrControl+Shift+U';
const DEFAULT_OWNERSHIP_HOTKEY = 'CommandOrControl+Shift+Y';

function registerCursorHotkeys(globalShortcut, options = {}) {
  if (!globalShortcut?.register || !options.cursor) throw new TypeError('globalShortcut and cursor are required.');
  const linkAccelerator = options.linkAccelerator || DEFAULT_LINK_HOTKEY;
  const ownershipAccelerator = options.ownershipAccelerator || DEFAULT_OWNERSHIP_HOTKEY;
  const linkRegistered = globalShortcut.register(linkAccelerator, () => {
    if (options.cursor.linked) options.watchdog?.trigger?.('user-hotkey');
    else {
      options.cursor.setLinked(true, 'user-hotkey');
      options.watchdog?.arm?.();
    }
    options.onModeChange?.(options.cursor.linked);
  });
  const ownershipRegistered = globalShortcut.register(ownershipAccelerator, () => {
    if (options.cursor.toggleOwnership()) options.onOwnershipChange?.(options.cursor.ownerMachineId);
  });
  const dispose = () => {
    globalShortcut.unregister?.(linkAccelerator);
    globalShortcut.unregister?.(ownershipAccelerator);
  };
  return { linkAccelerator, ownershipAccelerator, linkRegistered, ownershipRegistered, dispose };
}

module.exports = {
  DEFAULT_LINK_HOTKEY,
  DEFAULT_OWNERSHIP_HOTKEY,
  registerCursorHotkeys,
};
