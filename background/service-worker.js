/**
 * Extension Service Worker (Manifest V3 ES Module)
 * Stateless across restarts: persists settings in chrome.storage.local and records in IndexedDB.
 * Relays live packets to Side Panel via BroadcastChannel and optionally streams JSONL to local-sink.mjs.
 */
import {
  DEFAULT_SETTINGS,
  LIVE_CHANNEL,
  getSettings,
  insertRecord,
  clearAllRecords,
  getRecordCount
} from '../shared/db.js';

const liveChannel = new BroadcastChannel(LIVE_CHANNEL);

async function syncBadge() {
  try {
    const settings = await getSettings();
    if (settings.recordingEnabled) {
      await chrome.action.setBadgeText({ text: 'REC' });
      await chrome.action.setBadgeBackgroundColor({ color: '#B5523C' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch {
    // Ignore badge update errors during install/shutdown
  }
}

async function forwardToLocalSink(record, settings) {
  if (!settings.localSinkEnabled || !settings.localSinkUrl) return { ok: false, skipped: true };
  try {
    const res = await fetch(settings.localSinkUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record)
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err?.message || 'sink_unreachable' };
  }
}

// Top-level synchronous listener registrations (required by Manifest V3 SW lifecycle)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  if (details.reason === 'install') {
    const existing = await chrome.storage.local.get('plSettings');
    if (!existing.plSettings) {
      await chrome.storage.local.set({ plSettings: DEFAULT_SETTINGS });
    }
  }
  await syncBadge();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.plSettings) {
    syncBadge();
    liveChannel.postMessage({
      type: 'SETTINGS_UPDATED',
      settings: changes.plSettings.newValue
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (message.type === 'PL_CAPTURED_RECORD') {
    (async () => {
      try {
        const settings = await getSettings();
        if (!settings.recordingEnabled) {
          sendResponse({ ok: false, reason: 'paused' });
          return;
        }
        const enriched = {
          ...message.record,
          tabId: sender?.tab?.id ?? null,
          frameId: sender?.frameId ?? 0
        };
        const id = await insertRecord(enriched, settings.maxDbRecords);
        const savedRecord = { ...enriched, id };

        const sinkStatus = await forwardToLocalSink(savedRecord, settings);
        liveChannel.postMessage({
          type: 'NEW_RECORD',
          record: savedRecord,
          sinkStatus
        });
        sendResponse({ ok: true, id, sinkStatus });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === 'PL_CLEAR_RECORDS') {
    (async () => {
      try {
        await clearAllRecords();
        liveChannel.postMessage({ type: 'RECORDS_CLEARED' });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === 'PL_GET_STATS') {
    (async () => {
      try {
        const count = await getRecordCount();
        sendResponse({ ok: true, count });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  return false;
});

syncBadge();
