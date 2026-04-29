// ── Stem config ───────────────────────────────────────────────────────────────
const STEM_CONFIG = {
  vocals: { label: 'Vocals & Choir', short: 'VOCALS', color: '#FF6B35', emoji: '🎤', num: 1 },
  drums:  { label: 'Drums',          short: 'DRUMS',  color: '#FFD700', emoji: '🥁', num: 2 },
  bass:   { label: 'Bass',           short: 'BASS',   color: '#E040FB', emoji: '🔊', num: 3 },
  wind:   { label: 'Horns',   short: 'HORNS',  color: '#00E5FF', emoji: '🎺', num: 4 },
  guitar: { label: 'Guitar',         short: 'GUITAR', color: '#69F0AE', emoji: '🎸', num: 5 },
  keys:   { label: 'Keys',           short: 'KEYS',   color: '#FF4081', emoji: '🎹', num: 6 },
};

// ── Player state ──────────────────────────────────────────────────────────────
let audioCtx    = null;
let stems       = {};
let isPlaying   = false;
let startCtxTime = 0;
let pauseOffset = 0;
let duration    = 0;
let rafId       = null;
let soloActive  = false;
let masterVolume = 1.0;
let currentView = 'waveform';  // 'waveform' | 'hardware'

// Hardware mode state
let hwMode      = 'mute';   // 'mute' | 'solo'
let lcdHistory  = null;     // Float32Array for scrolling LCD waveform

// DOM refs — waveform view
const playBtn       = document.getElementById('play-btn');
const progressBar   = document.getElementById('progress-bar');
const progressFill  = document.getElementById('progress-fill');
const currentTimeEl = document.getElementById('current-time');
const totalTimeEl   = document.getElementById('total-time');
const stemsContainer = document.getElementById('stems-container');
const loadingBar    = document.getElementById('loading-bar');
const loadingStatus = document.getElementById('loading-status');
const loadProgressFill = document.getElementById('load-progress-fill');

// DOM refs — hardware view
const hwPlayBtn   = document.getElementById('hw-play-btn');
const hwLcdCanvas = document.getElementById('hw-lcd-canvas');
const hwLcdDigit  = document.getElementById('hw-lcd-digit');
const hwBtnMute   = document.getElementById('hw-btn-mute');
const hwBtnSolo   = document.getElementById('hw-btn-solo');
const hwPadGrid   = document.getElementById('hw-pad-grid');

// ── Utilities ─────────────────────────────────────────────────────────────────
function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function getCurrentTime() {
  if (isPlaying) return Math.max(0, audioCtx.currentTime - startCtxTime);
  return pauseOffset;
}

// ── Audio context ─────────────────────────────────────────────────────────────
function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    lcdHistory = new Float32Array(hwLcdCanvas?.width || 400);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

// ── Load stem ─────────────────────────────────────────────────────────────────
async function loadStem(model) {
  const resp = await fetch(`/stems/${model}.mp3`);
  if (!resp.ok) throw new Error(`Failed to fetch ${model}`);
  const buf = await audioCtx.decodeAudioData(await resp.arrayBuffer());

  const gainNode = audioCtx.createGain();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;
  gainNode.connect(analyser);
  analyser.connect(audioCtx.destination);

  stems[model] = { buffer: buf, gainNode, analyser, source: null, muted: false, volume: 1.0, soloed: false };
  if (buf.duration > duration) duration = buf.duration;
}

