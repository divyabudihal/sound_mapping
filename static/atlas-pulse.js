// ── atlas-pulse.js ────────────────────────────────────────────────────────────
// 130 BPM pulse engine — modulates city dot radii via rAF.

const ATLAS_BPM     = 130;
const BEAT_PERIOD   = 60000 / ATLAS_BPM; // 461.54 ms
const PULSE_AMP     = 0.18; // ±18% radius modulation
const GLOW_AMP      = 0.5;  // glow ring amplitude

let pulseRafId  = null;
let pulsePaused = false;

function pulseTick(ts) {
  if (pulsePaused) { pulseRafId = requestAnimationFrame(pulseTick); return; }

  const masterPhase = (ts % BEAT_PERIOD) / BEAT_PERIOD; // [0, 1)

  const svg = document.getElementById('atlas-svg');
  if (!svg) { pulseRafId = requestAnimationFrame(pulseTick); return; }

  svg.querySelectorAll('.atlas-city-dot').forEach(dot => {
    const baseR = parseFloat(dot.dataset.baseR);
    if (!baseR) return;
    const offset = parseFloat(dot.dataset.phaseOffset || 0);
    const phase  = (masterPhase + offset) % 1;
    const scale  = 1 + PULSE_AMP * Math.sin(phase * Math.PI * 2);
    dot.setAttribute('r', (baseR * scale).toFixed(3));
  });

  svg.querySelectorAll('.atlas-city-glow').forEach(glow => {
    const dotR = parseFloat(glow.nextElementSibling?.dataset.baseR || 4);
    const offset = parseFloat(glow.parentElement?.dataset.phaseOffset || 0);
    const phase  = (masterPhase + offset + 0.25) % 1; // quarter-beat offset
    const scale  = 1 + GLOW_AMP * Math.sin(phase * Math.PI * 2);
    glow.setAttribute('r', (dotR * 1.8 * scale).toFixed(3));
    glow.setAttribute('opacity', (0.15 + 0.25 * Math.sin(phase * Math.PI * 2)).toFixed(3));
  });

  pulseRafId = requestAnimationFrame(pulseTick);
}

window.startAtlasPulse = function() {
  if (!pulseRafId) pulseRafId = requestAnimationFrame(pulseTick);
};

window.stopAtlasPulse = function() {
  if (pulseRafId) { cancelAnimationFrame(pulseRafId); pulseRafId = null; }
};

window.pauseAtlasPulse  = function() { pulsePaused = true; };
window.resumeAtlasPulse = function() { pulsePaused = false; };
