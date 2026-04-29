// ── atlas-renderer.js ─────────────────────────────────────────────────────────
// SVG continent + city dot rendering with rAF tween engine.

const CONTINENT_REGISTRY = {
  'Funk / Soul':            { cx: 120, cy: 210 },
  'Jazz':                   { cx: 235, cy: 190 },
  'Folk, World, & Country': { cx: 175, cy:  75 },
  'Electronic':             { cx: 258, cy: 305 },
  'Reggae':                 { cx:  82, cy: 318 },
  'Rock':                   { cx: 295, cy:  88 },
  'Latin':                  { cx:  58, cy: 178 },
  'Hip Hop':                { cx: 108, cy:  58 },
  'Brass & Military':       { cx: 318, cy: 228 },
  'Stage & Screen':         { cx: 198, cy: 362 },
  'Pop':                    { cx: 335, cy: 338 },
};

const FAMILY_COLORS = {
  'Funk / Soul':            { fill: '#2a1800', stroke: '#ff8c00' },
  'Jazz':                   { fill: '#001428', stroke: '#44aaff' },
  'Folk, World, & Country': { fill: '#142000', stroke: '#66cc22' },
  'Electronic':             { fill: '#08001a', stroke: '#8855ff' },
  'Reggae':                 { fill: '#001a08', stroke: '#22cc66' },
  'Rock':                   { fill: '#1e0000', stroke: '#ff4444' },
  'Latin':                  { fill: '#1e1000', stroke: '#ffaa22' },
  'Hip Hop':                { fill: '#140014', stroke: '#cc44ff' },
  'Brass & Military':       { fill: '#1a1800', stroke: '#ddcc22' },
  'Stage & Screen':         { fill: '#001420', stroke: '#44ccff' },
  'Pop':                    { fill: '#180018', stroke: '#ff44cc' },
};

const STEM_COLORS = {
  vocals: '#FF6B35', drums: '#FFD700', bass: '#E040FB',
  wind: '#00E5FF', guitar: '#69F0AE', keys: '#FF4081',
};

const DEFAULT_COLOR = { fill: '#1a1a1a', stroke: '#666' };

// SVG namespace helper
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl2(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// ── Deterministic noise for blob shapes ──────────────────────────────────────
function strHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function deterministicNoise(seed, count) {
  let h = strHash(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    h = (Math.imul(h, 1664525) + 1013904223) | 0;
    out.push(((h & 0xffff) / 0xffff) * 0.28 - 0.14); // [-0.14, 0.14]
  }
  return out;
}

// Build a smooth closed SVG path through noise-perturbed ellipse points
function buildBlobPath(cx, cy, rx, ry, seed) {
  const n = 7;
  const noiseR = deterministicNoise(seed + 'r', n);
  const noiseA = deterministicNoise(seed + 'a', n);

  const pts = [];
  for (let i = 0; i < n; i++) {
    const base = (i / n) * Math.PI * 2;
    const angle = base + noiseA[i] * 0.3;
    const r_scale = 1 + noiseR[i];
    pts.push({
      x: cx + rx * r_scale * Math.cos(angle),
      y: cy + ry * r_scale * Math.sin(angle),
    });
  }

  // Catmull-Rom → cubic bezier, closed
  const d = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    if (i === 0) d.push(`M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`);
    d.push(`C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`);
  }
  d.push('Z');
  return d.join(' ');
}

// ── Continent sizing ──────────────────────────────────────────────────────────
function probToRx(p) { return 22 + Math.min(1, p) * 44; }
function probToRy(p) { return 15 + Math.min(1, p) * 30; }

