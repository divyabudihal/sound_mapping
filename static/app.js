// ── Stem config ──────────────────────────────────────────────────────────────
const STEM_CONFIG = {
  vocals: { label: 'Vocals & Choir', color: '#FF6B35', emoji: '🎤' },
  drums:  { label: 'Drums',          color: '#FFD700', emoji: '🥁' },
  bass:   { label: 'Bass',           color: '#E040FB', emoji: '🎸' },
  wind:   { label: 'Horns & Wind',   color: '#00E5FF', emoji: '🎺' },
  guitar: { label: 'Guitar',         color: '#69F0AE', emoji: '🎸' },
  keys:   { label: 'Keys',           color: '#FF4081', emoji: '🎹' },
};

// ── Player state ─────────────────────────────────────────────────────────────
let audioCtx = null;
let stems = {};        // model → { buffer, gainNode, analyser, source, muted, volume, soloed }
let isPlaying = false;
let startCtxTime = 0;
let pauseOffset = 0;
let duration = 0;
let rafId = null;
let soloActive = false;

// DOM refs
const playBtn     = document.getElementById('play-btn');
const progressBar = document.getElementById('progress-bar');
const progressFill = document.getElementById('progress-fill');
const currentTimeEl = document.getElementById('current-time');
const totalTimeEl   = document.getElementById('total-time');
const stemsContainer = document.getElementById('stems-container');
const masterControls = document.getElementById('master-controls');
const loadingBar = document.getElementById('loading-bar');
const loadingStatus = document.getElementById('loading-status');
const loadProgressFill = document.getElementById('load-progress-fill');

// ── Utilities ─────────────────────────────────────────────────────────────────
function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function getCurrentTime() {
  if (isPlaying) return audioCtx.currentTime - startCtxTime;
  return pauseOffset;
}

// ── Audio context init (must happen after a user gesture) ─────────────────────
function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

// ── Load a single stem ────────────────────────────────────────────────────────
async function loadStem(model) {
  const resp = await fetch(`/stems/${model}.mp3`);
  if (!resp.ok) throw new Error(`Failed to fetch stem: ${model}`);
  const arrayBuf = await resp.arrayBuffer();
  const buffer = await audioCtx.decodeAudioData(arrayBuf);

  const gainNode = audioCtx.createGain();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;
  gainNode.connect(analyser);
  analyser.connect(audioCtx.destination);

  stems[model] = {
    buffer,
    gainNode,
    analyser,
    source: null,
    muted: false,
    volume: 1.0,
    soloed: false,
  };

  if (buffer.duration > duration) duration = buffer.duration;
}

// ── Draw static waveform to an offscreen canvas ───────────────────────────────
function buildWaveformCanvas(buffer, color, width, height) {
  const off = document.createElement('canvas');
  off.width = width;
  off.height = height;
  const ctx = off.getContext('2d');

  const data = buffer.getChannelData(0);
  const samplesPerPx = Math.ceil(data.length / width);

  ctx.clearRect(0, 0, width, height);

  for (let x = 0; x < width; x++) {
    let min = 0, max = 0;
    const start = x * samplesPerPx;
    const end = Math.min(start + samplesPerPx, data.length);
    for (let i = start; i < end; i++) {
      const v = data[i];
      if (v > max) max = v;
      if (v < min) min = v;
    }
    const yTop    = ((1 - max) / 2) * height;
    const yBottom = ((1 - min) / 2) * height;
    ctx.fillStyle = color + 'cc'; // slightly transparent
    ctx.fillRect(x, yTop, 1, Math.max(1, yBottom - yTop));
  }
  return off;
}

