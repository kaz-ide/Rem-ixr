/**
 * db.js - IndexedDB Manager for Music Remixer
 * Handles 10 presets, sample audio data (ArrayBuffers), and settings persistence.
 */
const DB_NAME = 'MusicRemixerDB';
const DB_VERSION = 1;

let dbInstance = null;

export async function openDB() {
  if (dbInstance) return dbInstance;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('presets')) {
        db.createObjectStore('presets', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('samples')) {
        db.createObjectStore('samples', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = event.target.result;
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      console.error('IndexedDB open failed', event.target.error);
      reject(event.target.error);
    };
  });
}

export async function getPreset(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('presets', 'readonly');
    const store = tx.objectStore('presets');
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function savePreset(preset) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('presets', 'readwrite');
    const store = tx.objectStore('presets');
    const req = store.put(preset);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getAllPresets() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('presets', 'readonly');
    const store = tx.objectStore('presets');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function getSample(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('samples', 'readonly');
    const store = tx.objectStore('samples');
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSample(id, name, mimeType, arrayBuffer) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('samples', 'readwrite');
    const store = tx.objectStore('samples');
    const item = { id, name, mimeType, data: arrayBuffer, updatedAt: Date.now() };
    const req = store.put(item);
    req.onsuccess = () => resolve(item);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllSamples() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('samples', 'readonly');
    const store = tx.objectStore('samples');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function getSetting(key, defaultValue = null) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readonly');
    const store = tx.objectStore('settings');
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : defaultValue);
    req.onerror = () => reject(req.error);
  });
}

export async function setSetting(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readwrite');
    const store = tx.objectStore('settings');
    const req = store.put({ key, value });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Convert ArrayBuffer to Base64
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Convert Base64 to ArrayBuffer
function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

// Export complete data (presets + samples + settings) as a single downloadable JSON
export async function exportBackup() {
  const presets = await getAllPresets();
  const samples = await getAllSamples();
  const activePresetId = await getSetting('activePresetId', 1);

  const serializedSamples = samples.map((s) => ({
    id: s.id,
    name: s.name,
    mimeType: s.mimeType,
    dataBase64: arrayBufferToBase64(s.data),
  }));

  const backupData = {
    version: 1,
    app: 'WebMusicRemixer',
    timestamp: new Date().toISOString(),
    activePresetId,
    presets,
    samples: serializedSamples,
  };

  const json = JSON.stringify(backupData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  return blob;
}

// Import backup and overwrite IndexedDB contents
export async function importBackup(jsonData) {
  const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
  if (!data.presets || !data.samples) {
    throw new Error('無効なバックアップファイル形式です。');
  }

  const db = await openDB();

  // Clear existing
  const txClear = db.transaction(['presets', 'samples', 'settings'], 'readwrite');
  txClear.objectStore('presets').clear();
  txClear.objectStore('samples').clear();
  txClear.objectStore('settings').clear();
  await new Promise((res, rej) => {
    txClear.oncomplete = () => res();
    txClear.onerror = () => rej(txClear.error);
  });

  // Restore presets
  const txWrite = db.transaction(['presets', 'samples', 'settings'], 'readwrite');
  const presetStore = txWrite.objectStore('presets');
  for (const p of data.presets) {
    presetStore.put(p);
  }

  // Restore samples
  const sampleStore = txWrite.objectStore('samples');
  for (const s of data.samples) {
    sampleStore.put({
      id: s.id,
      name: s.name,
      mimeType: s.mimeType,
      data: base64ToArrayBuffer(s.dataBase64),
      updatedAt: Date.now(),
    });
  }

  // Restore settings
  const settingsStore = txWrite.objectStore('settings');
  settingsStore.put({ key: 'activePresetId', value: data.activePresetId || 1 });

  await new Promise((res, rej) => {
    txWrite.oncomplete = () => res();
    txWrite.onerror = () => rej(txWrite.error);
  });

  return data;
}