// ── Playback ──────────────────────────────────────────────────────────────────
function startPlayback() {
  ensureAudioCtx();
  if (isPlaying) return;
  for (const [, stem] of Object.entries(stems)) {
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
  if (hwPlayBtn) { hwPlayBtn.classList.add('playing'); hwPlayBtn.textContent = '❚❚ PAUSE'; }
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
  if (hwPlayBtn) { hwPlayBtn.classList.remove('playing'); hwPlayBtn.textContent = '▶ PLAY'; }
}

function togglePlay() {
  ensureAudioCtx();
  isPlaying ? stopPlayback() : startPlayback();
}

function seek(ratio) {
  const t = Math.max(0, Math.min(ratio * duration, duration));
  const was = isPlaying;
  stopPlayback();
  pauseOffset = t;
  if (was) startPlayback();
  else requestAnimationFrame(animLoop);
}

// ── Gain / mute / solo ────────────────────────────────────────────────────────
function applyGains() {
  soloActive = Object.values(stems).some(s => s.soloed);
  for (const stem of Object.values(stems)) {
    const heard = !stem.muted && (!soloActive || stem.soloed);
    const target = heard ? stem.volume * masterVolume : 0;
    stem.gainNode.gain.setTargetAtTime(target, audioCtx?.currentTime ?? 0, 0.02);
  }
}

function toggleMute(model) {
  const stem = stems[model];
  stem.muted = !stem.muted;
  // waveform view button
  const wBtn = document.querySelector(`.stem-track[data-model="${model}"] .mute-btn`);
  if (wBtn) wBtn.classList.toggle('muted', stem.muted);
  applyGains();
  atlasUpdate();
}

function toggleSolo(model) {
  stems[model].soloed = !stems[model].soloed;
  const wBtn = document.querySelector(`.stem-track[data-model="${model}"] .solo-btn`);
  if (wBtn) wBtn.classList.toggle('soloed', stems[model].soloed);
  applyGains();
  atlasUpdate();
}

// ── Atlas integration ─────────────────────────────────────────────────────────
function getActiveStemIds() {
  const solo = Object.values(stems).some(s => s.soloed);
  return Object.entries(stems)
    .filter(([, s]) => !s.muted && (!solo || s.soloed))
    .map(([id]) => id);
}

function atlasUpdate() {
  if (!window.analysisData || !window.getActiveAtlasData || !window.renderAtlas) return;
  const data = window.getActiveAtlasData(getActiveStemIds(), window.analysisData.analysis);
  window.renderAtlas(data);
}

// ── Waveform view: build offscreen waveform ───────────────────────────────────
function buildWaveformCanvas(buffer, color, width, height) {
  const off = document.createElement('canvas');
  off.width = width; off.height = height;
  const ctx = off.getContext('2d');
  const data = buffer.getChannelData(0);
  const spp = Math.ceil(data.length / width);
  for (let x = 0; x < width; x++) {
    let min = 0, max = 0;
    const start = x * spp;
    const end = Math.min(start + spp, data.length);
    for (let i = start; i < end; i++) {
      const v = data[i];
      if (v > max) max = v;
      if (v < min) min = v;
    }
    ctx.fillStyle = color + 'cc';
    ctx.fillRect(x, ((1 - max) / 2) * height, 1, Math.max(1, ((max - min) / 2) * height));
  }
  return off;
}

function drawStemFrame(model, waveCanvas, offscreen, vizCanvas) {
  const stem = stems[model];
  const { color } = STEM_CONFIG[model];
  const W = waveCanvas.width, H = waveCanvas.height;
  const wCtx = waveCanvas.getContext('2d');

  wCtx.clearRect(0, 0, W, H);
  wCtx.drawImage(offscreen, 0, 0, W, H);

  const progress = Math.min(1, getCurrentTime() / duration);
  const playX = Math.floor(progress * W);
  wCtx.fillStyle = 'rgba(0,0,0,0.55)';
  wCtx.fillRect(playX, 0, W - playX, H);
  wCtx.fillStyle = 'rgba(255,255,255,0.85)';
  wCtx.fillRect(playX, 0, 2, H);

  if (isPlaying && !stem.muted) {
    const vCtx = vizCanvas.getContext('2d');
    const VW = vizCanvas.width, VH = vizCanvas.height;
    vCtx.clearRect(0, 0, VW, VH);
    const td = new Uint8Array(stem.analyser.frequencyBinCount);
    stem.analyser.getByteTimeDomainData(td);
    vCtx.strokeStyle = color;
    vCtx.lineWidth = 1.5;
    vCtx.beginPath();
    const sw = VW / td.length;
    for (let i = 0; i < td.length; i++) {
      const y = (td[i] / 128.0) * VH / 2;
      i === 0 ? vCtx.moveTo(0, y) : vCtx.lineTo(i * sw, y);
    }
    vCtx.stroke();
  }
}

// ── Waveform view: build track DOM ────────────────────────────────────────────
function buildTrack(model) {
  const cfg = STEM_CONFIG[model];
  const stem = stems[model];

  const track = document.createElement('div');
  track.className = 'stem-track';
  track.dataset.model = model;

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

  const waveWrap = document.createElement('div');
  waveWrap.className = 'waveform-wrap';
  const waveCanvas = document.createElement('canvas');
  waveCanvas.className = 'waveform-canvas'; waveCanvas.height = 90;
  const vizCanvas = document.createElement('canvas');
  vizCanvas.className = 'viz-canvas'; vizCanvas.height = 30;
  waveWrap.appendChild(waveCanvas);
  waveWrap.appendChild(vizCanvas);

  track.appendChild(info);
  track.appendChild(waveWrap);
  stemsContainer.appendChild(track);

  requestAnimationFrame(() => {
    const W = waveWrap.clientWidth || 800;
    waveCanvas.width = W; vizCanvas.width = W;
    track._offscreen = buildWaveformCanvas(stem.buffer, cfg.color, W, 90);
    drawStemFrame(model, waveCanvas, track._offscreen, vizCanvas);
  });

  waveWrap.addEventListener('click', e => {
    const rect = waveWrap.getBoundingClientRect();
    seek((e.clientX - rect.left) / rect.width);
  });

  info.querySelector('.mute-btn').addEventListener('click', () => toggleMute(model));
  info.querySelector('.solo-btn').addEventListener('click', () => toggleSolo(model));
  info.querySelector('.vol-slider').addEventListener('input', e => {
    stems[model].volume = parseFloat(e.target.value);
    applyGains();
  });
}

// ── Hardware view: knob drawing ───────────────────────────────────────────────
function drawKnob(canvas, value /* 0-1 */, color = '#ff6b00') {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const r = Math.min(W, H) / 2 - 3;

  ctx.clearRect(0, 0, W, H);

  // Outer body shadow
  ctx.beginPath();
  ctx.arc(cx, cy + 1, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fill();

  // Track arc (start 225°, sweep 270°)
  const startAngle = (225 * Math.PI) / 180;
  const sweep      = (270 * Math.PI) / 180;
  const endAngle   = startAngle + sweep;
  const valAngle   = startAngle + value * sweep;

  ctx.beginPath();
  ctx.arc(cx, cy, r - 1, startAngle, endAngle);
  ctx.strokeStyle = '#b0ac9e';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Value arc
  if (value > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1, startAngle, valAngle);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Knob body
  const grad = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.2, r * 0.1, cx, cy, r - 5);
  grad.addColorStop(0, '#f5f1e5');
  grad.addColorStop(1, '#ccc8b8');
  ctx.beginPath();
  ctx.arc(cx, cy, r - 5, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  // Tick mark
  const tx = cx + (r - 9) * Math.cos(valAngle);
  const ty = cy + (r - 9) * Math.sin(valAngle);
  const tx2 = cx + (r - 15) * Math.cos(valAngle);
  const ty2 = cy + (r - 15) * Math.sin(valAngle);
  ctx.beginPath();
  ctx.moveTo(tx2, ty2);
  ctx.lineTo(tx, ty);
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.stroke();
}

function makeKnobInteractive(canvas, initialValue, onChange) {
  let value = initialValue;
  let dragging = false, startY = 0, startVal = 0;

  drawKnob(canvas, value);

  canvas.addEventListener('mousedown', e => {
    dragging = true; startY = e.clientY; startVal = value;
    e.preventDefault();
  });
  canvas.addEventListener('touchstart', e => {
    dragging = true; startY = e.touches[0].clientY; startVal = value;
    e.preventDefault();
  }, { passive: false });

  const move = y => {
    if (!dragging) return;
    const delta = (startY - y) / 120;
    value = Math.max(0, Math.min(1, startVal + delta));
    drawKnob(canvas, value);
    onChange(value);
  };

  window.addEventListener('mousemove',  e => move(e.clientY));
  window.addEventListener('touchmove',  e => move(e.touches[0].clientY), { passive: false });
  window.addEventListener('mouseup',  () => { dragging = false; });
  window.addEventListener('touchend', () => { dragging = false; });

  return { setValue: v => { value = v; drawKnob(canvas, value); } };
}

// ── Hardware view: fader ──────────────────────────────────────────────────────
function initFader() {
  const track = document.querySelector('.hw-fader-track');
  const fill  = document.getElementById('hw-fader-fill');
  const thumb = document.getElementById('hw-fader-thumb');
  if (!track) return;

  let value = 1.0;
  let dragging = false, startY = 0, startVal = 0;

  function updateFader(v) {
    value = Math.max(0, Math.min(1, v));
    const pct = (1 - value) * 100;
    fill.style.height  = `${value * 100}%`;
    thumb.style.top    = `calc(${pct}% - 7px)`;
  }

  function setFromY(clientY) {
    const rect = track.getBoundingClientRect();
    const ratio = 1 - (clientY - rect.top) / rect.height;
    updateFader(ratio);
    masterVolume = value;
    applyGains();
    // sync master knob
    if (window._masterKnob) window._masterKnob.setValue(value);
  }

  track.addEventListener('mousedown', e => {
    dragging = true; e.preventDefault();
    setFromY(e.clientY);
  });
  track.addEventListener('touchstart', e => {
    dragging = true; e.preventDefault();
    setFromY(e.touches[0].clientY);
  }, { passive: false });

  window.addEventListener('mousemove',  e => { if (dragging) setFromY(e.clientY); });
  window.addEventListener('touchmove',  e => { if (dragging) setFromY(e.touches[0].clientY); }, { passive: false });
  window.addEventListener('mouseup',  () => { dragging = false; });
  window.addEventListener('touchend', () => { dragging = false; });

  updateFader(1);
}

// ── Hardware view: LCD canvas ─────────────────────────────────────────────────
function drawLcd() {
  if (!hwLcdCanvas) return;
  const ctx = hwLcdCanvas.getContext('2d');
  const W = hwLcdCanvas.width, H = hwLcdCanvas.height;

  ctx.fillStyle = '#192e19';
  ctx.fillRect(0, 0, W, H);

  // Collect frequency data from one of the active stems (prefer drums)
  const refModel = ['drums', 'bass', 'vocals', 'wind', 'guitar', 'keys']
    .find(m => stems[m] && !stems[m].muted) || Object.keys(stems)[0];

  if (!refModel || !stems[refModel]) return;

  const analyser = stems[refModel].analyser;
  const freqData = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(freqData);

  // Draw frequency bars (bottom-up) — use first 60 bins across width
  const numBars = Math.min(W / 4, 60);
  const barW = Math.floor(W / numBars) - 1;
  for (let i = 0; i < numBars; i++) {
    const binIdx = Math.floor((i / numBars) * (freqData.length * 0.5));
    const v = freqData[binIdx] / 255;
    const barH = Math.max(1, Math.floor(v * H * 0.85));
    const alpha = 0.4 + v * 0.6;
    ctx.fillStyle = `rgba(82, 255, 122, ${alpha})`;
    ctx.fillRect(i * (barW + 1), H - barH, barW, barH);
  }

  // Bright scanline at center
  ctx.fillStyle = 'rgba(82,255,122,0.08)';
  ctx.fillRect(0, H / 2 - 1, W, 2);

  // Progress indicator: bright vertical line
  const progress = duration > 0 ? getCurrentTime() / duration : 0;
  const px = Math.floor(progress * W);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillRect(px, 0, 2, H);
}

// ── Hardware view: pad LED + vol dots update ──────────────────────────────────
function updateHardwarePads() {
  for (const [model, stem] of Object.entries(stems)) {
    const pad = hwPadGrid?.querySelector(`.hw-pad[data-model="${model}"]`);
    if (!pad) continue;

    const isActive = !stem.muted && (!soloActive || stem.soloed);
    pad.classList.toggle('active', isActive);
    pad.classList.toggle('muted', stem.muted);
    pad.classList.toggle('soloed', stem.soloed);

    // Volume dots
    const dots = pad.querySelectorAll('.hw-vol-dot');
    const litCount = Math.round(stem.volume * dots.length);
    dots.forEach((d, i) => d.classList.toggle('lit', i < litCount));
  }
}

// ── Hardware view: build pad grid ─────────────────────────────────────────────
function buildHardwarePads(available) {
  if (!hwPadGrid) return;
  hwPadGrid.innerHTML = '';

  available.forEach((model, idx) => {
    const cfg = STEM_CONFIG[model];

    const pad = document.createElement('div');
    pad.className = 'hw-pad active';
    pad.dataset.model = model;
    pad.style.setProperty('--pad-color', cfg.color);

    pad.innerHTML = `
      <div class="hw-pad-led"></div>
      <span class="hw-pad-num">${cfg.num}</span>
      <div class="hw-pad-icon">${cfg.emoji}</div>
      <div class="hw-pad-name">${cfg.short}</div>
      <div class="hw-pad-sublabel">${cfg.label.split(' ')[0]}</div>
      <div class="hw-pad-vol-dots">
        ${[0,1,2,3,4].map(() => `<div class="hw-vol-dot lit"></div>`).join('')}
      </div>
    `;

    // Click: toggle mute or solo depending on mode
    pad.addEventListener('click', () => {
      ensureAudioCtx();
      if (hwMode === 'solo') {
        toggleSolo(model);
      } else {
        toggleMute(model);
      }
      updateHardwarePads();
    });

    // Visual press
    pad.addEventListener('mousedown', () => pad.classList.add('pressed'));
    pad.addEventListener('mouseup',   () => pad.classList.remove('pressed'));
    pad.addEventListener('mouseleave',() => pad.classList.remove('pressed'));

    hwPadGrid.appendChild(pad);
  });
}

// ── Hardware view: LCD icon dots ──────────────────────────────────────────────
function buildLcdIcons(available) {
  const el = document.getElementById('hw-lcd-icons');
  if (!el) return;

  // Two rows of 3 dots = one per stem
  const row1 = document.createElement('div'); row1.className = 'hw-lcd-icon-row';
  const row2 = document.createElement('div'); row2.className = 'hw-lcd-icon-row';

  available.forEach((model, i) => {
    const dot = document.createElement('div');
    dot.className = 'hw-lcd-icon active';
    dot.dataset.model = model;
    dot.style.background = STEM_CONFIG[model].color;
    dot.style.boxShadow  = `0 0 4px ${STEM_CONFIG[model].color}`;
    (i < 3 ? row1 : row2).appendChild(dot);
  });

  el.appendChild(row1);
  el.appendChild(row2);
}

function updateLcdIcons() {
  const el = document.getElementById('hw-lcd-icons');
  if (!el) return;
  el.querySelectorAll('.hw-lcd-icon').forEach(dot => {
    const model = dot.dataset.model;
    const stem = stems[model];
    if (!stem) return;
    const active = !stem.muted && (!soloActive || stem.soloed);
    dot.style.background = active ? STEM_CONFIG[model].color : '#1e4a1e';
    dot.style.boxShadow  = active ? `0 0 4px ${STEM_CONFIG[model].color}` : 'none';
  });
}

// ── Hardware view: LCD click to seek ─────────────────────────────────────────
function initLcdSeek() {
  if (!hwLcdCanvas) return;
  hwLcdCanvas.style.cursor = 'pointer';
  hwLcdCanvas.addEventListener('click', e => {
    const rect = hwLcdCanvas.getBoundingClientRect();
    seek((e.clientX - rect.left) / rect.width);
  });
}

// ── Hardware view: init ───────────────────────────────────────────────────────
function initHardwareView(available) {
  // Size LCD canvas
  if (hwLcdCanvas) {
    const strip = hwLcdCanvas.closest('.hw-lcd-strip');
    hwLcdCanvas.width  = strip ? strip.clientWidth - 100 : 300;
    hwLcdCanvas.height = 56;
    lcdHistory = new Float32Array(hwLcdCanvas.width);
    initLcdSeek();
  }

  buildHardwarePads(available);
  buildLcdIcons(available);
  initFader();

  // Master knob
  const masterKnobCanvas = document.getElementById('hw-master-knob');
  if (masterKnobCanvas) {
    const knob = makeKnobInteractive(masterKnobCanvas, 1.0, v => {
      masterVolume = v;
      // sync fader fill
      const fill  = document.getElementById('hw-fader-fill');
      const thumb = document.getElementById('hw-fader-thumb');
      if (fill)  fill.style.height = `${v * 100}%`;
      if (thumb) thumb.style.top   = `calc(${(1 - v) * 100}% - 7px)`;
      applyGains();
    });
    window._masterKnob = knob;
  }

  // Decorative knobs
  ['hw-bpm-knob', 'hw-metro-knob'].forEach(id => {
    const c = document.getElementById(id);
    if (c) makeKnobInteractive(c, parseFloat(c.dataset.value || 0.5), () => {});
  });

  // Hardware play button
  if (hwPlayBtn) hwPlayBtn.addEventListener('click', () => { ensureAudioCtx(); togglePlay(); });

  // MUTE / SOLO mode buttons
  if (hwBtnMute) hwBtnMute.addEventListener('click', () => {
    hwMode = 'mute';
    hwBtnMute.classList.add('mode-active');
    hwBtnSolo?.classList.remove('mode-active');
  });
  if (hwBtnSolo) hwBtnSolo.addEventListener('click', () => {
    hwMode = 'solo';
    hwBtnSolo.classList.add('mode-active');
    hwBtnMute?.classList.remove('mode-active');
  });

  // Set MUTE as default active
  hwBtnMute?.classList.add('mode-active');
}

// ── Animation loop ────────────────────────────────────────────────────────────
function animLoop() {
  const t = getCurrentTime();

  // Always keep waveform progress bar current so switching back feels instant
  const pct = duration > 0 ? Math.min(100, (t / duration) * 100) : 0;
  progressFill.style.width = pct + '%';
  currentTimeEl.textContent = formatTime(t);

  // Waveform view
  if (currentView === 'waveform') {

    for (const model of Object.keys(stems)) {
      const track = document.querySelector(`.stem-track[data-model="${model}"]`);
      if (!track) continue;
      const wc = track.querySelector('.waveform-canvas');
      const vc = track.querySelector('.viz-canvas');
      if (wc && track._offscreen && vc) drawStemFrame(model, wc, track._offscreen, vc);
    }
  }

  // Hardware view
  if (currentView === 'hardware') {
    if (hwLcdDigit) hwLcdDigit.textContent = formatTime(t);
    drawLcd();
    updateLcdIcons();
    updateHardwarePads();
  }

  // Auto-stop at end
  if (isPlaying && t >= duration) {
    stopPlayback();
    pauseOffset = 0;
  }

  rafId = requestAnimationFrame(animLoop);
}

// ── View toggle ───────────────────────────────────────────────────────────────
function switchView(view) {
  currentView = view;
  document.getElementById('waveform-view').style.display  = view === 'waveform' ? 'block' : 'none';
  document.getElementById('hardware-view').style.display  = view === 'hardware' ? 'block' : 'none';
  document.querySelectorAll('.view-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  // Resize LCD canvas now that the hardware view is visible
  if (view === 'hardware' && hwLcdCanvas) {
    const strip = hwLcdCanvas.closest('.hw-lcd-strip');
    const W = strip ? strip.clientWidth : 400;
    hwLcdCanvas.width  = Math.max(200, W - 100);
    hwLcdCanvas.height = 56;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  // Fetch stems list and analysis data in parallel
  const [stemsResp, analysisResp] = await Promise.all([
    fetch('/api/stems'),
    fetch('/api/analysis').catch(() => null),
  ]);
  const { stems: available } = await stemsResp.json();
  if (analysisResp) window.analysisData = await analysisResp.json();

  if (available.length === 0) {
    loadingBar.style.display = 'none';
    document.getElementById('setup-message').style.display = 'block';
    return;
  }

  loadingBar.style.display = 'block';
  ensureAudioCtx();

  let loaded = 0;
  for (const model of available) {
    loadingStatus.textContent = `Loading ${STEM_CONFIG[model]?.label ?? model}…`;
    await loadStem(model);
    loaded++;
    loadProgressFill.style.width = `${(loaded / available.length) * 100}%`;
  }

  loadingBar.style.display = 'none';

  // Show both views (waveform by default) + toggle
  document.getElementById('waveform-view').style.display = 'block';
  document.getElementById('hardware-view').style.display = 'none';
  document.getElementById('view-toggle').style.display   = 'flex';
  totalTimeEl.textContent = formatTime(duration);

  for (const model of available) buildTrack(model);

  // Build hardware view (after layout so canvas sizes are known)
  requestAnimationFrame(() => initHardwareView(available));

  rafId = requestAnimationFrame(animLoop);

  // Init atlas pane
  const atlasSvgEl = document.getElementById('atlas-svg');
  if (atlasSvgEl && window.initAtlasRenderer) {
    window.initAtlasRenderer(atlasSvgEl);
    atlasUpdate();
    if (window.startAtlasPulse) window.startAtlasPulse();
  }
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

document.getElementById('view-toggle').addEventListener('click', e => {
  const btn = e.target.closest('.view-btn');
  if (btn) switchView(btn.dataset.view);
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const model of Object.keys(stems)) {
      const track = document.querySelector(`.stem-track[data-model="${model}"]`);
      if (!track) continue;
      const wrap = track.querySelector('.waveform-wrap');
      const wc   = track.querySelector('.waveform-canvas');
      const vc   = track.querySelector('.viz-canvas');
      const W    = wrap?.clientWidth || 800;
      wc.width = W; vc.width = W;
      track._offscreen = buildWaveformCanvas(stems[model].buffer, STEM_CONFIG[model].color, W, 90);
    }
    // Resize LCD canvas
    if (hwLcdCanvas) {
      const strip = hwLcdCanvas.closest('.hw-lcd-strip');
      hwLcdCanvas.width = strip ? strip.clientWidth - 100 : 300;
    }
  }, 200);
});

init().catch(err => {
  console.error('Init error:', err);
  loadingStatus.textContent = 'Error loading stems — check the console.';
});