// ── Draw one stem's canvas frame ──────────────────────────────────────────────
function drawStemFrame(model, waveCanvas, offscreen, vizCanvas) {
  const stem = stems[model];
  const { color } = STEM_CONFIG[model];
  const W = waveCanvas.width;
  const H = waveCanvas.height;

  // 1. Waveform
  const wCtx = waveCanvas.getContext('2d');
  wCtx.clearRect(0, 0, W, H);
  wCtx.drawImage(offscreen, 0, 0, W, H);

  // 2. Darken unplayed portion
  const progress = Math.min(1, getCurrentTime() / duration);
  const playX = Math.floor(progress * W);
  wCtx.fillStyle = 'rgba(0,0,0,0.55)';
  wCtx.fillRect(playX, 0, W - playX, H);

  // 3. Playhead line
  wCtx.fillStyle = 'rgba(255,255,255,0.9)';
  wCtx.fillRect(playX, 0, 2, H);

  // 4. Real-time oscilloscope (viz canvas)
  if (isPlaying && !stem.muted) {
    const vCtx = vizCanvas.getContext('2d');
    const VW = vizCanvas.width;
    const VH = vizCanvas.height;
    vCtx.clearRect(0, 0, VW, VH);

    const bufLen = stem.analyser.frequencyBinCount;
    const td = new Uint8Array(bufLen);
    stem.analyser.getByteTimeDomainData(td);

    vCtx.strokeStyle = color;
    vCtx.lineWidth = 1.5;
    vCtx.beginPath();
    const sliceW = VW / bufLen;
    for (let i = 0; i < bufLen; i++) {
      const v = td[i] / 128.0;
      const y = v * VH / 2;
      i === 0 ? vCtx.moveTo(0, y) : vCtx.lineTo(i * sliceW, y);
    }
    vCtx.stroke();
  }
}

// ── Animation loop ────────────────────────────────────────────────────────────
function animLoop() {
  const t = getCurrentTime();

  // Update master progress
  const pct = duration > 0 ? Math.min(100, (t / duration) * 100) : 0;
  progressFill.style.width = pct + '%';
  currentTimeEl.textContent = formatTime(t);

  // Draw each stem
  for (const model of Object.keys(stems)) {
    const track = document.querySelector(`.stem-track[data-model="${model}"]`);
    if (!track) continue;
    const waveCanvas = track.querySelector('.waveform-canvas');
    const offscreen  = track._offscreen;
    const vizCanvas  = track.querySelector('.viz-canvas');
    if (waveCanvas && offscreen && vizCanvas) {
      drawStemFrame(model, waveCanvas, offscreen, vizCanvas);
    }
  }

  // Auto-stop at end
  if (isPlaying && t >= duration) {
    stopPlayback();
    pauseOffset = 0;
  }

  rafId = requestAnimationFrame(animLoop);
}

// ── Playback control ──────────────────────────────────────────────────────────
function startPlayback() {
  ensureAudioCtx();
  if (isPlaying) return;

  for (const [model, stem] of Object.entries(stems)) {
    const src = audioCtx.createBufferSource();
    src.buffer = stem.buffer;
    src.connect(stem.gainNode);
    src.start(0, Math.min(pauseOffset, stem.buffer.duration));
    stem.source = src;
  }

  startCtxTime = audioCtx.currentTime - pauseOffset;
  isPlaying = true;
  playBtn.classList.add('playing');
  playBtn.textContent = '❚❚';
  rafId = rafId || requestAnimationFrame(animLoop);
}

function stopPlayback() {
  if (!isPlaying) return;
  pauseOffset = getCurrentTime();
  for (const stem of Object.values(stems)) {
    try { stem.source?.stop(); } catch (_) {}
    stem.source = null;
  }
  isPlaying = false;
  playBtn.classList.remove('playing');
  playBtn.textContent = '▶';
}

function togglePlay() {
  ensureAudioCtx();
  isPlaying ? stopPlayback() : startPlayback();
}

function seek(ratio) {
  const t = ratio * duration;
  const wasPlaying = isPlaying;
  stopPlayback();
  pauseOffset = Math.max(0, Math.min(t, duration));
  if (wasPlaying) startPlayback();
  // single frame redraw when paused
  if (!isPlaying) requestAnimationFrame(animLoop);
}

// ── Mute / Solo ───────────────────────────────────────────────────────────────
function applyGains() {
  soloActive = Object.values(stems).some(s => s.soloed);
  for (const [model, stem] of Object.entries(stems)) {
    const heard = !stem.muted && (!soloActive || stem.soloed);
    stem.gainNode.gain.setTargetAtTime(
      heard ? stem.volume : 0,
      audioCtx?.currentTime ?? 0,
      0.02
    );
  }
}

function toggleMute(model) {
  const stem = stems[model];
  stem.muted = !stem.muted;
  const btn = document.querySelector(`.stem-track[data-model="${model}"] .mute-btn`);
  btn.classList.toggle('muted', stem.muted);
  btn.textContent = stem.muted ? 'M' : 'M';
  applyGains();
}

function toggleSolo(model) {
  stems[model].soloed = !stems[model].soloed;
  const btn = document.querySelector(`.stem-track[data-model="${model}"] .solo-btn`);
  btn.classList.toggle('soloed', stems[model].soloed);
  applyGains();
}

