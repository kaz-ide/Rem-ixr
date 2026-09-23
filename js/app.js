/**
 * Music Remixer - Standalone Unified Controller
 * Contains IndexedDB Storage, Web Audio Engine, and UI Handlers
 * Operates reliably both in HTTP/HTTPS server and direct file:// local execution.
 */

(function () {
  'use strict';

  /* ==========================================================================
     1. IndexedDB Manager
     ========================================================================== */
  const DB_NAME = 'MusicRemixerDB';
  const DB_VERSION = 1;
  let dbInstance = null;

  async function openDB() {
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

  async function getPreset(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('presets', 'readonly');
      const store = tx.objectStore('presets');
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function savePreset(preset) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('presets', 'readwrite');
      const store = tx.objectStore('presets');
      const req = store.put(preset);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllPresets() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('presets', 'readonly');
      const store = tx.objectStore('presets');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function getSample(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('samples', 'readonly');
      const store = tx.objectStore('samples');
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveSample(id, name, mimeType, arrayBuffer) {
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

  async function getAllSamples() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('samples', 'readonly');
      const store = tx.objectStore('samples');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function getSetting(key, defaultValue = null) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('settings', 'readonly');
      const store = tx.objectStore('settings');
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : defaultValue);
      req.onerror = () => reject(req.error);
    });
  }

  async function setSetting(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('settings', 'readwrite');
      const store = tx.objectStore('settings');
      const req = store.put({ key, value });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // Export backup as a single ZIP file containing config.json and raw audio/ binaries
  async function exportBackupZip(onProgress) {
    if (typeof JSZip === 'undefined') {
      throw new Error('JSZipライブラリが読み込まれていません。');
    }

    const zip = new JSZip();
    const presets = await getAllPresets();
    const samples = await getAllSamples();
    const activePresetId = await getSetting('activePresetId', 1);

    // Metadata for config.json (no huge base64 strings!)
    const samplesMeta = samples.map((s) => ({
      id: s.id,
      name: s.name,
      mimeType: s.mimeType,
      fileName: `${s.id}.bin`,
    }));

    const configData = {
      version: 2,
      app: 'Rem-ixr',
      format: 'binary-zip',
      timestamp: new Date().toISOString(),
      activePresetId,
      presets,
      samples: samplesMeta,
    };

    zip.file('config.json', JSON.stringify(configData, null, 2));

    // Audio binaries folder
    const audioFolder = zip.folder('audio');
    const totalSamples = samples.length;
    for (let i = 0; i < totalSamples; i++) {
      const s = samples[i];
      audioFolder.file(`${s.id}.bin`, s.data);
      if (onProgress && totalSamples > 0) {
        onProgress(Math.round(((i + 1) / totalSamples) * 45));
      }
    }

    // Generate ZIP with DEFLATE compression
    const zipBlob = await zip.generateAsync(
      {
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      },
      (metadata) => {
        if (onProgress) {
          // 45% to 100%
          onProgress(45 + Math.round(metadata.percent * 0.55));
        }
      }
    );

    return zipBlob;
  }

  // Import backup from ZIP (or legacy JSON)
  async function importBackupZip(file, onProgress) {
    const fileName = file.name.toLowerCase();

    // Check for legacy JSON backup file
    if (fileName.endsWith('.json')) {
      const text = await file.text();
      return await importLegacyJson(text);
    }

    if (typeof JSZip === 'undefined') {
      throw new Error('JSZipライブラリが読み込まれていません。');
    }

    const zip = await JSZip.loadAsync(file);
    const configFile = zip.file('config.json');
    if (!configFile) {
      throw new Error('ZIPアーカイブ内に config.json が見つかりません。');
    }

    const configText = await configFile.async('text');
    const configData = JSON.parse(configText);

    if (configData.app !== 'Rem-ixr' && configData.app !== 'WebMusicRemixer') {
      throw new Error('Rem-ixr のバックアップファイルではありません。');
    }

    const db = await openDB();

    // Clear existing stores
    const txClear = db.transaction(['presets', 'samples', 'settings'], 'readwrite');
    txClear.objectStore('presets').clear();
    txClear.objectStore('samples').clear();
    txClear.objectStore('settings').clear();
    await new Promise((res, rej) => {
      txClear.oncomplete = () => res();
      txClear.onerror = () => rej(txClear.error);
    });

    // Write presets
    const txPresets = db.transaction('presets', 'readwrite');
    const presetStore = txPresets.objectStore('presets');
    for (const p of (configData.presets || [])) {
      presetStore.put(p);
    }
    await new Promise((res, rej) => {
      txPresets.oncomplete = () => res();
      txPresets.onerror = () => rej(txPresets.error);
    });

    // Extract audio binaries
    const samples = configData.samples || [];
    const totalSamples = samples.length;

    for (let i = 0; i < totalSamples; i++) {
      const meta = samples[i];
      const audioFile = zip.file(`audio/${meta.fileName}`) || zip.file(`audio/${meta.id}.bin`);
      let arrayBuffer = null;

      if (audioFile) {
        arrayBuffer = await audioFile.async('arraybuffer');
      } else if (meta.dataBase64) {
        arrayBuffer = base64ToArrayBuffer(meta.dataBase64);
      }

      if (arrayBuffer) {
        await saveSample(meta.id, meta.name, meta.mimeType || 'audio/wav', arrayBuffer);
      }

      if (onProgress && totalSamples > 0) {
        onProgress(Math.round(((i + 1) / totalSamples) * 100));
      }
    }

    // Restore settings
    await setSetting('activePresetId', configData.activePresetId || 1);

    return configData;
  }

  // Backward compatibility for legacy JSON backup
  async function importLegacyJson(jsonData) {
    const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
    if (!data.presets || !data.samples) {
      throw new Error('無効なバックアップファイル形式です。');
    }

    const db = await openDB();
    const txClear = db.transaction(['presets', 'samples', 'settings'], 'readwrite');
    txClear.objectStore('presets').clear();
    txClear.objectStore('samples').clear();
    txClear.objectStore('settings').clear();
    await new Promise((res, rej) => {
      txClear.oncomplete = () => res();
      txClear.onerror = () => rej(txClear.error);
    });

    const txWrite = db.transaction(['presets', 'samples', 'settings'], 'readwrite');
    const presetStore = txWrite.objectStore('presets');
    for (const p of data.presets) {
      presetStore.put(p);
    }

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

    const settingsStore = txWrite.objectStore('settings');
    settingsStore.put({ key: 'activePresetId', value: data.activePresetId || 1 });

    await new Promise((res, rej) => {
      txWrite.oncomplete = () => res();
      txWrite.onerror = () => rej(txWrite.error);
    });

    return data;
  }

  /* ==========================================================================
     Metadata Parser (ID3v2, MP4/M4A, FLAC, WAV)
     Zero external dependencies.
     ========================================================================== */
  function parseAudioMetadata(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 32) return { title: null, artist: null };

    try {
      if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
        return parseID3v2(bytes, 0);
      }
      if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
        const wavMeta = parseWavMetadata(bytes);
        if (wavMeta.title || wavMeta.artist) return wavMeta;
      }
      if (isMp4(bytes)) {
        const mp4Meta = parseMp4Metadata(bytes);
        if (mp4Meta.title || mp4Meta.artist) return mp4Meta;
      }
      if (bytes[0] === 0x66 && bytes[1] === 0x4C && bytes[2] === 0x61 && bytes[3] === 0x43) {
        const flacMeta = parseFlacMetadata(bytes);
        if (flacMeta.title || flacMeta.artist) return flacMeta;
      }
    } catch (err) {
      console.warn('Metadata parsing error:', err);
    }
    return { title: null, artist: null };
  }

  function parseID3v2(bytes, offset) {
    const majorVersion = bytes[offset + 3];
    const size = (bytes[offset + 6] << 21) | (bytes[offset + 7] << 14) | (bytes[offset + 8] << 7) | bytes[offset + 9];
    const endOffset = Math.min(bytes.length, offset + 10 + size);
    let pos = offset + 10;
    let title = null;
    let artist = null;

    while (pos + 10 < endOffset) {
      const frameId = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
      if (frameId.charCodeAt(0) === 0) break;
      let frameSize = (majorVersion === 4)
        ? ((bytes[pos + 4] << 21) | (bytes[pos + 5] << 14) | (bytes[pos + 6] << 7) | bytes[pos + 7])
        : ((bytes[pos + 4] << 24) | (bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7]);

      if (frameSize <= 0 || pos + 10 + frameSize > endOffset) break;
      const frameData = bytes.subarray(pos + 10, pos + 10 + frameSize);
      if (frameId === 'TIT2') title = decodeTextFrame(frameData);
      else if (frameId === 'TPE1') artist = decodeTextFrame(frameData);

      if (title && artist) break;
      pos += 10 + frameSize;
    }
    return { title: cleanString(title), artist: cleanString(artist) };
  }

  function decodeTextFrame(frameData) {
    if (frameData.length <= 1) return null;
    const encoding = frameData[0];
    const content = frameData.subarray(1);
    try {
      if (encoding === 0) return new TextDecoder('iso-8859-1').decode(content);
      if (encoding === 1 || encoding === 2) return new TextDecoder('utf-16').decode(content);
      return new TextDecoder('utf-8').decode(content);
    } catch (e) {
      return new TextDecoder('utf-8').decode(content);
    }
  }

  function parseWavMetadata(bytes) {
    let pos = 12;
    let title = null;
    let artist = null;
    while (pos + 8 < bytes.length) {
      const chunkId = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
      const chunkSize = bytes[pos + 4] | (bytes[pos + 5] << 8) | (bytes[pos + 6] << 16) | (bytes[pos + 7] << 24);
      if (chunkSize <= 0 || pos + 8 + chunkSize > bytes.length) break;

      if (chunkId.toLowerCase() === 'id3 ') {
        const id3Res = parseID3v2(bytes, pos + 8);
        if (id3Res.title || id3Res.artist) return id3Res;
      } else if (chunkId === 'LIST') {
        const listType = String.fromCharCode(bytes[pos + 8], bytes[pos + 9], bytes[pos + 10], bytes[pos + 11]);
        if (listType === 'INFO') {
          let infoPos = pos + 12;
          const listEnd = pos + 8 + chunkSize;
          while (infoPos + 8 < listEnd) {
            const subId = String.fromCharCode(bytes[infoPos], bytes[infoPos + 1], bytes[infoPos + 2], bytes[infoPos + 3]);
            const subSize = bytes[infoPos + 4] | (bytes[infoPos + 5] << 8) | (bytes[infoPos + 6] << 16) | (bytes[infoPos + 7] << 24);
            if (subSize <= 0 || infoPos + 8 + subSize > listEnd) break;
            const str = new TextDecoder('utf-8').decode(bytes.subarray(infoPos + 8, infoPos + 8 + subSize));
            if (subId === 'INAM') title = str;
            if (subId === 'IART') artist = str;
            infoPos += 8 + subSize + (subSize % 2);
          }
        }
      }
      pos += 8 + chunkSize + (chunkSize % 2);
    }
    return { title: cleanString(title), artist: cleanString(artist) };
  }

  function isMp4(bytes) {
    if (bytes.length < 8) return false;
    return String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === 'ftyp';
  }

  function parseMp4Metadata(bytes) {
    function findAtom(start, end, targetName) {
      let p = start;
      while (p + 8 <= end && p < bytes.length) {
        const size = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
        const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
        if (size <= 0) break;
        if (type === targetName) return { start: p + 8, end: p + size };
        p += size;
      }
      return null;
    }

    const moov = findAtom(0, bytes.length, 'moov');
    if (!moov) return { title: null, artist: null };
    const udta = findAtom(moov.start, moov.end, 'udta');
    if (!udta) return { title: null, artist: null };
    const meta = findAtom(udta.start, udta.end, 'meta');
    if (!meta) return { title: null, artist: null };
    const ilst = findAtom(meta.start + 4, meta.end, 'ilst') || findAtom(meta.start, meta.end, 'ilst');
    if (!ilst) return { title: null, artist: null };

    let tagPos = ilst.start;
    let title = null;
    let artist = null;

    while (tagPos + 8 < ilst.end) {
      const itemSize = (bytes[tagPos] << 24) | (bytes[tagPos + 1] << 16) | (bytes[tagPos + 2] << 8) | bytes[tagPos + 3];
      const itemType = String.fromCharCode(bytes[tagPos + 4], bytes[tagPos + 5], bytes[tagPos + 6], bytes[tagPos + 7]);
      if (itemSize <= 0 || tagPos + itemSize > ilst.end) break;

      const dataAtom = findAtom(tagPos + 8, tagPos + itemSize, 'data');
      if (dataAtom) {
        const textBytes = bytes.subarray(dataAtom.start + 8, dataAtom.end);
        const text = new TextDecoder('utf-8').decode(textBytes);
        if (itemType === '©nam') title = text;
        if (itemType === '©ART' || itemType === 'aART') artist = text;
      }
      tagPos += itemSize;
    }
    return { title: cleanString(title), artist: cleanString(artist) };
  }

  function parseFlacMetadata(bytes) {
    let pos = 4;
    let title = null;
    let artist = null;
    while (pos + 4 < bytes.length) {
      const header = bytes[pos];
      const isLast = (header & 0x80) !== 0;
      const blockType = header & 0x7F;
      const blockSize = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
      pos += 4;

      if (blockType === 4) {
        let cPos = pos;
        const vendorLen = bytes[cPos] | (bytes[cPos + 1] << 8) | (bytes[cPos + 2] << 16) | (bytes[cPos + 3] << 24);
        cPos += 4 + vendorLen;
        const numComments = bytes[cPos] | (bytes[cPos + 1] << 8) | (bytes[cPos + 2] << 16) | (bytes[cPos + 3] << 24);
        cPos += 4;

        for (let i = 0; i < numComments && cPos + 4 < pos + blockSize; i++) {
          const cLen = bytes[cPos] | (bytes[cPos + 1] << 8) | (bytes[cPos + 2] << 16) | (bytes[cPos + 3] << 24);
          cPos += 4;
          const cStr = new TextDecoder('utf-8').decode(bytes.subarray(cPos, cPos + cLen));
          cPos += cLen;
          const eqIdx = cStr.indexOf('=');
          if (eqIdx !== -1) {
            const key = cStr.substring(0, eqIdx).toUpperCase();
            const val = cStr.substring(eqIdx + 1);
            if (key === 'TITLE') title = val;
            if (key === 'ARTIST') artist = val;
          }
        }
        break;
      }
      pos += blockSize;
      if (isLast) break;
    }
    return { title: cleanString(title), artist: cleanString(artist) };
  }

  function cleanString(str) {
    if (!str) return null;
    const cleaned = str.replace(/\0/g, '').trim();
    return cleaned.length > 0 ? cleaned : null;
  }

  /* ==========================================================================
     2. Web Audio Engine
     ========================================================================== */
  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.masterGain = null;
      this.redBusGain = null;
      this.greenBusGain = null;
      this.blueBusGain = null;

      this.faderPosition = 0.5; // Normalized: 0.0 (Red) ~ 0.5 (Center Blend 100/100) ~ 1.0 (Green)
      this.activeTracks = new Map(); // 'col_row' -> { source, gainNode, row, col }
      this.columnActiveTrack = new Map(); // col -> 'col_row'
      this.bufferCache = new Map(); // sampleId -> AudioBuffer

      this.onFaderChange = null;
      this.onTrackStateChange = null;
      this.faderAnimationId = null;
      this.isFaderAnimating = false;
      this.isUnlocked = false;
      this.silentAudio = null;
      this.setupKeepAliveListeners();
    }

    setupKeepAliveListeners() {
      // Automatic resume when returning from background or interrupted state
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          if (this.ctx && this.ctx.state !== 'running') {
            this.ctx.resume().catch(() => {});
          }
          if (this.silentAudio && this.silentAudio.paused && this.isUnlocked) {
            this.silentAudio.play().catch(() => {});
          }
        }
      });

      // Explicit pause and cleanup when navigating away or closing tab
      window.addEventListener('beforeunload', () => {
        if (this.silentAudio) {
          try {
            this.silentAudio.pause();
          } catch (_) {}
        }
      });
      window.addEventListener('pagehide', () => {
        if (this.silentAudio) {
          try {
            this.silentAudio.pause();
          } catch (_) {}
        }
      });
    }

    init() {
      if (this.ctx) return;

      // Set iOS 16.4+ Audio Session to 'playback'
      // This tells iOS that this page plays intentional media, preventing muting on screen lock,
      // backgrounding, or when the hardware silent switch is ON.
      if ('audioSession' in navigator) {
        try {
          navigator.audioSession.type = 'playback';
        } catch (e) {
          console.warn('AudioSession setup failed:', e);
        }
      }

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });

      this.ctx.onstatechange = () => {
        if (this.ctx.state === 'interrupted' || this.ctx.state === 'suspended') {
          if (this.isUnlocked) {
            this.ctx.resume().catch(() => {});
          }
        }
      };

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(0.9, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);

      this.redBusGain = this.ctx.createGain();
      this.redBusGain.connect(this.masterGain);

      this.greenBusGain = this.ctx.createGain();
      this.greenBusGain.connect(this.masterGain);

      this.blueBusGain = this.ctx.createGain();
      this.blueBusGain.gain.setValueAtTime(1.0, this.ctx.currentTime);
      this.blueBusGain.connect(this.masterGain);

      this.updateBusGains();
    }

    unlock() {
      if (!this.ctx) this.init();

      // Ensure audioSession is playback mode on iOS
      if ('audioSession' in navigator) {
        try {
          navigator.audioSession.type = 'playback';
        } catch (_) {}
      }

      // Synchronously resume AudioContext within direct user gesture
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }

      // Synchronously play persistent silent MP3 element within direct user gesture
      if (!this.silentAudio) {
        this.silentAudio = document.getElementById('bg-audio-keeper');
      }
      if (this.silentAudio && this.silentAudio.paused) {
        this.silentAudio.play().catch((err) => {
          console.warn('bgAudio play failed:', err);
        });
      }

      // Register MediaSession metadata and handlers for iOS lock screen
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: 'Rem-ixr',
            artist: 'Web Pad Remixer',
            album: 'Rem-ixr'
          });
          navigator.mediaSession.playbackState = 'playing';
          navigator.mediaSession.setActionHandler('play', () => {
            if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
            if (this.silentAudio && this.silentAudio.paused) this.silentAudio.play().catch(() => {});
          });
          navigator.mediaSession.setActionHandler('pause', () => {});
        } catch (_) {}
      }

      this.isUnlocked = true;
    }

    setFaderPosition(value, notify = true) {
      let pos = Math.max(0.0, Math.min(1.0, value));

      // Center snap within +/- 2% (0.48 ~ 0.52 snaps to 0.5)
      if (Math.abs(pos - 0.5) <= 0.02) {
        pos = 0.5;
      }

      this.faderPosition = pos;
      this.updateBusGains();

      if (notify && this.onFaderChange) {
        this.onFaderChange(this.faderPosition);
      }
    }

    stopExclusiveTracks(fadeDuration = 0.2) {
      const redKey = this.columnActiveTrack.get(0);
      if (redKey) {
        this.stopTrackWithFade(redKey, fadeDuration);
        this.columnActiveTrack.delete(0);
      }
      const greenKey = this.columnActiveTrack.get(4);
      if (greenKey) {
        this.stopTrackWithFade(greenKey, fadeDuration);
        this.columnActiveTrack.delete(4);
      }
    }

    getFaderPosition() {
      return this.faderPosition;
    }

    updateBusGains() {
      if (!this.ctx || !this.redBusGain || !this.greenBusGain) return;

      const now = this.ctx.currentTime;
      let redVol = 1.0;
      let greenVol = 1.0;

      // DJ Crossfader curve:
      // Left end (0.0): Red 100%, Green 0%
      // Range 0.0 ~ 0.5: Red 100%, Green smoothly increases 0% -> 100%
      // Center (0.5): Red 100%, Green 100% (Both MAX blend)
      // Range 0.5 ~ 1.0: Red smoothly decreases 100% -> 0%, Green 100%
      // Right end (1.0): Red 0%, Green 100%
      if (this.faderPosition <= 0.5) {
        redVol = 1.0;
        greenVol = Math.max(0.0, Math.min(1.0, this.faderPosition / 0.5));
      } else {
        redVol = Math.max(0.0, Math.min(1.0, (1.0 - this.faderPosition) / 0.5));
        greenVol = 1.0;
      }

      this.redBusGain.gain.cancelScheduledValues(now);
      this.redBusGain.gain.setValueAtTime(this.redBusGain.gain.value, now);
      this.redBusGain.gain.linearRampToValueAtTime(redVol, now + 0.03);

      this.greenBusGain.gain.cancelScheduledValues(now);
      this.greenBusGain.gain.setValueAtTime(this.greenBusGain.gain.value, now);
      this.greenBusGain.gain.linearRampToValueAtTime(greenVol, now + 0.03);
    }

    animateFader(target, duration = 0.5) {
      if (this.faderAnimationId) {
        cancelAnimationFrame(this.faderAnimationId);
        this.faderAnimationId = null;
      }

      this.isFaderAnimating = true;

      return new Promise((resolve) => {
        const startPos = this.faderPosition;
        const startTime = performance.now();
        const durationMs = duration * 1000;

        const step = (currentTime) => {
          const elapsed = currentTime - startTime;
          const progress = Math.min(elapsed / durationMs, 1.0);
          const ease = progress < 0.5
            ? 2 * progress * progress
            : -1 + (4 - 2 * progress) * progress;

          const currentPos = startPos + (target - startPos) * ease;
          this.setFaderPosition(currentPos, true);

          if (progress < 1.0) {
            this.faderAnimationId = requestAnimationFrame(step);
          } else {
            this.setFaderPosition(target, true);
            this.faderAnimationId = null;
            this.isFaderAnimating = false;
            resolve();
          }
        };

        this.faderAnimationId = requestAnimationFrame(step);
      });
    }

    async decodeAudioData(arrayBuffer) {
      await this.unlock();
      const copy = arrayBuffer.slice(0);
      return new Promise((resolve, reject) => {
        this.ctx.decodeAudioData(
          copy,
          (buffer) => resolve(buffer),
          (err) => reject(err)
        );
      });
    }

    setCachedBuffer(sampleId, audioBuffer) {
      this.bufferCache.set(sampleId, audioBuffer);
    }

    getCachedBuffer(sampleId) {
      return this.bufferCache.get(sampleId);
    }

    hasBuffer(sampleId) {
      return this.bufferCache.has(sampleId);
    }

    async triggerPad(row, col, sampleId, isLoop = false) {
      await this.unlock();
      const buffer = this.bufferCache.get(sampleId);
      if (!buffer) return;

      const padKey = `${col}_${row}`;

      if (col === 0 || col === 4) {
        await this.handleColumnPlay(row, col, padKey, buffer, isLoop);
      } else {
        this.handleOneShotPlay(row, col, padKey, buffer, isLoop);
      }
    }

    async handleColumnPlay(row, col, padKey, buffer, isLoop = false) {
      const isRed = col === 0;
      const currentActivePadKey = this.columnActiveTrack.get(col);

      // Tapping same playing pad stops it
      if (currentActivePadKey === padKey) {
        this.stopTrackWithFade(padKey, 0.5);
        this.columnActiveTrack.delete(col);
        return;
      }

      // If a different row in the SAME column is currently playing, crossfade out over 0.5s
      if (currentActivePadKey && currentActivePadKey !== padKey) {
        this.stopTrackWithFade(currentActivePadKey, 0.5);
        this.columnActiveTrack.delete(col);
      }

      // Red (col 0) and Green (col 4) are independent DJ decks and can play simultaneously!
      // No automatic slider movement: user manually blends via the crossfader slider.
      this.startTrack(row, col, padKey, buffer, isRed ? this.redBusGain : this.greenBusGain, isLoop);
    }

    startTrack(row, col, padKey, buffer, busGainNode, isLoop = false) {
      const now = this.ctx.currentTime;
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = Boolean(isLoop);

      const trackGain = this.ctx.createGain();
      trackGain.gain.setValueAtTime(1.0, now);

      source.connect(trackGain);
      trackGain.connect(busGainNode);

      source.start(now);

      const trackInfo = { source, gainNode: trackGain, row, col, padKey };
      this.activeTracks.set(padKey, trackInfo);
      this.columnActiveTrack.set(col, padKey);

      if (this.onTrackStateChange) {
        this.onTrackStateChange(padKey, true);
      }

      source.onended = () => {
        try {
          source.disconnect();
          trackGain.disconnect();
        } catch (e) {}
        this.activeTracks.delete(padKey);
        if (this.columnActiveTrack.get(col) === padKey) {
          this.columnActiveTrack.delete(col);
        }
        if (this.onTrackStateChange) {
          this.onTrackStateChange(padKey, false);
        }
      };
    }

    stopTrackWithFade(padKey, fadeDuration = 0.5) {
      const track = this.activeTracks.get(padKey);
      if (!track) return;

      const now = this.ctx.currentTime;
      track.gainNode.gain.cancelScheduledValues(now);
      track.gainNode.gain.setValueAtTime(track.gainNode.gain.value, now);
      track.gainNode.gain.linearRampToValueAtTime(0.0001, now + fadeDuration);

      setTimeout(() => {
        try {
          track.source.stop();
          track.source.disconnect();
        } catch (e) {}
        this.activeTracks.delete(padKey);
        if (this.onTrackStateChange) {
          this.onTrackStateChange(padKey, false);
        }
      }, fadeDuration * 1000 + 50);
    }

    handleOneShotPlay(row, col, padKey, buffer, isLoop = false) {
      // Tapping already-playing one-shot/blue track stops it
      if (this.activeTracks.has(padKey)) {
        this.stopTrackWithFade(padKey, 0.15);
        return;
      }

      const now = this.ctx.currentTime;
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = Boolean(isLoop);

      const trackGain = this.ctx.createGain();
      trackGain.gain.setValueAtTime(1.0, now);

      source.connect(trackGain);
      trackGain.connect(this.blueBusGain);

      source.start(now);

      const trackInfo = { source, gainNode: trackGain, row, col, padKey };
      this.activeTracks.set(padKey, trackInfo);

      if (this.onTrackStateChange) {
        this.onTrackStateChange(padKey, true);
      }

      source.onended = () => {
        try {
          source.disconnect();
          trackGain.disconnect();
        } catch (e) {}
        this.activeTracks.delete(padKey);
        if (this.onTrackStateChange) {
          this.onTrackStateChange(padKey, false);
        }
      };
    }

    setTrackLoop(padKey, isLoop) {
      const track = this.activeTracks.get(padKey);
      if (track && track.source) {
        track.source.loop = Boolean(isLoop);
      }
    }

    stopAll() {
      for (const [key, track] of this.activeTracks.entries()) {
        try {
          track.source.stop();
          track.source.disconnect();
        } catch (e) {}
      }
      this.activeTracks.clear();
      this.columnActiveTrack.clear();
    }

    async generateDefaultSampleBuffer(row, col) {
      if (!this.ctx) this.init();
      const sampleRate = this.ctx.sampleRate || 44100;

      if (col === 0) {
        return this.synthesizeDrumLoop(row, sampleRate);
      } else if (col === 4) {
        return this.synthesizeMelodicLoop(row, sampleRate);
      } else {
        return this.synthesizeOneShot(row, col, sampleRate);
      }
    }

    synthesizeDrumLoop(row, sampleRate) {
      const duration = 4.0;
      const length = Math.floor(sampleRate * duration);
      const buffer = this.ctx.createBuffer(2, length, sampleRate);
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);

      const bpm = 120;
      const sixteenth = (60 / bpm) / 4;

      for (let step = 0; step < 32; step++) {
        const time = step * sixteenth;
        const startIdx = Math.floor(time * sampleRate);

        const isKick = (step % 8 === 0) || (row % 2 === 1 && step % 8 === 6) || (row >= 4 && step === 10);
        if (isKick) this.addKick(left, right, startIdx, sampleRate, 0.25);

        const isSnare = (step % 8 === 4) || (row >= 2 && step === 28 && row % 2 === 0);
        if (isSnare) this.addSnare(left, right, startIdx, sampleRate, 0.2);

        const isHat = (step % 2 === 1) || (row >= 3 && step % 4 === 2);
        if (isHat) this.addHiHat(left, right, startIdx, sampleRate, 0.08, step % 4 === 2);
      }
      return buffer;
    }

    synthesizeMelodicLoop(row, sampleRate) {
      const duration = 4.0;
      const length = Math.floor(sampleRate * duration);
      const buffer = this.ctx.createBuffer(2, length, sampleRate);
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);

      const baseFreqs = [87.31, 98.00, 110.0, 130.81, 146.83, 164.81, 174.61, 196.00];
      const root = baseFreqs[row % baseFreqs.length];
      const sixteenth = (60 / 120) / 4;
      const pattern = [0, 3, 5, 7, 10, 7, 5, 3, 0, -2, 0, 3, 5, 7, 12, 10];

      for (let step = 0; step < 32; step++) {
        const pIdx = (step + row * 2) % pattern.length;
        const semitone = pattern[pIdx];
        const freq = root * Math.pow(2, semitone / 12);
        const startIdx = Math.floor(step * sixteenth * sampleRate);
        const noteLen = Math.floor((sixteenth * (step % 2 === 0 ? 1.8 : 0.9)) * sampleRate);

        for (let i = 0; i < noteLen && (startIdx + i) < length; i++) {
          const t = i / sampleRate;
          const env = Math.exp(-t * 6);
          const wave = Math.sin(2 * Math.PI * freq * t) * 0.5 + Math.sin(4 * Math.PI * freq * t) * 0.25;
          const val = wave * env * 0.35;
          left[startIdx + i] += val;
          right[startIdx + i] += val * 0.9;
        }
      }
      return buffer;
    }

    synthesizeOneShot(row, col, sampleRate) {
      const type = (row + col * 8) % 12;
      let duration = 0.6;
      if (type >= 8) duration = 1.0;

      const length = Math.floor(sampleRate * duration);
      const buffer = this.ctx.createBuffer(2, length, sampleRate);
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);

      switch (type) {
        case 0:
          for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            const freq = 1200 * Math.exp(-t * 12) + 100;
            const env = Math.exp(-t * 8);
            const val = Math.sin(2 * Math.PI * freq * t) * env * 0.5;
            left[i] = val; right[i] = val;
          }
          break;
        case 1:
          for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            const noise = (Math.random() * 2 - 1);
            const env = Math.exp(-t * 14) + (t < 0.04 ? Math.random() * 0.3 : 0);
            const val = noise * env * 0.4;
            left[i] = val; right[i] = val * 0.9;
          }
          break;
        case 2:
          const chordNotes = [261.63, 329.63, 392.0, 523.25];
          for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            const env = Math.exp(-t * 4);
            let sum = 0;
            for (const cn of chordNotes) sum += Math.sin(2 * Math.PI * cn * t);
            const val = (sum / chordNotes.length) * env * 0.5;
            left[i] = val; right[i] = val;
          }
          break;
        case 3:
          for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            const freq = 180 * Math.exp(-t * 4) + 40;
            const env = Math.exp(-t * 2);
            const val = Math.sin(2 * Math.PI * freq * t) * env * 0.7;
            left[i] = val; right[i] = val;
          }
          break;
        case 4:
          for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            const env = Math.exp(-t * 30);
            const val = (Math.sin(2 * Math.PI * 850 * t) + Math.sin(2 * Math.PI * 1200 * t) * 0.5) * env * 0.6;
            left[i] = val; right[i] = val;
          }
          break;
        case 5:
          for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            const env = Math.sin(Math.min(Math.PI, t * 25)) * Math.exp(-t * 8);
            const noise = (Math.random() * 2 - 1);
            const val = noise * env * 0.35;
            left[i] = val; right[i] = val * 0.8;
          }
          break;
        case 6:
          for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            const env = Math.exp(-t * 3);
            const val = (Math.sin(2 * Math.PI * 1046.5 * t) + Math.sin(2 * Math.PI * 1568 * t) * 0.4) * env * 0.4;
            left[i] = val; right[i] = val;
          }
          break;
        case 7:
          for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            const freq = 2400 * Math.exp(-t * 20) + 200;
            const env = Math.exp(-t * 10);
            const val = (Math.random() > 0.5 ? 1 : -1) * 0.2 * env + Math.sin(2 * Math.PI * freq * t) * 0.4 * env;
            left[i] = val; right[i] = val;
          }
          break;
        default:
          for (let i = 0; i < length; i++) {
            const t = i / sampleRate;
            const env = (t / duration) * (1 - t / duration) * 3;
            const noise = (Math.random() * 2 - 1);
            const mod = Math.sin(2 * Math.PI * (200 + 800 * (t / duration)) * t);
            const val = (noise * 0.5 + mod * 0.5) * env * 0.4;
            left[i] = val; right[i] = val;
          }
          break;
      }
      return buffer;
    }

    addKick(left, right, startIdx, sampleRate, dur) {
      const len = Math.min(Math.floor(dur * sampleRate), left.length - startIdx);
      for (let i = 0; i < len; i++) {
        const t = i / sampleRate;
        const freq = 140 * Math.exp(-t * 25) + 45;
        const env = Math.exp(-t * 10);
        const val = Math.sin(2 * Math.PI * freq * t) * env * 0.7;
        left[startIdx + i] += val; right[startIdx + i] += val;
      }
    }

    addSnare(left, right, startIdx, sampleRate, dur) {
      const len = Math.min(Math.floor(dur * sampleRate), left.length - startIdx);
      for (let i = 0; i < len; i++) {
        const t = i / sampleRate;
        const toneEnv = Math.exp(-t * 18);
        const noiseEnv = Math.exp(-t * 12);
        const tone = Math.sin(2 * Math.PI * 185 * t) * toneEnv * 0.4;
        const noise = (Math.random() * 2 - 1) * noiseEnv * 0.35;
        const val = tone + noise;
        left[startIdx + i] += val; right[startIdx + i] += val;
      }
    }

    addHiHat(left, right, startIdx, sampleRate, dur, open = false) {
      const len = Math.min(Math.floor(dur * sampleRate), left.length - startIdx);
      const decay = open ? 15 : 45;
      for (let i = 0; i < len; i++) {
        const t = i / sampleRate;
        const env = Math.exp(-t * decay);
        const noise = (Math.random() * 2 - 1) * env * 0.25;
        left[startIdx + i] += noise; right[startIdx + i] += noise;
      }
    }
  }

  const audioEngine = new AudioEngine();

  /* ==========================================================================
     3. App Controller & DOM
     ========================================================================== */
  const ROWS = 8;
  const COLS = 5;
  const ROW_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const NUM_PRESETS = 10;

  let currentPresetId = 1;
  let currentPresetData = null;
  let isLocked = false;
  let editingPadCoord = null;

  const padGrid = document.getElementById('pad-grid');
  const presetSelect = document.getElementById('preset-select');
  const renameBtn = document.getElementById('rename-preset-btn');
  const resetPresetBtn = document.getElementById('reset-preset-btn');
  const lockBtn = document.getElementById('lock-btn');
  const lockStatusText = document.getElementById('lock-status-text');
  const exportBtn = document.getElementById('export-backup-btn');
  const importBtn = document.getElementById('import-backup-btn');
  const sampleFileInput = document.getElementById('sample-file-input');
  const backupFileInput = document.getElementById('backup-file-input');

  const renameModal = document.getElementById('rename-modal');
  const renameInput = document.getElementById('rename-input');
  const modalCancelBtn = document.getElementById('modal-cancel-btn');
  const modalSaveBtn = document.getElementById('modal-save-btn');

  const resetModal = document.getElementById('reset-modal');
  const resetModalPresetName = document.getElementById('reset-modal-preset-name');
  const resetModalCancelBtn = document.getElementById('reset-modal-cancel-btn');
  const resetModalConfirmBtn = document.getElementById('reset-modal-confirm-btn');

  const crossfaderSlider = document.getElementById('crossfader-slider');
  const redVolDisp = document.getElementById('red-vol-disp');
  const greenVolDisp = document.getElementById('green-vol-disp');
  const faderCenterBadge = document.getElementById('fader-center-badge');
  const toastEl = document.getElementById('toast');

  // Loading Overlay Elements
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingTitle = document.getElementById('loading-title');
  const loadingMessage = document.getElementById('loading-message');
  const loadingProgressBar = document.getElementById('loading-progress-bar');

  function showLoading(title, message, progress = 0) {
    if (!loadingOverlay) return;
    loadingTitle.textContent = title;
    loadingMessage.textContent = message;
    loadingProgressBar.style.width = `${Math.min(100, Math.max(0, progress))}%`;
    loadingOverlay.hidden = false;
    loadingOverlay.style.display = 'flex';
  }

  function updateLoading(message, progress = null) {
    if (!loadingOverlay) return;
    if (message) loadingMessage.textContent = message;
    if (progress !== null) {
      loadingProgressBar.style.width = `${Math.min(100, Math.max(0, progress))}%`;
    }
  }

  function hideLoading() {
    if (!loadingOverlay) return;
    loadingOverlay.hidden = true;
    loadingOverlay.style.display = 'none';
  }

  // Pad Sample Assignment Modal (100% reliable on iOS Safari)
  const sampleModal = document.getElementById('sample-modal');
  const sampleModalTitle = document.getElementById('sample-modal-title');
  const sampleModalDesc = document.getElementById('sample-modal-desc');
  const sampleModalCurrent = document.getElementById('sample-modal-current');
  const sampleModalChooseBtn = document.getElementById('sample-modal-choose-btn');
  const sampleModalCancelBtn = document.getElementById('sample-modal-cancel-btn');

  function openSampleModal(row, col) {
    if (!sampleModal) return;
    const rowLetter = ROW_NAMES[row];
    const padKey = `${col}_${row}`;
    const padConfig = currentPresetData?.pads[padKey];
    const currentName = padConfig?.name || '(未設定)';

    editingPadCoord = { row, col };
    sampleModalTitle.textContent = `パッド [${rowLetter}${col + 1}] の曲を変更`;
    sampleModalCurrent.textContent = currentName;
    sampleModal.hidden = false;
    sampleModal.style.display = 'flex';
  }

  function closeSampleModal() {
    if (!sampleModal) return;
    sampleModal.hidden = true;
    sampleModal.style.display = 'none';
  }

  sampleModalCancelBtn.addEventListener('click', closeSampleModal);

  sampleModalChooseBtn.addEventListener('click', () => {
    closeSampleModal();
    // Direct user tap event: 100% allowed on iOS Safari!
    sampleFileInput.value = '';
    sampleFileInput.click();
  });

  async function initApp() {
    await openDB();

    currentPresetId = await getSetting('activePresetId', 1);
    isLocked = await getSetting('isLocked', false);
    let savedFader = await getSetting('faderPosition', 0.5);
    const faderVersion = await getSetting('faderVersion', 1);
    if (faderVersion < 2 || typeof savedFader !== 'number' || savedFader < 0.0 || savedFader > 1.0) {
      savedFader = 0.5;
      await setSetting('faderPosition', 0.5);
      await setSetting('faderVersion', 2);
    }

    updateLockUI();

    audioEngine.onFaderChange = (pos) => {
      updateFaderUI(pos);
    };

    audioEngine.onTrackStateChange = (padKey, isPlaying) => {
      const padEl = document.querySelector(`[data-pad-key="${padKey}"]`);
      if (padEl) {
        if (isPlaying) {
          padEl.classList.add('is-playing');
        } else {
          padEl.classList.remove('is-playing');
        }
      }
    };

    crossfaderSlider.value = savedFader;
    audioEngine.setFaderPosition(savedFader, true);
    updateFaderUI(savedFader);

    await ensurePresetsExist();
    await refreshPresetDropdown();
    await loadPreset(currentPresetId);

    setupEventListeners();
    showToast('準備完了！タップして演奏を開始できます');
  }

  async function ensurePresetsExist() {
    const existing = await getAllPresets();
    if (existing.length < NUM_PRESETS) {
      for (let i = 1; i <= NUM_PRESETS; i++) {
        const found = existing.find((p) => p.id === i);
        if (!found) {
          const defaultPreset = {
            id: i,
            name: `Preset ${i}`,
            pads: {},
          };

          if (i === 1) {
            for (let r = 0; r < ROWS; r++) {
              for (let c = 0; c < COLS; c++) {
                const key = `${c}_${r}`;
                defaultPreset.pads[key] = {
                  sampleId: `builtin_p1_${key}`,
                  name: getDefaultTrackName(r, c),
                  artist: '',
                  loop: false,
                };
              }
            }
          }
          await savePreset(defaultPreset);
        }
      }
    }
  }

  function getDefaultTrackName(row, col) {
    const rowLetter = ROW_NAMES[row];
    if (col === 0) {
      const beatNames = ['Club Beat', 'House 4x4', 'Breakbeat', 'Trap Rhythm', 'Tech Groove', 'Funk Drum', 'Electro Kit', 'Afro Beat'];
      return `${rowLetter}: ${beatNames[row]}`;
    } else if (col === 4) {
      const synthNames = ['Deep Bass', 'Acid Line', 'Cyber Lead', 'Retro Arp', 'Dub Synth', 'Pluck Melody', 'Sub Pulse', 'Neon Bass'];
      return `${rowLetter}: ${synthNames[row]}`;
    } else {
      const shotTypes = [
        ['Laser Zap', 'Clap 909', 'C Major Chord'],
        ['Sub Boom', 'Wood Rim', 'Shaker Hit'],
        ['Bell Tone', 'Zap Glitch', 'Air Sweep'],
        ['Synth Hit', 'Snare Roll', 'Chord Stab'],
        ['Low Drop', 'Hi Tom', 'Vocal Chop'],
        ['Click FX', 'Noise Burst', 'Stab Echo'],
        ['Metal Hit', 'Reverse Cym', 'Alarm Lead'],
        ['Filter Sweep', 'Impact FX', 'Vinyl Scratch'],
      ];
      const name = shotTypes[row] ? shotTypes[row][col - 1] : `SFX ${rowLetter}`;
      return `${rowLetter}: ${name}`;
    }
  }

  async function refreshPresetDropdown() {
    const presets = await getAllPresets();
    presetSelect.innerHTML = '';
    presets.sort((a, b) => a.id - b.id).forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.id}. ${p.name}`;
      if (p.id === currentPresetId) opt.selected = true;
      presetSelect.appendChild(opt);
    });
  }

  async function loadPreset(presetId) {
    currentPresetId = presetId;
    await setSetting('activePresetId', presetId);
    presetSelect.value = presetId;

    audioEngine.stopAll();

    currentPresetData = await getPreset(presetId);
    if (!currentPresetData) {
      currentPresetData = { id: presetId, name: `Preset ${presetId}`, pads: {} };
      await savePreset(currentPresetData);
    }

    // Render Grid immediately for instant UI feedback
    renderGrid();

    // Pre-load / decode audio buffers for this preset
    await loadPresetAudioBuffers(currentPresetData);
  }

  async function loadPresetAudioBuffers(preset) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const key = `${c}_${r}`;
        const padConfig = preset.pads[key];

        if (padConfig && padConfig.sampleId) {
          if (audioEngine.hasBuffer(padConfig.sampleId)) continue;

          const sampleRecord = await getSample(padConfig.sampleId);
          if (sampleRecord && sampleRecord.data) {
            try {
              const audioBuffer = await audioEngine.decodeAudioData(sampleRecord.data);
              audioEngine.setCachedBuffer(padConfig.sampleId, audioBuffer);
            } catch (e) {
              console.warn(`Failed to decode sample ${padConfig.sampleId}`, e);
            }
          } else if (padConfig.sampleId.startsWith('builtin_')) {
            try {
              const synthBuffer = await audioEngine.generateDefaultSampleBuffer(r, c);
              audioEngine.setCachedBuffer(padConfig.sampleId, synthBuffer);
              const wavBuffer = audioBufferToWav(synthBuffer);
              await saveSample(padConfig.sampleId, padConfig.name, 'audio/wav', wavBuffer);
            } catch (e) {
              console.error('Failed synthesizing built-in sound', e);
            }
          }
        }
      }
    }
  }

  function renderGrid() {
    padGrid.innerHTML = '';

    for (let r = 0; r < ROWS; r++) {
      const rowLetter = ROW_NAMES[r];

      for (let c = 0; c < COLS; c++) {
        const key = `${c}_${r}`;
        const padConfig = currentPresetData?.pads[key];
        const trackName = padConfig ? padConfig.name : `${rowLetter}${c + 1}`;
        const artistName = padConfig?.artist || '';
        const isLoop = Boolean(padConfig?.loop);

        const pad = document.createElement('div');
        pad.className = 'pad-cell';
        pad.dataset.row = r;
        pad.dataset.col = c;
        pad.dataset.padKey = key;

        if (c === 0) pad.classList.add('col-red');
        else if (c === 4) pad.classList.add('col-green');
        else pad.classList.add('col-blue');

        let modeTag = 'SHOT';
        if (c === 0) modeTag = 'TRACK L';
        else if (c === 4) modeTag = 'TRACK R';

        pad.innerHTML = `
          <div class="pad-meta">
            <span class="pad-coord">${rowLetter}${c + 1}</span>
            <span class="pad-mode-tag">${modeTag}</span>
          </div>
          <button type="button" class="pad-rpt-btn ${isLoop ? 'active' : ''}" data-pad-key="${key}" title="リピート (ON/OFF)" aria-label="リピート切替">
            <span class="rpt-label">rpt</span>
            <span class="rpt-check">${isLoop ? '☑' : '☐'}</span>
          </button>
          <div class="pad-titles">
            <div class="pad-name" title="${trackName}">${escapeHtml(trackName)}</div>
            ${artistName ? `<div class="pad-artist" title="${artistName}">${escapeHtml(artistName)}</div>` : ''}
          </div>
          <div class="pad-wave-decor">
            <span class="pad-wave-bar"></span>
            <span class="pad-wave-bar"></span>
            <span class="pad-wave-bar"></span>
            <span class="pad-wave-bar"></span>
            <span class="pad-wave-bar"></span>
          </div>
          <div class="pad-hold-progress"></div>
        `;

        attachPadEvents(pad, r, c, key);
        padGrid.appendChild(pad);
      }
    }
  }

  function attachPadEvents(padEl, row, col, padKey) {
    let holdTimer = null;
    let startX = 0;
    let startY = 0;
    let isMoved = false;
    let isLongPressCompleted = false;

    // Prevent iOS native context menu on long press
    padEl.addEventListener('contextmenu', (e) => e.preventDefault());

    // Repeat (rpt) toggle event handling with strict isolation (stopPropagation)
    const rptBtn = padEl.querySelector('.pad-rpt-btn');
    if (rptBtn) {
      const stopProp = (e) => e.stopPropagation();
      rptBtn.addEventListener('pointerdown', stopProp);
      rptBtn.addEventListener('pointerup', stopProp);
      rptBtn.addEventListener('touchstart', stopProp, { passive: false });
      rptBtn.addEventListener('touchend', stopProp, { passive: false });
      rptBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!currentPresetData.pads) currentPresetData.pads = {};
        if (!currentPresetData.pads[padKey]) {
          currentPresetData.pads[padKey] = {
            sampleId: `builtin_p${currentPresetId}_${padKey}`,
            name: getDefaultTrackName(row, col),
            artist: '',
            loop: false,
          };
        }
        const cfg = currentPresetData.pads[padKey];
        cfg.loop = !Boolean(cfg.loop);
        const newLoop = cfg.loop;

        // Visual update
        if (newLoop) {
          rptBtn.classList.add('active');
          const checkEl = rptBtn.querySelector('.rpt-check');
          if (checkEl) checkEl.textContent = '☑';
        } else {
          rptBtn.classList.remove('active');
          const checkEl = rptBtn.querySelector('.rpt-check');
          if (checkEl) checkEl.textContent = '☐';
        }

        // Realtime update to playing AudioBufferSourceNode
        audioEngine.setTrackLoop(padKey, newLoop);

        // Persist to IndexedDB
        await savePreset(currentPresetData);

        const rowLetter = ROW_NAMES[row];
        showToast(newLoop ? `[${rowLetter}${col + 1}] リピート: ON (ループ再生)` : `[${rowLetter}${col + 1}] リピート: OFF (ワンショット)`);
      });
    }

    const cancelHold = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      padEl.classList.remove('holding');
      padEl.classList.remove('hold-complete');
    };

    padEl.addEventListener('pointerdown', (e) => {
      audioEngine.unlock();

      startX = e.clientX;
      startY = e.clientY;
      isMoved = false;
      isLongPressCompleted = false;

      if (!isLocked) {
        padEl.classList.add('holding');
        holdTimer = setTimeout(() => {
          isLongPressCompleted = true;
          padEl.classList.remove('holding');
          padEl.classList.add('hold-complete');
          if (navigator.vibrate) {
            navigator.vibrate(60);
          }
          showToast('指を離すと曲選択が開きます');
        }, 1000);
      }
    });

    padEl.addEventListener('pointermove', (e) => {
      if (!holdTimer && !isLongPressCompleted) return;
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);
      if (dx > 12 || dy > 12) {
        isMoved = true;
        isLongPressCompleted = false;
        cancelHold();
      }
    });

    padEl.addEventListener('pointerup', () => {
      // If long press completed, trigger file picker inside direct user gesture (pointerup)
      if (isLongPressCompleted) {
        isLongPressCompleted = false;
        cancelHold();
        triggerFileAssign(row, col);
        return;
      }

      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
        cancelHold();

        if (!isMoved) {
          audioEngine.unlock();
          handlePadTap(row, col, padKey);
        }
      }
    });

    padEl.addEventListener('pointercancel', () => {
      isLongPressCompleted = false;
      cancelHold();
    });

    padEl.addEventListener('pointerleave', () => {
      isLongPressCompleted = false;
      cancelHold();
    });
  }

  async function handlePadTap(row, col, padKey) {
    const padConfig = currentPresetData?.pads[padKey];
    if (!padConfig || !padConfig.sampleId) {
      showToast('音声が登録されていません。長押しでファイルを選択してください。');
      return;
    }

    if (!audioEngine.hasBuffer(padConfig.sampleId)) {
      const sampleRecord = await getSample(padConfig.sampleId);
      if (sampleRecord && sampleRecord.data) {
        const buffer = await audioEngine.decodeAudioData(sampleRecord.data);
        audioEngine.setCachedBuffer(padConfig.sampleId, buffer);
      } else {
        showToast('音源データの読み込みに失敗しました。');
        return;
      }
    }

    const isLoop = Boolean(padConfig?.loop);
    audioEngine.triggerPad(row, col, padConfig.sampleId, isLoop);
  }

  function triggerFileAssign(row, col) {
    editingPadCoord = { row, col };

    // Try direct native file picker click within user gesture (pointerup)
    try {
      sampleFileInput.value = '';
      sampleFileInput.click();
    } catch (e) {
      console.warn('Native file input click failed', e);
    }

    // Also open modal dialog as reliable fallback for iOS Safari
    setTimeout(() => {
      openSampleModal(row, col);
    }, 120);
  }

  sampleFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !editingPadCoord) return;

    const { row, col } = editingPadCoord;
    const padKey = `${col}_${row}`;
    const sampleId = `custom_${Date.now()}_${padKey}`;

    showToast(`音声ファイル「${file.name}」を読み込み中...`);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await audioEngine.decodeAudioData(arrayBuffer);

      // Parse metadata tags (ID3v2, MP4/M4A, FLAC, WAV)
      const meta = parseAudioMetadata(arrayBuffer);
      const fallbackName = file.name.replace(/\.[^/.]+$/, '');
      const trackTitle = meta.title || fallbackName;
      const artistName = meta.artist || '';

      await saveSample(sampleId, file.name, file.type || 'audio/wav', arrayBuffer);
      audioEngine.setCachedBuffer(sampleId, audioBuffer);

      const existingLoop = Boolean(currentPresetData.pads[padKey]?.loop);
      currentPresetData.pads[padKey] = {
        sampleId,
        name: trackTitle,
        artist: artistName,
        loop: existingLoop,
      };
      await savePreset(currentPresetData);

      // Refresh pad grid to reflect title and artist
      renderGrid();

      const toastLabel = artistName ? `${trackTitle} - ${artistName}` : trackTitle;
      showToast(`「${toastLabel}」を割り当てました！`);
    } catch (err) {
      console.error('Audio file decode failed', err);
      alert('音声ファイルのデコードに失敗しました。対応フォーマット（WAV, MP3, AAC, FLAC）であることをご確認ください。');
    } finally {
      editingPadCoord = null;
    }
  });

  crossfaderSlider.addEventListener('input', (e) => {
    const rawVal = parseFloat(e.target.value);
    audioEngine.setFaderPosition(rawVal, false);
    updateFaderUI(audioEngine.getFaderPosition());
  });

  crossfaderSlider.addEventListener('change', async (e) => {
    const rawVal = parseFloat(e.target.value);
    audioEngine.setFaderPosition(rawVal, true);
    await setSetting('faderPosition', audioEngine.getFaderPosition());
  });

  function updateFaderUI(pos) {
    crossfaderSlider.value = pos.toFixed(3);

    if (Math.abs(pos - 0.5) <= 0.005) {
      faderCenterBadge.classList.add('snapped');
    } else {
      faderCenterBadge.classList.remove('snapped');
    }

    let redPercent = 100;
    let greenPercent = 100;

    // DJ crossfader volume calculation:
    // Left end (0.0): Red 100%, Green 0%
    // Range 0.0 ~ 0.5: Red 100%, Green 0% -> 100%
    // Center (0.5): Red 100%, Green 100% (Both MAX blend)
    // Range 0.5 ~ 1.0: Red 100% -> 0%, Green 100%
    // Right end (1.0): Red 0%, Green 100%
    if (pos <= 0.5) {
      redPercent = 100;
      greenPercent = Math.round(Math.max(0, Math.min(1, pos / 0.5)) * 100);
    } else {
      redPercent = Math.round(Math.max(0, Math.min(1, (1.0 - pos) / 0.5)) * 100);
      greenPercent = 100;
    }

    redVolDisp.textContent = `${redPercent}%`;
    greenVolDisp.textContent = `${greenPercent}%`;
  }

  lockBtn.addEventListener('click', async () => {
    isLocked = !isLocked;
    await setSetting('isLocked', isLocked);
    updateLockUI();
    showToast(isLocked ? '🔒 誤操作防止ロック中（編集不可）' : '🔓 ロック解除（長押しで編集可能）');
  });

  function updateLockUI() {
    if (isLocked) {
      lockBtn.classList.remove('unlocked');
      lockBtn.classList.add('locked');
      lockStatusText.textContent = 'ロック中';
    } else {
      lockBtn.classList.remove('locked');
      lockBtn.classList.add('unlocked');
      lockStatusText.textContent = '編集可能';
    }
  }

  presetSelect.addEventListener('change', async (e) => {
    const id = parseInt(e.target.value, 10);
    await loadPreset(id);
    showToast(`プリセット ${id} を読み込みました`);
  });

  renameBtn.addEventListener('click', () => {
    renameInput.value = currentPresetData?.name || `Preset ${currentPresetId}`;
    renameModal.hidden = false;
    renameModal.style.display = 'flex';
    renameInput.focus();
  });

  modalCancelBtn.addEventListener('click', () => {
    renameModal.hidden = true;
    renameModal.style.display = 'none';
  });

  modalSaveBtn.addEventListener('click', async () => {
    const newName = renameInput.value.trim();
    if (newName) {
      currentPresetData.name = newName;
      await savePreset(currentPresetData);
      await refreshPresetDropdown();
      showToast(`プリセット名を「${newName}」に変更しました`);
    }
    renameModal.hidden = true;
    renameModal.style.display = 'none';
  });

  renameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') modalSaveBtn.click();
    if (e.key === 'Escape') modalCancelBtn.click();
  });

  // Reset Preset to Default Built-in Sounds
  resetPresetBtn.addEventListener('click', () => {
    if (!currentPresetData) return;
    resetModalPresetName.textContent = currentPresetData.name || `Preset ${currentPresetId}`;
    resetModal.hidden = false;
    resetModal.style.display = 'flex';
  });

  resetModalCancelBtn.addEventListener('click', () => {
    resetModal.hidden = true;
    resetModal.style.display = 'none';
  });

  resetModalConfirmBtn.addEventListener('click', async () => {
    resetModal.hidden = true;
    resetModal.style.display = 'none';

    if (!currentPresetData) return;

    audioEngine.stopAll();
    showLoading('プリセット初期化中', '標準音源を生成しています...', 30);

    try {
      if (!currentPresetData.pads) currentPresetData.pads = {};
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const key = `${c}_${r}`;
          currentPresetData.pads[key] = {
            sampleId: `builtin_p${currentPresetId}_${key}`,
            name: getDefaultTrackName(r, c),
            artist: '',
            loop: false,
          };
        }
      }
      await savePreset(currentPresetData);
      renderGrid();

      updateLoading('音声データを読み込んでいます...', 75);
      await loadPresetAudioBuffers(currentPresetData);

      hideLoading();
      showToast(`「${currentPresetData.name}」の全曲を初期状態に戻しました`);
    } catch (err) {
      hideLoading();
      console.error('Reset preset failed', err);
      alert('プリセットの初期化に失敗しました: ' + err.message);
    }
  });

  exportBtn.addEventListener('click', async () => {
    try {
      showLoading('バックアップ作成中', '音声データを圧縮しています... 0%', 0);
      const blob = await exportBackupZip((pct) => {
        updateLoading(`音声データを圧縮しています... ${pct}%`, pct);
      });
      hideLoading();

      const url = URL.createObjectURL(blob);
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const a = document.createElement('a');
      a.href = url;
      a.download = `rem_ixr_backup_${dateStr}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('ZIPバックアップファイルを保存しました');
    } catch (err) {
      hideLoading();
      console.error('Export failed', err);
      alert('バックアップの書き出しに失敗しました: ' + err.message);
    }
  });

  importBtn.addEventListener('click', () => {
    backupFileInput.value = '';
    backupFileInput.click();
  });

  backupFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!confirm('既存の全プリセットおよび音声データが上書きされます。復元を続行しますか？')) {
      return;
    }

    try {
      showLoading('バックアップ復元中', 'アーカイブを展開しています... 0%', 0);
      await importBackupZip(file, (pct) => {
        updateLoading(`音声データを展開しています... ${pct}%`, pct);
      });

      updateLoading('画面を更新しています...', 100);
      audioEngine.stopAll();
      currentPresetId = await getSetting('activePresetId', 1);
      await refreshPresetDropdown();
      await loadPreset(currentPresetId);

      hideLoading();
      showToast('バックアップの復元が完了しました！');
    } catch (err) {
      hideLoading();
      console.error('Import failed', err);
      alert('復元に失敗しました。ファイルが破損しているか無効なフォーマットです: ' + err.message);
    }
  });

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(() => {
      toastEl.classList.remove('show');
    }, 2200);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setupEventListeners() {
    document.addEventListener('gesturestart', (e) => e.preventDefault());

    // User gesture unlock listener
    const unlockAudioOnGesture = () => {
      audioEngine.unlock();
    };
    window.addEventListener('pointerdown', unlockAudioOnGesture);
    window.addEventListener('touchstart', unlockAudioOnGesture, { passive: true });
    window.addEventListener('touchend', unlockAudioOnGesture, { passive: true });
    window.addEventListener('click', unlockAudioOnGesture);

    // Responsive orientation & compact landscape mode handler
    function updateCompactLandscapeMode() {
      const isLandscape = window.innerWidth > window.innerHeight;
      const isShort = window.innerHeight <= 560;
      if (isLandscape && isShort) {
        document.documentElement.classList.add('compact-landscape');
        document.body.classList.add('compact-landscape');
      } else {
        document.documentElement.classList.remove('compact-landscape');
        document.body.classList.remove('compact-landscape');
      }
    }
    window.addEventListener('resize', updateCompactLandscapeMode);
    window.addEventListener('orientationchange', () => {
      setTimeout(updateCompactLandscapeMode, 80);
      setTimeout(updateCompactLandscapeMode, 300);
    });
    updateCompactLandscapeMode();
  }

  function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = 1;
    const bitDepth = 16;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;

    const length = buffer.length * numChannels * bytesPerSample;
    const wavBuffer = new ArrayBuffer(44 + length);
    const view = new DataView(wavBuffer);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + length, true);
    writeString(view, 8, 'WAVE');

    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);

    writeString(view, 36, 'data');
    view.setUint32(40, length, true);

    let offset = 44;
    const channels = [];
    for (let c = 0; c < numChannels; c++) {
      channels.push(buffer.getChannelData(c));
    }

    for (let i = 0; i < buffer.length; i++) {
      for (let c = 0; c < numChannels; c++) {
        let sample = channels[c][i];
        sample = Math.max(-1, Math.min(1, sample));
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(offset, intSample, true);
        offset += 2;
      }
    }
    return wavBuffer;
  }

  function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();
