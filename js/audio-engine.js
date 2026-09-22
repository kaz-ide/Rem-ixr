/**
 * audio-engine.js - Web Audio Engine for Music Remixer
 * Handles AudioContext unlocking, bus routing (Red, Blue, Green),
 * crossfader mechanics with central snap, exclusive loops, and one-shots.
 */

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.redBusGain = null;
    this.greenBusGain = null;
    this.blueBusGain = null;

    // Crossfader position: -1.0 (Full Red) to 0.0 (Mute) to +1.0 (Full Green)
    this.faderPosition = 0.0;

    // Active playing tracks map: key = `${col}_${row}` or column track
    // For exclusive columns (col 0 and col 4), only one track per column can play
    this.activeTracks = new Map(); // key: 'col_row' -> { source, gainNode, startTime }
    this.columnActiveTrack = new Map(); // col -> 'col_row'

    // Decoded audio buffers cache: key: sampleId -> AudioBuffer
    this.bufferCache = new Map();

    // Callbacks for UI updates (e.g. fader auto-move, track playback start/end)
    this.onFaderChange = null;
    this.onTrackStateChange = null;

    this.isUnlocked = false;
    this.faderAnimationId = null;
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

  // Initialize Web Audio API and create busses
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

    // Master Bus
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(0.9, this.ctx.currentTime);
    this.masterGain.connect(this.ctx.destination);

    // Red Bus (Col 0) - Connected to Master
    this.redBusGain = this.ctx.createGain();
    this.redBusGain.connect(this.masterGain);

    // Green Bus (Col 4) - Connected to Master
    this.greenBusGain = this.ctx.createGain();
    this.greenBusGain.connect(this.masterGain);

    // Blue Bus (Cols 1, 2, 3) - Connected to Master (Always 1.0)
    this.blueBusGain = this.ctx.createGain();
    this.blueBusGain.gain.setValueAtTime(1.0, this.ctx.currentTime);
    this.blueBusGain.connect(this.masterGain);

    this.updateBusGains();
  }

  // Unlock audio for iOS / Safari
  unlock() {
    if (!this.ctx) {
      this.init();
    }

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

  // Set Crossfader position (-1.0 to +1.0)
  setFaderPosition(value, notify = true) {
    let pos = Math.max(-1.0, Math.min(1.0, value));

    // Center snap within +/- 2%
    if (Math.abs(pos) <= 0.02) {
      pos = 0.0;
    }

    this.faderPosition = pos;
    this.updateBusGains();

    if (notify && this.onFaderChange) {
      this.onFaderChange(this.faderPosition);
    }
  }

  getFaderPosition() {
    return this.faderPosition;
  }

  // Update Red and Green bus gains based on crossfader position
  updateBusGains() {
    if (!this.ctx || !this.redBusGain || !this.greenBusGain) return;

    const now = this.ctx.currentTime;
    let redVol = 0.0;
    let greenVol = 0.0;

    if (this.faderPosition < 0.0) {
      // Left side: -1.0 (redVol=1.0) down to 0.0 (redVol=0.0)
      redVol = Math.abs(this.faderPosition);
      greenVol = 0.0;
    } else if (this.faderPosition > 0.0) {
      // Right side: 0.0 (greenVol=0.0) up to +1.0 (greenVol=1.0)
      greenVol = this.faderPosition;
      redVol = 0.0;
    } else {
      // Exactly center (0.0): both muted
      redVol = 0.0;
      greenVol = 0.0;
    }

    // Smooth gain transitions to avoid clicks
    this.redBusGain.gain.cancelScheduledValues(now);
    this.redBusGain.gain.setValueAtTime(this.redBusGain.gain.value, now);
    this.redBusGain.gain.linearRampToValueAtTime(redVol, now + 0.03);

    this.greenBusGain.gain.cancelScheduledValues(now);
    this.greenBusGain.gain.setValueAtTime(this.greenBusGain.gain.value, now);
    this.greenBusGain.gain.linearRampToValueAtTime(greenVol, now + 0.03);
  }

  // Smoothly animate fader to target (-1.0 or +1.0) over duration seconds (e.g. 0.5s)
  animateFader(target, duration = 0.5) {
    if (this.faderAnimationId) {
      cancelAnimationFrame(this.faderAnimationId);
      this.faderAnimationId = null;
    }

    return new Promise((resolve) => {
      const startPos = this.faderPosition;
      const startTime = performance.now();
      const durationMs = duration * 1000;

      const step = (currentTime) => {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / durationMs, 1.0);
        // EaseInOutQuad
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
          resolve();
        }
      };

      this.faderAnimationId = requestAnimationFrame(step);
    });
  }

  // Decode audio data (ArrayBuffer) into AudioBuffer
  async decodeAudioData(arrayBuffer) {
    await this.unlock();
    // Use copy of arrayBuffer because decodeAudioData detaches the buffer in some browsers
    const copy = arrayBuffer.slice(0);
    return new Promise((resolve, reject) => {
      this.ctx.decodeAudioData(
        copy,
        (buffer) => resolve(buffer),
        (err) => reject(err)
      );
    });
  }

  // Cache buffer by sampleId
  setCachedBuffer(sampleId, audioBuffer) {
    this.bufferCache.set(sampleId, audioBuffer);
  }

  getCachedBuffer(sampleId) {
    return this.bufferCache.get(sampleId);
  }

  hasBuffer(sampleId) {
    return this.bufferCache.has(sampleId);
  }

  // Play a pad
  async triggerPad(row, col, sampleId) {
    await this.unlock();

    const buffer = this.bufferCache.get(sampleId);
    if (!buffer) {
      console.warn(`Buffer not found for sampleId: ${sampleId}`);
      return;
    }

    const padKey = `${col}_${row}`;

    // Handling by column type:
    // Col 0: Red Column (Exclusive, crossfader-controlled, 0.5s fade switch)
    // Col 4: Green Column (Exclusive, crossfader-controlled, 0.5s fade switch)
    // Col 1, 2, 3: Blue Columns (Independent one-shots, multi-trigger, full volume)

    if (col === 0 || col === 4) {
      await this.handleExclusivePlay(row, col, padKey, buffer);
    } else {
      this.handleOneShotPlay(row, col, padKey, buffer);
    }
  }

  // Handles Red and Green exclusive loop/playback
  async handleExclusivePlay(row, col, padKey, buffer) {
    const isRed = col === 0;
    const isGreen = col === 4;
    const targetFader = isRed ? -1.0 : 1.0;

    // Check if the other exclusive column is currently playing
    const otherCol = isRed ? 4 : 0;
    const otherActivePadKey = this.columnActiveTrack.get(otherCol);

    // If tapping the exact same currently playing pad in this column, stop it with fadeout
    const currentActivePadKey = this.columnActiveTrack.get(col);
    if (currentActivePadKey === padKey) {
      this.stopTrackWithFade(padKey, 0.5);
      this.columnActiveTrack.delete(col);
      return;
    }

    // 1. If other column is playing (e.g., Red playing while Green clicked):
    //    Animate fader to target side over 0.5s with simultaneous fade out of old and fade in of new!
    //    Exclusive specification: Red and Green never sound at the same time.
    if (otherActivePadKey) {
      // Fade out the opposite column's track
      this.stopTrackWithFade(otherActivePadKey, 0.5);
      this.columnActiveTrack.delete(otherCol);

      // Animate fader to target (+1.0 or -1.0)
      await this.animateFader(targetFader, 0.5);
    } else {
      // If fader is currently at 0.0 or opposite side, slide fader to target
      if (Math.abs(this.faderPosition - targetFader) > 0.05) {
        // Animate fader to target
        this.animateFader(targetFader, 0.5);
      }
    }

    // 2. If another track in the SAME column is currently playing, fade it out over 0.5s
    if (currentActivePadKey && currentActivePadKey !== padKey) {
      this.stopTrackWithFade(currentActivePadKey, 0.5);
    }

    // 3. Start the newly selected pad loop
    this.startLoopingTrack(row, col, padKey, buffer, isRed ? this.redBusGain : this.greenBusGain);
  }

  startLoopingTrack(row, col, padKey, buffer, busGainNode) {
    const now = this.ctx.currentTime;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const trackGain = this.ctx.createGain();
    // Quick fade in (0.05s) to avoid click
    trackGain.gain.setValueAtTime(0.001, now);
    trackGain.gain.linearRampToValueAtTime(1.0, now + 0.05);

    source.connect(trackGain);
    trackGain.connect(busGainNode);

    source.start(now);

    const trackInfo = { source, gainNode: trackGain, row, col, padKey, isLoop: true };
    this.activeTracks.set(padKey, trackInfo);
    this.columnActiveTrack.set(col, padKey);

    if (this.onTrackStateChange) {
      this.onTrackStateChange(padKey, true);
    }

    source.onended = () => {
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
      } catch (e) {
        // already stopped
      }
      this.activeTracks.delete(padKey);
      if (this.onTrackStateChange) {
        this.onTrackStateChange(padKey, false);
      }
    }, fadeDuration * 1000 + 50);
  }

  // Handles Blue column (one-shot, polyphonic, independent of fader)
  handleOneShotPlay(row, col, padKey, buffer) {
    const now = this.ctx.currentTime;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = false;

    const trackGain = this.ctx.createGain();
    trackGain.gain.setValueAtTime(1.0, now);

    source.connect(trackGain);
    trackGain.connect(this.blueBusGain);

    source.start(now);

    if (this.onTrackStateChange) {
      this.onTrackStateChange(padKey, true);
    }

    source.onended = () => {
      try {
        source.disconnect();
        trackGain.disconnect();
      } catch (e) {}
      if (this.onTrackStateChange) {
        this.onTrackStateChange(padKey, false);
      }
    };
  }

  // Stop all active tracks immediately
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

  // Synthesize built-in high-quality sounds for preset 1
  // Creates kick, snare, hi-hats, synth stabs, bass loops, fx so user can play immediately!
  async generateDefaultSampleBuffer(row, col) {
    if (!this.ctx) this.init();

    const sampleRate = this.ctx.sampleRate || 44100;

    // Col 0: Red column - Drum & Percussion groove loops (2 bars at 120BPM = 4.0 seconds)
    // Col 1, 2, 3: Blue columns - One-shot sounds (0.3s - 1.2s)
    // Col 4: Green column - Synth & Bass melodic loops (4.0 seconds)

    if (col === 0) {
      return this.synthesizeDrumLoop(row, sampleRate);
    } else if (col === 4) {
      return this.synthesizeMelodicLoop(row, sampleRate);
    } else {
      return this.synthesizeOneShot(row, col, sampleRate);
    }
  }

  // Synthesize a 4-second seamless rhythmic drum loop
  synthesizeDrumLoop(row, sampleRate) {
    const duration = 4.0; // 2 bars @ 120 BPM
    const length = Math.floor(sampleRate * duration);
    const buffer = this.ctx.createBuffer(2, length, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    const bpm = 120;
    const beatSec = 60 / bpm; // 0.5s per quarter note
    const sixteenth = beatSec / 4; // 0.125s

    // Pattern variations per row (8 rows: A-H)
    for (let step = 0; step < 32; step++) {
      const time = step * sixteenth;
      const startIdx = Math.floor(time * sampleRate);

      // Kick logic
      const isKick = (step % 8 === 0) || (row % 2 === 1 && step % 8 === 6) || (row >= 4 && step === 10);
      if (isKick) {
        this.addKick(left, right, startIdx, sampleRate, 0.25);
      }

      // Snare / Clap logic
      const isSnare = (step % 8 === 4) || (row >= 2 && step === 28 && row % 2 === 0);
      if (isSnare) {
        this.addSnare(left, right, startIdx, sampleRate, 0.2);
      }

      // Hi-hat logic
      const isHat = (step % 2 === 1) || (row >= 3 && step % 4 === 2);
      if (isHat) {
        this.addHiHat(left, right, startIdx, sampleRate, 0.08, step % 4 === 2);
      }
    }

    return buffer;
  }

  // Synthesize a 4-second seamless melodic synth/bass loop
  synthesizeMelodicLoop(row, sampleRate) {
    const duration = 4.0;
    const length = Math.floor(sampleRate * duration);
    const buffer = this.ctx.createBuffer(2, length, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    // Minor pentatonic / Dorian scale notes: F2, Ab2, Bb2, C3, Eb3, F3, etc.
    const baseFreqs = [87.31, 98.00, 110.0, 130.81, 146.83, 164.81, 174.61, 196.00];
    const root = baseFreqs[row % baseFreqs.length];

    const sixteenth = (60 / 120) / 4;

    // Pattern of pitches
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
        // Sawtooth-like synth with lowpass warmth
        const wave = Math.sin(2 * Math.PI * freq * t) * 0.5 + Math.sin(4 * Math.PI * freq * t) * 0.25;
        const val = wave * env * 0.35;
        left[startIdx + i] += val;
        right[startIdx + i] += val * 0.9;
      }
    }

    return buffer;
  }

  // Synthesize rich one-shots for blue columns (laser, zap, clap, chord, riser, vocal-like stab)
  synthesizeOneShot(row, col, sampleRate) {
    const type = (row + col * 8) % 12;
    let duration = 0.6;
    if (type >= 8) duration = 1.0;

    const length = Math.floor(sampleRate * duration);
    const buffer = this.ctx.createBuffer(2, length, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    switch (type) {
      case 0: // Electro Laser
        for (let i = 0; i < length; i++) {
          const t = i / sampleRate;
          const freq = 1200 * Math.exp(-t * 12) + 100;
          const env = Math.exp(-t * 8);
          const val = Math.sin(2 * Math.PI * freq * t) * env * 0.5;
          left[i] = val;
          right[i] = val;
        }
        break;
      case 1: // Metallic Clap
        for (let i = 0; i < length; i++) {
          const t = i / sampleRate;
          const noise = (Math.random() * 2 - 1);
          const env = Math.exp(-t * 14) + (t < 0.04 ? Math.random() * 0.3 : 0);
          const val = noise * env * 0.4;
          left[i] = val;
          right[i] = val * 0.9;
        }
        break;
      case 2: // Synth Chord Stab
        const chordNotes = [261.63, 329.63, 392.0, 523.25]; // C Major
        for (let i = 0; i < length; i++) {
          const t = i / sampleRate;
          const env = Math.exp(-t * 4);
          let sum = 0;
          for (const cn of chordNotes) {
            sum += Math.sin(2 * Math.PI * cn * t);
          }
          const val = (sum / chordNotes.length) * env * 0.5;
          left[i] = val;
          right[i] = val;
        }
        break;
      case 3: // Sub Drop
        for (let i = 0; i < length; i++) {
          const t = i / sampleRate;
          const freq = 180 * Math.exp(-t * 4) + 40;
          const env = Math.exp(-t * 2);
          const val = Math.sin(2 * Math.PI * freq * t) * env * 0.7;
          left[i] = val;
          right[i] = val;
        }
        break;
      case 4: // Rim / Woodblock
        for (let i = 0; i < length; i++) {
          const t = i / sampleRate;
          const env = Math.exp(-t * 30);
          const val = (Math.sin(2 * Math.PI * 850 * t) + Math.sin(2 * Math.PI * 1200 * t) * 0.5) * env * 0.6;
          left[i] = val;
          right[i] = val;
        }
        break;
      case 5: // Shaker
        for (let i = 0; i < length; i++) {
          const t = i / sampleRate;
          const env = Math.sin(Math.min(Math.PI, t * 25)) * Math.exp(-t * 8);
          const noise = (Math.random() * 2 - 1);
          const val = noise * env * 0.35;
          left[i] = val;
          right[i] = val * 0.8;
        }
        break;
      case 6: // Analog Bell
        for (let i = 0; i < length; i++) {
          const t = i / sampleRate;
          const env = Math.exp(-t * 3);
          const val = (Math.sin(2 * Math.PI * 1046.5 * t) + Math.sin(2 * Math.PI * 1568 * t) * 0.4) * env * 0.4;
          left[i] = val;
          right[i] = val;
        }
        break;
      case 7: // Zap FX
        for (let i = 0; i < length; i++) {
          const t = i / sampleRate;
          const freq = 2400 * Math.exp(-t * 20) + 200;
          const env = Math.exp(-t * 10);
          const val = (Math.random() > 0.5 ? 1 : -1) * 0.2 * env + Math.sin(2 * Math.PI * freq * t) * 0.4 * env;
          left[i] = val;
          right[i] = val;
        }
        break;
      default: // Riser / Noise Sweep
        for (let i = 0; i < length; i++) {
          const t = i / sampleRate;
          const env = (t / duration) * (1 - t / duration) * 3;
          const noise = (Math.random() * 2 - 1);
          const mod = Math.sin(2 * Math.PI * (200 + 800 * (t / duration)) * t);
          const val = (noise * 0.5 + mod * 0.5) * env * 0.4;
          left[i] = val;
          right[i] = val;
        }
        break;
    }

    return buffer;
  }

  // Audio helper: Kick synthesis
  addKick(left, right, startIdx, sampleRate, dur) {
    const len = Math.min(Math.floor(dur * sampleRate), left.length - startIdx);
    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      const freq = 140 * Math.exp(-t * 25) + 45;
      const env = Math.exp(-t * 10);
      const val = Math.sin(2 * Math.PI * freq * t) * env * 0.7;
      left[startIdx + i] += val;
      right[startIdx + i] += val;
    }
  }

  // Audio helper: Snare synthesis
  addSnare(left, right, startIdx, sampleRate, dur) {
    const len = Math.min(Math.floor(dur * sampleRate), left.length - startIdx);
    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      const toneEnv = Math.exp(-t * 18);
      const noiseEnv = Math.exp(-t * 12);
      const tone = Math.sin(2 * Math.PI * 185 * t) * toneEnv * 0.4;
      const noise = (Math.random() * 2 - 1) * noiseEnv * 0.35;
      const val = tone + noise;
      left[startIdx + i] += val;
      right[startIdx + i] += val;
    }
  }

  // Audio helper: Hi-hat synthesis
  addHiHat(left, right, startIdx, sampleRate, dur, open = false) {
    const len = Math.min(Math.floor(dur * sampleRate), left.length - startIdx);
    const decay = open ? 15 : 45;
    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      const env = Math.exp(-t * decay);
      const noise = (Math.random() * 2 - 1) * env * 0.25;
      left[startIdx + i] += noise;
      right[startIdx + i] += noise;
    }
  }
}

export const audioEngine = new AudioEngine();
