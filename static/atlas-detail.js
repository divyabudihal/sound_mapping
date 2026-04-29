// ── atlas-detail.js ───────────────────────────────────────────────────────────
// Manages the detail panel shown on city dot hover / click.

const DETAIL_STEM_COLORS = {
  vocals: '#FF6B35', drums: '#FFD700', bass: '#E040FB',
  wind: '#00E5FF', guitar: '#69F0AE', keys: '#FF4081',
};

let detailPinned = false;

window.showAtlasDetail = function({ parent_family, style, probability, contributing_stems }) {
  const inner = document.getElementById('atlas-detail-inner');
  if (!inner) return;

  const pct = (probability * 100).toFixed(1);

  let chipsHtml;
  if (contributing_stems && contributing_stems.length > 0) {
    // Deduplicate stems (a stem may appear multiple times)
    const unique = [...new Set(contributing_stems)];
    chipsHtml = unique.map(s => {
      const color = DETAIL_STEM_COLORS[s] || '#888';
      return `<span class="atlas-detail-stem-chip" style="color:${color};border-color:${color}">${s.toUpperCase()}</span>`;
    }).join('');
  } else {
    chipsHtml = `<span class="atlas-detail-stem-chip" style="color:#666;border-color:#333">FULL MIX</span>`;
  }

  inner.innerHTML = `
    <div class="atlas-detail-family">${parent_family}</div>
    <div class="atlas-detail-style">${style}</div>
    <div class="atlas-detail-prob">${pct}% match</div>
    <div class="atlas-detail-stems">${chipsHtml}</div>
  `;
  inner.classList.add('visible');
};

window.hideAtlasDetail = function() {
  if (detailPinned) return;
  const inner = document.getElementById('atlas-detail-inner');
  if (inner) inner.classList.remove('visible');
};

window.unpinAtlasDetail = function() {
  detailPinned = false;
  const inner = document.getElementById('atlas-detail-inner');
  if (inner) inner.classList.remove('visible');
};

// Clicking outside all city dots unpins
document.addEventListener('click', e => {
  if (!e.target.closest('.atlas-city-group') && !e.target.closest('#atlas-detail-panel')) {
    window.unpinAtlasDetail();
  }
});
