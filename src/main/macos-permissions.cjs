'use strict';

const PERMISSION_NOTICES = Object.freeze({
  accessibility: Object.freeze({
    id: 'accessibility-permission', kind: 'permission', title: 'Allow Accessibility',
    message: 'Compusync needs Accessibility access to detect and position Chrome windows and share input.',
    actionLabel: 'Open Accessibility Settings', action: 'open-accessibility', dismissible: false,
  }),
  inputMonitoring: Object.freeze({
    id: 'input-monitoring-permission', kind: 'permission', title: 'Allow Input Monitoring',
    message: 'Compusync needs Input Monitoring access so either mouse and keyboard can drive the shared cursor.',
    actionLabel: 'Open Input Monitoring Settings', action: 'open-input-monitoring', dismissible: false,
  }),
  automation: Object.freeze({
    id: 'chrome-automation-permission', kind: 'permission', title: 'Allow Chrome Automation',
    message: 'Compusync needs Automation access to read and recreate Chrome tabs during window handoff.',
    actionLabel: 'Open Automation Settings', action: 'open-automation', dismissible: false,
  }),
});

function normalizedAutomationStatus(value) {
  return ['granted', 'denied', 'unavailable'].includes(value) ? value : 'unavailable';
}

/**
 * Runs the three macOS TCC preflights in their natural prompt order. The
 * caller decides whether this is a first-run launch; this module never stores
 * state and therefore cannot accidentally mark onboarding complete early.
 */
async function runMacPermissionPreflight({
  platform = process.platform,
  firstRun = false,
  systemPreferences,
  native,
  onNotice = () => {},
  clearNotice = () => {},
} = {}) {
  if (platform !== 'darwin') return { skipped: true };

  let accessibility = false;
  try {
    accessibility = Boolean(systemPreferences?.isTrustedAccessibilityClient?.(Boolean(firstRun)));
  } catch { /* Keep startup alive and surface the settings notice below. */ }
  const canProbeInput = typeof native?.inputMonitoringAccess === 'function';
  let inputMonitoring = false;
  try {
    inputMonitoring = canProbeInput
      ? Boolean(await native.inputMonitoringAccess(Boolean(firstRun))) : false;
  } catch { /* Keep startup alive and surface the settings notice below. */ }
  const canProbeAutomation = typeof native?.chromeAutomationAccess === 'function';
  let automation = 'unavailable';
  try {
    automation = canProbeAutomation
      ? normalizedAutomationStatus(await native.chromeAutomationAccess(Boolean(firstRun))) : 'unavailable';
  } catch { /* Keep startup alive and surface the settings notice below. */ }

  const decisions = { accessibility, inputMonitoring, automation };
  const noticeStates = {
    accessibility,
    inputMonitoring,
    automation: automation === 'granted',
  };
  for (const [permission, granted] of Object.entries(noticeStates)) {
    const notice = PERMISSION_NOTICES[permission];
    if (granted) clearNotice(notice.id);
    else onNotice({ ...notice });
  }
  return decisions;
}

module.exports = { runMacPermissionPreflight, PERMISSION_NOTICES, normalizedAutomationStatus };