// ── City dot layout within a continent ───────────────────────────────────────
function cityPositions(count, rx, ry) {
  const cr = Math.min(rx, ry) * 0.52;
  const raw = [];

  if (count === 1) {
    raw.push([0, 0]);
  } else if (count === 2) {
    raw.push([-cr * 0.38, 0], [cr * 0.38, 0]);
  } else if (count === 3) {
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
      raw.push([Math.cos(a) * cr * 0.44, Math.sin(a) * cr * 0.44]);
    }
  } else if (count === 4) {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      raw.push([Math.cos(a) * cr * 0.44, Math.sin(a) * cr * 0.44]);
    }
  } else if (count === 5) {
    raw.push([0, 0]);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 - Math.PI / 2;
      raw.push([Math.cos(a) * cr * 0.5, Math.sin(a) * cr * 0.5]);
    }
  } else {
    // Hexagonal ring for 6+
    const inner = Math.min(3, count - 3);
    const outer = count - inner;
    for (let i = 0; i < inner; i++) {
      const a = (i / inner) * Math.PI * 2;
      raw.push([Math.cos(a) * cr * 0.25, Math.sin(a) * cr * 0.25]);
    }
    for (let i = 0; i < outer; i++) {
      const a = (i / outer) * Math.PI * 2 - Math.PI / 6;
      raw.push([Math.cos(a) * cr * 0.54, Math.sin(a) * cr * 0.54]);
    }
  }

  // Scale offsets by actual continent aspect
  return raw.map(([dx, dy]) => [dx * (rx / 50), dy * (ry / 35)]);
}

function dotBaseR(prob, maxProb) {
  return 3.5 + (prob / (maxProb || 1)) * 4;
}

// ── rAF tween engine ─────────────────────────────────────────────────────────
const tweens = new Map();
let tweenRafId = null;

function tweenAttr(el, prop, target, duration = 480) {
  const key = (el._atlasId || (el._atlasId = Math.random().toString(36).slice(2))) + prop;
  const current = parseFloat(el.getAttribute(prop) || 0);
  tweens.set(key, { el, prop, from: current, target, duration, startTime: null });
  if (!tweenRafId) tweenRafId = requestAnimationFrame(processTweens);
}

function processTweens(ts) {
  for (const [key, tw] of tweens) {
    if (!tw.startTime) tw.startTime = ts;
    const t = Math.min(1, (ts - tw.startTime) / tw.duration);
    const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // ease-in-out quad
    tw.el.setAttribute(tw.prop, (tw.from + (tw.target - tw.from) * e).toFixed(3));
    if (t >= 1) tweens.delete(key);
  }
  tweenRafId = tweens.size > 0 ? requestAnimationFrame(processTweens) : null;
}

// ── DOM state ─────────────────────────────────────────────────────────────────
let atlasSvg = null;
const continentGroups = new Map(); // parent_family → <g>

window.initAtlasRenderer = function(svgElement) {
  atlasSvg = svgElement;

  // Ocean background gradient
  const defEl = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'radialGradient');
  grad.id = 'atlas-ocean-grad';
  grad.setAttribute('cx', '50%'); grad.setAttribute('cy', '45%');
  grad.setAttribute('r', '60%');
  const s1 = document.createElementNS(SVG_NS, 'stop');
  s1.setAttribute('offset', '0%'); s1.setAttribute('stop-color', '#0d1a22');
  const s2 = document.createElementNS(SVG_NS, 'stop');
  s2.setAttribute('offset', '100%'); s2.setAttribute('stop-color', '#080c10');
  grad.appendChild(s1); grad.appendChild(s2);
  defEl.appendChild(grad);
  atlasSvg.appendChild(defEl);

  // Ocean rect
  const ocean = svgEl2('rect', { x: 0, y: 0, width: 360, height: 400,
    fill: 'url(#atlas-ocean-grad)' });
  atlasSvg.appendChild(ocean);

  // Subtle grid lines for depth
  const grid = svgEl2('g', { opacity: '0.06' });
  for (let x = 0; x <= 360; x += 40) {
    grid.appendChild(svgEl2('line', { x1: x, y1: 0, x2: x, y2: 400,
      stroke: '#4488aa', 'stroke-width': 0.5 }));
  }
  for (let y = 0; y <= 400; y += 40) {
    grid.appendChild(svgEl2('line', { x1: 0, y1: y, x2: 360, y2: y,
      stroke: '#4488aa', 'stroke-width': 0.5 }));
  }
  atlasSvg.appendChild(grid);
};