// ── Build stem track DOM ──────────────────────────────────────────────────────
function buildTrack(model) {
  const cfg = STEM_CONFIG[model];
  const stem = stems[model];

  const track = document.createElement('div');
  track.className = 'stem-track';
  track.dataset.model = model;

  // Info panel
  const info = document.createElement('div');
  info.className = 'stem-info';
  info.innerHTML = `
    <div class="stem-name-row">
      <div class="stem-dot" style="background:${cfg.color}"></div>
      <span class="stem-label" style="color:${cfg.color}">${cfg.label}</span>
    </div>
    <div class="stem-controls">
      <button class="mute-btn" style="color:${cfg.color}; border-color:${cfg.color}">M</button>
      <button class="solo-btn">S</button>
      <input type="range" class="vol-slider" min="0" max="1" step="0.01" value="1">
    </div>
  `;

  // Waveform panel
  const waveWrap = document.createElement('div');
  waveWrap.className = 'waveform-wrap';

  const waveCanvas = document.createElement('canvas');
  waveCanvas.className = 'waveform-canvas';
  waveCanvas.height = 90;

  const vizCanvas = document.createElement('canvas');
  vizCanvas.className = 'viz-canvas';
  vizCanvas.height = 30;

  waveWrap.appendChild(waveCanvas);
  waveWrap.appendChild(vizCanvas);

  track.appendChild(info);
  track.appendChild(waveWrap);
  stemsContainer.appendChild(track);

  // Build offscreen waveform (sized after layout)
  requestAnimationFrame(() => {
    const W = waveWrap.clientWidth || 800;
    waveCanvas.width = W;
    vizCanvas.width = W;
    track._offscreen = buildWaveformCanvas(stem.buffer, cfg.color, W, 90);
    drawStemFrame(model, waveCanvas, track._offscreen, vizCanvas);
  });

  // Waveform click = seek
  waveWrap.addEventListener('click', e => {
    const rect = waveWrap.getBoundingClientRect();
    seek((e.clientX - rect.left) / rect.width);
  });

  // Controls
  info.querySelector('.mute-btn').addEventListener('click', () => toggleMute(model));
  info.querySelector('.solo-btn').addEventListener('click', () => toggleSolo(model));
  info.querySelector('.vol-slider').addEventListener('input', e => {
    stems[model].volume = parseFloat(e.target.value);
    applyGains();
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const resp = await fetch('/api/stems');
  const { stems: available } = await resp.json();

  if (available.length === 0) {
    loadingBar.style.display = 'none';
    document.getElementById('setup-message').style.display = 'block';
    return;
  }

  // Show loading progress
  loadingBar.style.display = 'block';
  ensureAudioCtx();

  let loaded = 0;
  for (const model of available) {
    loadingStatus.textContent = `Loading ${STEM_CONFIG[model]?.label ?? model}...`;
    await loadStem(model);
    loaded++;
    loadProgressFill.style.width = `${(loaded / available.length) * 100}%`;
  }

  loadingBar.style.display = 'none';
  masterControls.style.display = 'flex';
  stemsContainer.style.display = 'block';

  totalTimeEl.textContent = formatTime(duration);

  for (const model of available) {
    buildTrack(model);
  }

  // Start animation loop (renders waveforms even while paused)
  rafId = requestAnimationFrame(animLoop);
}

// ── Global events ─────────────────────────────────────────────────────────────
playBtn.addEventListener('click', togglePlay);

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
});

progressBar.addEventListener('click', e => {
  const rect = progressBar.getBoundingClientRect();
  seek((e.clientX - rect.left) / rect.width);
});

// Rebuild waveforms on resize
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const model of Object.keys(stems)) {
      const track = document.querySelector(`.stem-track[data-model="${model}"]`);
      if (!track) continue;
      const waveWrap = track.querySelector('.waveform-wrap');
      const waveCanvas = track.querySelector('.waveform-canvas');
      const vizCanvas = track.querySelector('.viz-canvas');
      const W = waveWrap.clientWidth || 800;
      waveCanvas.width = W;
      vizCanvas.width = W;
      track._offscreen = buildWaveformCanvas(
        stems[model].buffer, STEM_CONFIG[model].color, W, 90
      );
    }
  }, 200);
});

init().catch(err => {
  console.error('Init error:', err);
  loadingStatus.textContent = 'Error loading stems. Check console.';
});
