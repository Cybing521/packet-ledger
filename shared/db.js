/**
 * Shared IndexedDB & Default Settings Module
 * Runs identically in Extension Service Worker and Side Panel (same chrome-extension:// origin).
 */

export const DB_NAME = 'PacketLedgerDB';
export const DB_VERSION = 1;
export const STORE_NAME = 'records';
export const LIVE_CHANNEL = 'packetledger-live-v1';

export const DEFAULT_SETTINGS = {
  recordingEnabled: true,
  activePreset: 'smart',       // 'smart' | 'chatgpt' | 'bilibili' | 'custom' | 'all_api'
  customPattern: '',           // Substring or /regex/flags
  customMatchScope: 'request', // 'request' (match target API URL) | 'page' (match document/tab URL)
  redactAuth: false,           // Mask Authorization / Cookie / CSRF headers
  localSinkEnabled: false,     // Push each record in real time to http://127.0.0.1:17890/ingest
  localSinkUrl: 'http://127.0.0.1:17890/ingest',
  maxDbRecords: 3000,          // Ring-buffer cap in IndexedDB (disk sink has no cap)
  maxBodyChars: 512000         // Max response text length stored per record (~500 KB)
};

export async function getSettings() {
  const stored = await chrome.storage.local.get('plSettings');
  return { ...DEFAULT_SETTINGS, ...(stored.plSettings || {}) };
}

export async function updateSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ plSettings: next });
  return next;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('capturedAt', 'capturedAt', { unique: false });
        store.createIndex('siteTag', 'siteTag', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function insertRecord(record, maxDbRecords = 3000) {
  const db = await openDatabase();
  try {
    const insertedId = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const addReq = store.add(record);
      let idVal = null;
      addReq.onsuccess = () => {
        idVal = addReq.result;
      };
      tx.oncomplete = () => resolve(idVal);
      tx.onerror = () => reject(tx.error);
    });

    // Enforce ring-buffer cap periodically to prevent unbounded IndexedDB growth
    const total = await countRecordsWithDb(db);
    if (total > maxDbRecords + 100) {
      const excess = total - maxDbRecords;
      await pruneOldestWithDb(db, excess);
    }
    return insertedId;
  } finally {
    db.close();
  }
}

function countRecordsWithDb(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function pruneOldestWithDb(db, deleteCount) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const cursorReq = store.openCursor();
    let removed = 0;
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor && removed < deleteCount) {
        cursor.delete();
        removed += 1;
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve(removed);
    tx.onerror = () => reject(tx.error);
  });
}

export async function queryRecentRecords(limit = 500) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const results = [];
      const cursorReq = store.openCursor(null, 'prev');
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve(results);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function getAllRecordsAscending() {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function getRecordById(id) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(Number(id));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function clearAllRecords() {
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function getRecordCount() {
  const db = await openDatabase();
  try {
    return await countRecordsWithDb(db);
  } finally {
    db.close();
  }
}