// ── Empty / null state ────────────────────────────────────────────────────────
let emptyOverlay = null;

function showEmptyState() {
  if (!emptyOverlay) {
    emptyOverlay = svgEl2('text', {
      x: 180, y: 200, 'text-anchor': 'middle',
      fill: '#2a2a2a', 'font-family': "'SF Mono', monospace",
      'font-size': 11, 'letter-spacing': 2,
    });
    emptyOverlay.textContent = 'NO STEMS ACTIVE';
    atlasSvg.appendChild(emptyOverlay);
  }
  emptyOverlay.style.display = '';
  continentGroups.forEach(g => { g.style.opacity = 0; });
}

function hideEmptyState() {
  if (emptyOverlay) emptyOverlay.style.display = 'none';
}

// ── Main render entry ─────────────────────────────────────────────────────────
window.renderAtlas = function(data) {
  if (!atlasSvg) return;

  // Update status bar
  const modeEl = document.getElementById('atlas-mode-label');
  const stemEl = document.getElementById('atlas-stem-count');
  if (modeEl) modeEl.textContent = data ? data.mode : '—';
  if (stemEl) stemEl.textContent = data ? data.stemCount + (data.stemCount === 1 ? ' STEM' : ' STEMS') : '0 STEMS';

  if (!data) {
    showEmptyState();
    return;
  }
  hideEmptyState();

  const activeFamilies = new Set(data.continents.map(c => c.parent_family));

  // Remove stale continents
  for (const [fam, grp] of continentGroups) {
    if (!activeFamilies.has(fam)) {
      grp.style.transition = 'opacity 0.5s';
      grp.style.opacity = 0;
      setTimeout(() => { if (grp.parentNode) grp.parentNode.removeChild(grp); }, 520);
      continentGroups.delete(fam);
    }
  }

  // Upsert continents
  for (const continent of data.continents) {
    upsertContinent(continent, data.mode);
  }
};

function upsertContinent(continent, mode) {
  const { parent_family, total_prob, cities } = continent;
  const reg = CONTINENT_REGISTRY[parent_family] || { cx: 180, cy: 200 };
  const col = FAMILY_COLORS[parent_family] || DEFAULT_COLOR;
  const rx = probToRx(total_prob);
  const ry = probToRy(total_prob);

  let grp = continentGroups.get(parent_family);

  if (!grp) {
    // Create new continent group
    grp = svgEl2('g', { class: 'atlas-continent', opacity: 0 });
    grp.dataset.family = parent_family;

    // Blob (organic shape background)
    const blob = svgEl2('path', {
      class: 'continent-blob',
      d: buildBlobPath(reg.cx, reg.cy, rx, ry, parent_family),
      fill: col.stroke,
      'fill-opacity': 0.07,
      stroke: 'none',
    });
    grp.appendChild(blob);

    // Base ellipse
    const ell = svgEl2('ellipse', {
      class: 'continent-body',
      cx: reg.cx, cy: reg.cy,
      rx, ry,
      fill: col.fill,
      'fill-opacity': 0.9,
      stroke: col.stroke,
      'stroke-width': 1.2,
      'stroke-opacity': 0.7,
    });
    grp.appendChild(ell);

    // Shoreline shimmer (inner ellipse)
    const shore = svgEl2('ellipse', {
      class: 'continent-shore',
      cx: reg.cx, cy: reg.cy,
      rx: rx * 0.88, ry: ry * 0.88,
      fill: 'none',
      stroke: col.stroke,
      'stroke-width': 0.4,
      'stroke-opacity': 0.25,
    });
    grp.appendChild(shore);

    // Label
    const label = svgEl2('text', {
      class: 'atlas-continent-label',
      x: reg.cx,
      y: reg.cy + ry + 11,
      'text-anchor': 'middle',
    });
    label.textContent = parent_family.toUpperCase();
    grp.appendChild(label);

    // Cities container
    const citiesG = svgEl2('g', { class: 'continent-cities' });
    grp.appendChild(citiesG);

    atlasSvg.appendChild(grp);
    continentGroups.set(parent_family, grp);

    // Fade in
    requestAnimationFrame(() => {
      grp.style.transition = 'opacity 0.5s';
      grp.style.opacity = 1;
    });
  } else {
    // Update existing ellipse + blob size
    const ell = grp.querySelector('.continent-body');
    const blob = grp.querySelector('.continent-blob');
    const shore = grp.querySelector('.continent-shore');
    const label = grp.querySelector('.atlas-continent-label');

    if (ell) { tweenAttr(ell, 'rx', rx); tweenAttr(ell, 'ry', ry); }
    if (blob) blob.setAttribute('d', buildBlobPath(reg.cx, reg.cy, rx, ry, parent_family));
    if (shore) { tweenAttr(shore, 'rx', rx * 0.88); tweenAttr(shore, 'ry', ry * 0.88); }
    if (label) label.setAttribute('y', reg.cy + ry + 11);
    grp.style.opacity = 1;
  }

  // Update city dots
  updateCities(grp, continent, reg, rx, ry, mode);
}

