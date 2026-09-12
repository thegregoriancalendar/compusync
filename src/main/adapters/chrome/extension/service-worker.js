'use strict';

// All privileged operations are initiated through the restricted loopback CDP
// connection. The worker has no network, content-script, UI, or message surface.
chrome.runtime.onStartup.addListener(() => {});
chrome.action.onClicked.addListener(() => {});

globalThis.compusyncCapture = async (input) => {
  const tabs = await chrome.tabs.query({ windowId: input.windowId });
  const targets = await chrome.debugger.getTargets();
  const byTab = new Map(targets.filter((item) => Number.isInteger(item.tabId))
    .map((item) => [item.tabId, item.id]));
  return tabs.map((tab) => ({ targetId: byTab.get(tab.id), index: tab.index,
    pinned: tab.pinned === true, active: tab.active === true }))
    .filter((tab) => typeof tab.targetId === 'string');
};

globalThis.compusyncApply = async (input) => {
  let match;
  for (let attempt = 0; attempt < 5 && !match; attempt += 1) {
    match = (await chrome.debugger.getTargets()).find((item) => item.id === input.targetId
      && Number.isInteger(item.tabId));
    if (!match) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!match) throw new Error('target unavailable');
  const tab = await chrome.tabs.get(match.tabId);
  if (tab.windowId !== input.windowId) throw new Error('wrong window');
  await chrome.tabs.update(match.tabId, { pinned: input.pinned });
  await chrome.tabs.move(match.tabId, { windowId: input.windowId, index: input.index });
  return true;
};
