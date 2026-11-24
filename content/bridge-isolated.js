/**
 * ISOLATED World Content Script Bridge
 * Bridges configuration from chrome.storage.local -> MAIN world hook,
 * and forwards captured records from MAIN world -> Extension Service Worker.
 */
(() => {
  if (window.__PACKET_LEDGER_BRIDGE_ACTIVE__) return;
  window.__PACKET_LEDGER_BRIDGE_ACTIVE__ = true;

  const EVT_CONFIG_PUSH = '__pl_cfg_push_v1__';
  const EVT_CONFIG_REQ = '__pl_cfg_req_v1__';
  const EVT_PACKET_EMIT = '__pl_pkt_emit_v1__';

  const FALLBACK_SETTINGS = {
    recordingEnabled: true,
    activePreset: 'smart',
    customPattern: '',
    customMatchScope: 'request',
    redactAuth: false,
    maxBodyChars: 512000
  };

  let cachedConfig = { ...FALLBACK_SETTINGS };

  function pushConfigToMain(cfg) {
    cachedConfig = { ...FALLBACK_SETTINGS, ...(cfg || {}) };
    window.dispatchEvent(
      new CustomEvent(EVT_CONFIG_PUSH, {
        detail: JSON.stringify(cachedConfig)
      })
    );
  }

  async function syncFromStorage() {
    try {
      const data = await chrome.storage.local.get('plSettings');
      pushConfigToMain(data.plSettings || FALLBACK_SETTINGS);
    } catch {
      pushConfigToMain(FALLBACK_SETTINGS);
    }
  }

  window.addEventListener(EVT_CONFIG_REQ, () => {
    pushConfigToMain(cachedConfig);
  });

  window.addEventListener(EVT_PACKET_EMIT, (event) => {
    if (typeof event.detail !== 'string') return;
    try {
      const record = JSON.parse(event.detail);
      if (!chrome.runtime?.id) return;
      chrome.runtime.sendMessage({ type: 'PL_CAPTURED_RECORD', record }).catch(() => {});
    } catch {
      // Ignore malformed cross-world payload
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.plSettings) {
      pushConfigToMain(changes.plSettings.newValue || FALLBACK_SETTINGS);
    }
  });

  syncFromStorage();
})();