function updateCities(grp, continent, reg, rx, ry, mode) {
  const citiesG = grp.querySelector('.continent-cities');
  if (!citiesG) return;

  const { cities, parent_family } = continent;
  const existingDots = new Map();
  citiesG.querySelectorAll('.atlas-city-group').forEach(cg => {
    existingDots.set(cg.dataset.key, cg);
  });

  const positions = cityPositions(cities.length, rx, ry);
  const maxProb = cities[0]?.probability || 1;
  const activeFamilyKeys = new Set(cities.map(c => parent_family + '|' + c.style));

  // Remove stale dots
  for (const [key, dotGrp] of existingDots) {
    if (!activeFamilyKeys.has(key)) {
      const circle = dotGrp.querySelector('circle');
      if (circle) {
        tweenAttr(circle, 'r', 0);
        setTimeout(() => { if (dotGrp.parentNode) dotGrp.parentNode.removeChild(dotGrp); }, 500);
      }
      existingDots.delete(key);
    }
  }

  cities.forEach((city, i) => {
    const key = parent_family + '|' + city.style;
    const [dx, dy] = positions[i] || [0, 0];
    const cx = reg.cx + dx;
    const cy = reg.cy + dy;
    const baseR = dotBaseR(city.probability, maxProb);
    const showLabel = i < 4;

    let cityGrp = existingDots.get(key);

    if (!cityGrp) {
      cityGrp = svgEl2('g', { class: 'atlas-city-group' });
      cityGrp.dataset.key = key;
      cityGrp.dataset.phaseOffset = ((i / Math.max(cities.length, 1)) * 0.5).toFixed(4);

      // Glow ring (pulsed separately by pulse engine)
      const glow = svgEl2('circle', {
        class: 'atlas-city-glow',
        cx, cy, r: baseR * 1.8,
        fill: 'none',
        stroke: dotColor(city, mode),
        'stroke-width': 0.8,
        opacity: 0.3,
      });
      cityGrp.appendChild(glow);

      // Main dot
      const dot = svgEl2('circle', {
        class: 'atlas-city-dot',
        cx, cy, r: 0,
        fill: dotColor(city, mode),
        'fill-opacity': 0.9,
        stroke: '#fff',
        'stroke-width': 0.4,
        'stroke-opacity': 0.4,
        cursor: 'pointer',
      });
      dot.dataset.baseR = baseR;
      dot.dataset.phaseOffset = cityGrp.dataset.phaseOffset;
      cityGrp.appendChild(dot);

      if (showLabel) appendCityLabel(cityGrp, city, cx, cy, baseR);

      // Hover / click
      cityGrp.addEventListener('mouseenter', () => {
        window.showAtlasDetail && window.showAtlasDetail({
          parent_family, style: city.style,
          probability: city.probability,
          contributing_stems: city.contributing_stems,
        });
        cityGrp.querySelector('.atlas-city-dot')?.setAttribute('stroke-opacity', 1);
      });
      cityGrp.addEventListener('mouseleave', () => {
        if (!cityGrp.dataset.pinned) {
          window.hideAtlasDetail && window.hideAtlasDetail();
          cityGrp.querySelector('.atlas-city-dot')?.setAttribute('stroke-opacity', 0.4);
        }
      });
      cityGrp.addEventListener('click', () => {
        // Unpin all others
        atlasSvg.querySelectorAll('.atlas-city-group[data-pinned]').forEach(g => {
          delete g.dataset.pinned;
          g.querySelector('.atlas-city-dot')?.setAttribute('stroke-opacity', 0.4);
        });
        cityGrp.dataset.pinned = '1';
        window.showAtlasDetail && window.showAtlasDetail({
          parent_family, style: city.style,
          probability: city.probability,
          contributing_stems: city.contributing_stems,
        });
      });

      citiesG.appendChild(cityGrp);
      tweenAttr(dot, 'r', baseR);
    } else {
      // Update existing dot
      const dot = cityGrp.querySelector('.atlas-city-dot');
      const glow = cityGrp.querySelector('.atlas-city-glow');
      if (dot) {
        dot.dataset.baseR = baseR;
        dot.setAttribute('fill', dotColor(city, mode));
        tweenAttr(dot, 'r', baseR);
        tweenAttr(dot, 'cx', cx);
        tweenAttr(dot, 'cy', cy);
      }
      if (glow) {
        glow.setAttribute('cx', cx); glow.setAttribute('cy', cy);
        glow.setAttribute('stroke', dotColor(city, mode));
        tweenAttr(glow, 'r', baseR * 1.8);
      }
      // Update label if present
      updateCityLabel(cityGrp, city, cx, cy, baseR, showLabel);
    }
  });
}

