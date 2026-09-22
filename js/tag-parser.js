/**
 * tag-parser.js - Lightweight native audio metadata parser
 * Extracts title and artist from ID3v2 (MP3/WAV), MP4/M4A (ilst), and FLAC (Vorbis Comment)
 * Zero external dependencies.
 */

export function parseAudioMetadata(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length < 32) return { title: null, artist: null };

  try {
    // 1. Check for ID3v2 (MP3 or WAV with ID3 chunk)
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) { // "ID3"
      return parseID3v2(bytes, 0);
    }

    // Check for WAV RIFF format containing 'id3 ' or 'INFO'
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) { // "RIFF"
      const wavMeta = parseWavMetadata(bytes);
      if (wavMeta.title || wavMeta.artist) return wavMeta;
    }

    // 2. Check for MP4/M4A (ftyp atom)
    if (isMp4(bytes)) {
      const mp4Meta = parseMp4Metadata(bytes);
      if (mp4Meta.title || mp4Meta.artist) return mp4Meta;
    }

    // 3. Check for FLAC (fLaC)
    if (bytes[0] === 0x66 && bytes[1] === 0x4C && bytes[2] === 0x61 && bytes[3] === 0x43) { // "fLaC"
      const flacMeta = parseFlacMetadata(bytes);
      if (flacMeta.title || flacMeta.artist) return flacMeta;
    }
  } catch (err) {
    console.warn('Metadata parsing exception:', err);
  }

  return { title: null, artist: null };
}

/* ==========================================================================
   ID3v2 Parser (MP3 / WAV)
   ========================================================================== */
function parseID3v2(bytes, offset) {
  const majorVersion = bytes[offset + 3];
  const size = (bytes[offset + 6] << 21) | (bytes[offset + 7] << 14) | (bytes[offset + 8] << 7) | bytes[offset + 9];
  const endOffset = Math.min(bytes.length, offset + 10 + size);

  let pos = offset + 10;
  let title = null;
  let artist = null;

  while (pos + 10 < endOffset) {
    // Frame ID (4 chars)
    const frameId = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    if (frameId.charCodeAt(0) === 0) break; // Padding reached

    let frameSize = 0;
    if (majorVersion === 4) {
      // Synchsafe integer in v2.4
      frameSize = (bytes[pos + 4] << 21) | (bytes[pos + 5] << 14) | (bytes[pos + 6] << 7) | bytes[pos + 7];
    } else {
      // Normal integer in v2.3
      frameSize = (bytes[pos + 4] << 24) | (bytes[pos + 5] << 16) | (bytes[pos + 6] << 8) | bytes[pos + 7];
    }

    if (frameSize <= 0 || pos + 10 + frameSize > endOffset) break;

    const frameData = bytes.subarray(pos + 10, pos + 10 + frameSize);

    if (frameId === 'TIT2') {
      title = decodeTextFrame(frameData);
    } else if (frameId === 'TPE1') {
      artist = decodeTextFrame(frameData);
    }

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
    if (encoding === 0) {
      // ISO-8859-1
      return new TextDecoder('iso-8859-1').decode(content);
    } else if (encoding === 1 || encoding === 2) {
      // UTF-16 with BOM / UTF-16BE
      return new TextDecoder('utf-16').decode(content);
    } else if (encoding === 3) {
      // UTF-8
      return new TextDecoder('utf-8').decode(content);
    }
  } catch (e) {
    // Fallback
    return new TextDecoder('utf-8').decode(content);
  }
  return null;
}

/* ==========================================================================
   WAV RIFF Parser (id3 or INFO chunks)
   ========================================================================== */
function parseWavMetadata(bytes) {
  let pos = 12; // Skip "RIFF" + size + "WAVE"
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
          infoPos += 8 + subSize + (subSize % 2); // Word aligned
        }
      }
    }

    pos += 8 + chunkSize + (chunkSize % 2);
  }

  return { title: cleanString(title), artist: cleanString(artist) };
}

/* ==========================================================================
   MP4 / M4A Atom Parser
   ========================================================================== */
function isMp4(bytes) {
  if (bytes.length < 8) return false;
  const atomType = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  return atomType === 'ftyp';
}

function parseMp4Metadata(bytes) {
  let pos = 0;
  let title = null;
  let artist = null;

  // Search for 'moov' -> 'udta' -> 'meta' -> 'ilst'
  function findAtom(start, end, targetName) {
    let p = start;
    while (p + 8 <= end && p < bytes.length) {
      const size = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
      const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
      if (size <= 0) break;
      if (type === targetName) {
        return { start: p + 8, end: p + size };
      }
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

  // 'meta' in MP4 often has 4 bytes of flags after header
  const ilst = findAtom(meta.start + 4, meta.end, 'ilst') || findAtom(meta.start, meta.end, 'ilst');
  if (!ilst) return { title: null, artist: null };

  let tagPos = ilst.start;
  while (tagPos + 8 < ilst.end) {
    const itemSize = (bytes[tagPos] << 24) | (bytes[tagPos + 1] << 16) | (bytes[tagPos + 2] << 8) | bytes[tagPos + 3];
    const itemType = String.fromCharCode(bytes[tagPos + 4], bytes[tagPos + 5], bytes[tagPos + 6], bytes[tagPos + 7]);

    if (itemSize <= 0 || tagPos + itemSize > ilst.end) break;

    // Inside item, find 'data' atom
    const dataAtom = findAtom(tagPos + 8, tagPos + itemSize, 'data');
    if (dataAtom) {
      // Skip 8 bytes header + 8 bytes type & locale
      const textBytes = bytes.subarray(dataAtom.start + 8, dataAtom.end);
      const text = new TextDecoder('utf-8').decode(textBytes);
      if (itemType === '©nam') title = text;
      if (itemType === '©ART' || itemType === 'aART') artist = text;
    }

    tagPos += itemSize;
  }

  return { title: cleanString(title), artist: cleanString(artist) };
}

/* ==========================================================================
   FLAC Vorbis Comment Parser
   ========================================================================== */
function parseFlacMetadata(bytes) {
  let pos = 4; // Skip "fLaC"
  let title = null;
  let artist = null;

  while (pos + 4 < bytes.length) {
    const header = bytes[pos];
    const isLast = (header & 0x80) !== 0;
    const blockType = header & 0x7F;
    const blockSize = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    pos += 4;

    if (blockType === 4) { // VORBIS_COMMENT
      let commentPos = pos;
      // Vendor length
      const vendorLen = bytes[commentPos] | (bytes[commentPos + 1] << 8) | (bytes[commentPos + 2] << 16) | (bytes[commentPos + 3] << 24);
      commentPos += 4 + vendorLen;

      // User comment list length
      const numComments = bytes[commentPos] | (bytes[commentPos + 1] << 8) | (bytes[commentPos + 2] << 16) | (bytes[commentPos + 3] << 24);
      commentPos += 4;

      for (let i = 0; i < numComments && commentPos + 4 < pos + blockSize; i++) {
        const commentLen = bytes[commentPos] | (bytes[commentPos + 1] << 8) | (bytes[commentPos + 2] << 16) | (bytes[commentPos + 3] << 24);
        commentPos += 4;
        const commentStr = new TextDecoder('utf-8').decode(bytes.subarray(commentPos, commentPos + commentLen));
        commentPos += commentLen;

        const eqIdx = commentStr.indexOf('=');
        if (eqIdx !== -1) {
          const key = commentStr.substring(0, eqIdx).toUpperCase();
          const val = commentStr.substring(eqIdx + 1);
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
  // Remove trailing null bytes or excess whitespace
  const cleaned = str.replace(/\0/g, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}