function dotColor(city, mode) {
  if (mode === 'FULL MIX DNA') return '#e8e8e8';
  // Color by first contributing stem
  const s = city.contributing_stems && city.contributing_stems[0];
  return (s && STEM_COLORS[s]) || '#e8e8e8';
}

function appendCityLabel(grp, city, cx, cy, r) {
  const labelX = cx + r + 5;
  const anchor = labelX > 300 ? 'end' : 'start';
  const lx = anchor === 'end' ? cx - r - 5 : labelX;

  const name = svgEl2('text', {
    class: 'atlas-city-label',
    x: lx, y: cy - 1,
    'text-anchor': anchor,
    'font-family': "'SF Mono', monospace",
    'font-size': 7.5,
    fill: '#bbb',
  });
  name.textContent = city.style;
  grp.appendChild(name);

  const pct = svgEl2('text', {
    class: 'atlas-city-sublabel',
    x: lx, y: cy + 8,
    'text-anchor': anchor,
    'font-family': "'SF Mono', monospace",
    'font-size': 6.5,
    fill: '#555',
  });
  pct.textContent = (city.probability * 100).toFixed(1) + '%';
  grp.appendChild(pct);
}

function updateCityLabel(grp, city, cx, cy, r, showLabel) {
  const existing = grp.querySelectorAll('.atlas-city-label, .atlas-city-sublabel');
  if (!showLabel) { existing.forEach(el => el.remove()); return; }
  if (existing.length === 0) { appendCityLabel(grp, city, cx, cy, r); return; }

  const labelX = cx + r + 5;
  const anchor = labelX > 300 ? 'end' : 'start';
  const lx = anchor === 'end' ? cx - r - 5 : labelX;

  existing.forEach(el => {
    el.setAttribute('x', lx);
    el.setAttribute('text-anchor', anchor);
    if (el.classList.contains('atlas-city-label')) {
      el.setAttribute('y', cy - 1);
      el.textContent = city.style;
    } else {
      el.setAttribute('y', cy + 8);
      el.textContent = (city.probability * 100).toFixed(1) + '%';
    }
  });
}
