// ── atlas-renderer.js ─────────────────────────────────────────────────────────
// SVG atlas: irregular continent blobs + city dots + rAF tween engine.
// ViewBox: 0 0 800 600

// ── Stable continent positions (800×600 space) ────────────────────────────────
const CONTINENT_REGISTRY = {
  'Funk / Soul':            { cx: 210, cy: 330 },
  'Jazz':                   { cx: 430, cy: 270 },
  'Folk, World, & Country': { cx: 295, cy: 125 },
  'Electronic':             { cx: 590, cy: 390 },
  'Reggae':                 { cx: 128, cy: 445 },
  'Rock':                   { cx: 638, cy: 128 },
  'Latin':                  { cx:  88, cy: 238 },
  'Hip Hop':                { cx: 188, cy:  85 },
  'Brass & Military':       { cx: 695, cy: 268 },
  'Stage & Screen':         { cx: 418, cy: 515 },
  'Pop':                    { cx: 718, cy: 468 },
};

// Each family has an earthy-dark fill tinted toward the family accent,
// a coastal stroke/glow color, and a highlight for terrain texture.
const FAMILY_COLORS = {
  'Funk / Soul':            { fill: '#3a2808', stroke: '#e8840a', hi: '#c8600a' },
  'Jazz':                   { fill: '#0a1c30', stroke: '#4898d8', hi: '#2870b8' },
  'Folk, World, & Country': { fill: '#1e2c08', stroke: '#78ba20', hi: '#509810' },
  'Electronic':             { fill: '#0c0824', stroke: '#8858e8', hi: '#6030c8' },
  'Reggae':                 { fill: '#042010', stroke: '#18c858', hi: '#0a9840' },
  'Rock':                   { fill: '#280808', stroke: '#e83838', hi: '#b81818' },
  'Latin':                  { fill: '#281808', stroke: '#e8a818', hi: '#b88010' },
  'Hip Hop':                { fill: '#180828', stroke: '#c038e8', hi: '#9018c8' },
  'Brass & Military':       { fill: '#201e08', stroke: '#d8c010', hi: '#a89808' },
  'Stage & Screen':         { fill: '#041828', stroke: '#38c8e8', hi: '#1898c8' },
  'Pop':                    { fill: '#200828', stroke: '#e838b8', hi: '#b81898' },
};
const DEFAULT_COLOR = { fill: '#181610', stroke: '#888', hi: '#555' };

// SVG namespace
const SVG_NS = 'http://www.w3.org/2000/svg';
function mkSvg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// ── Deterministic noise (returns [-1, 1]) ─────────────────────────────────────
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
    out.push(((h & 0xffff) / 0xffff) * 2 - 1);
  }
  return out;
}

// ── Organic continent blob via Catmull-Rom ────────────────────────────────────
// 14 control points, radius ±42%, angle ±42° — produces realistic coastlines.
function buildBlobPath(cx, cy, rx, ry, seed) {
  const N     = 14;
  const noiseR = deterministicNoise(seed + '_r', N);
  const noiseA = deterministicNoise(seed + '_a', N);

  const pts = [];
  for (let i = 0; i < N; i++) {
    const base  = (i / N) * Math.PI * 2;
    const angle = base + noiseA[i] * 0.42; // ±~24°
    const rScale = 1 + noiseR[i] * 0.42;   // ±42%
    pts.push({
      x: cx + rx * rScale * Math.cos(angle),
      y: cy + ry * rScale * Math.sin(angle),
    });
  }

  // Catmull-Rom → cubic bezier (closed)
  const d = [];
  for (let i = 0; i < N; i++) {
    const p0 = pts[(i - 1 + N) % N];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % N];
    const p3 = pts[(i + 2) % N];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    if (i === 0) d.push(`M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`);
    d.push(`C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`);
  }
  d.push('Z');
  return d.join(' ');
}

// ── Continent sizing (for 800×600 canvas) ────────────────────────────────────
function probToRx(p) { return 42 + Math.min(1, p) * 70; } // 42–112
function probToRy(p) { return 28 + Math.min(1, p) * 50; } // 28–78

// ── City dot layout: golden-angle sunflower ───────────────────────────────────
// Starts away from center (min r ≈ 55%) so continent label stays clear.
function cityPositions(count, rx, ry) {
  if (count === 1) return [[rx * 0.28, 0]]; // slight offset from center
  const PHI = Math.PI * (3 - Math.sqrt(5)); // golden angle ≈ 137.5°
  const spreadX = rx * 0.68;
  const spreadY = ry * 0.62;
  const pts = [];
  for (let i = 0; i < count; i++) {
    const r     = Math.sqrt((i + 0.6) / (count + 0.6)); // 0.55–1.0 range
    const angle = PHI * i;
    pts.push([r * spreadX * Math.cos(angle), r * spreadY * Math.sin(angle)]);
  }
  return pts;
}

function dotBaseR(prob, maxProb) {
  return 5 + (prob / (maxProb || 1)) * 5; // 5–10 px in 800×600 space
}

// ── rAF tween engine (for SVG geometry attributes) ───────────────────────────
const tweens = new Map();
let tweenRafId = null;

function tweenAttr(el, prop, target, duration = 480) {
  const uid = (el._atid || (el._atid = Math.random().toString(36).slice(2))) + prop;
  tweens.set(uid, {
    el, prop, target, duration, startTime: null,
    from: parseFloat(el.getAttribute(prop) || 0),
  });
  if (!tweenRafId) tweenRafId = requestAnimationFrame(processTweens);
}

function processTweens(ts) {
  for (const [k, tw] of tweens) {
    if (!tw.startTime) tw.startTime = ts;
    const t = Math.min(1, (ts - tw.startTime) / tw.duration);
    const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    tw.el.setAttribute(tw.prop, (tw.from + (tw.target - tw.from) * e).toFixed(3));
    if (t >= 1) tweens.delete(k);
  }
  tweenRafId = tweens.size ? requestAnimationFrame(processTweens) : null;
}

// ── Module state ──────────────────────────────────────────────────────────────
let atlasSvg = null;
const continentGroups = new Map(); // parent_family → <g>

// ── Init ──────────────────────────────────────────────────────────────────────
window.initAtlasRenderer = function(svgElement) {
  atlasSvg = svgElement;
  atlasSvg.setAttribute('viewBox', '0 0 800 600');

  const defs = document.createElementNS(SVG_NS, 'defs');

  // Radial gradient for ocean depth
  const oceanGrad = mkSvg('radialGradient', {
    id: 'ocean-depth', cx: '38%', cy: '36%', r: '72%',
    gradientUnits: 'userSpaceOnUse',
  });
  oceanGrad.setAttribute('gradientUnits', 'userSpaceOnUse');
  oceanGrad.setAttribute('cx', 300); oceanGrad.setAttribute('cy', 220);
  oceanGrad.setAttribute('r', 520);
  const os1 = mkSvg('stop', { offset: '0%',   'stop-color': '#1e4878' });
  const os2 = mkSvg('stop', { offset: '55%',  'stop-color': '#0e2848' });
  const os3 = mkSvg('stop', { offset: '100%', 'stop-color': '#071428' });
  oceanGrad.append(os1, os2, os3);
  defs.appendChild(oceanGrad);

  // Repeating wave pattern overlay
  const wave = mkSvg('pattern', {
    id: 'ocean-wave', x: 0, y: 0, width: 80, height: 24,
    patternUnits: 'userSpaceOnUse',
  });
  const waveLine = mkSvg('path', {
    d: 'M 0 12 Q 20 6 40 12 Q 60 18 80 12',
    stroke: 'rgba(255,255,255,0.05)',
    'stroke-width': 1, fill: 'none',
  });
  wave.appendChild(waveLine);
  defs.appendChild(wave);

  atlasSvg.appendChild(defs);

  // Ocean layers
  atlasSvg.appendChild(mkSvg('rect', { x: 0, y: 0, width: 800, height: 600, fill: 'url(#ocean-depth)' }));
  atlasSvg.appendChild(mkSvg('rect', { x: 0, y: 0, width: 800, height: 600, fill: 'url(#ocean-wave)' }));
};

// ── Empty state ───────────────────────────────────────────────────────────────
let emptyOverlay = null;
function showEmptyState() {
  if (!emptyOverlay) {
    emptyOverlay = mkSvg('text', {
      x: 400, y: 305, 'text-anchor': 'middle',
      fill: '#1e3858', 'font-family': "'SF Mono', monospace",
      'font-size': 18, 'letter-spacing': 4,
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

  const modeEl = document.getElementById('atlas-mode-label');
  const stemEl = document.getElementById('atlas-stem-count');
  if (modeEl) modeEl.textContent = data ? data.mode : '—';
  if (stemEl) stemEl.textContent = data ? data.stemCount + (data.stemCount === 1 ? ' STEM' : ' STEMS') : '0 STEMS';

  if (!data) { showEmptyState(); return; }
  hideEmptyState();

  const activeFamilies = new Set(data.continents.map(c => c.parent_family));

  // Fade out + remove stale continents
  for (const [fam, grp] of continentGroups) {
    if (!activeFamilies.has(fam)) {
      grp.style.transition = 'opacity 0.5s';
      grp.style.opacity = 0;
      setTimeout(() => grp.parentNode && grp.parentNode.removeChild(grp), 520);
      continentGroups.delete(fam);
    }
  }

  for (const continent of data.continents) upsertContinent(continent, data.mode);
};

// ── Continent upsert ──────────────────────────────────────────────────────────
function upsertContinent(continent, mode) {
  const { parent_family, total_prob, cities } = continent;
  const reg = CONTINENT_REGISTRY[parent_family] || { cx: 400, cy: 300 };
  const col = FAMILY_COLORS[parent_family] || DEFAULT_COLOR;
  const rx  = probToRx(total_prob);
  const ry  = probToRy(total_prob);

  let grp = continentGroups.get(parent_family);

  if (!grp) {
    grp = mkSvg('g', { class: 'atlas-continent', opacity: 0 });
    grp.dataset.family = parent_family;

    // ① Main land blob
    grp.appendChild(mkSvg('path', {
      class: 'continent-land',
      d: buildBlobPath(reg.cx, reg.cy, rx, ry, parent_family),
      fill: col.fill, 'fill-opacity': 0.97,
    }));

    // ② Coastal glow — slightly bigger path, same seed
    grp.appendChild(mkSvg('path', {
      class: 'continent-coast',
      d: buildBlobPath(reg.cx, reg.cy, rx * 1.06, ry * 1.06, parent_family),
      fill: 'none',
      stroke: col.stroke, 'stroke-width': 1.8, 'stroke-opacity': 0.55,
    }));

    // ③ Inner shoreline ring
    grp.appendChild(mkSvg('path', {
      class: 'continent-shore',
      d: buildBlobPath(reg.cx, reg.cy, rx * 0.90, ry * 0.90, parent_family + '_s'),
      fill: 'none',
      stroke: col.hi, 'stroke-width': 0.6, 'stroke-opacity': 0.2,
    }));

    // ④ Terrain highlight blob (offset, lighter)
    grp.appendChild(mkSvg('path', {
      class: 'continent-terrain',
      d: buildBlobPath(reg.cx - rx * 0.10, reg.cy - ry * 0.12, rx * 0.52, ry * 0.50, parent_family + '_h'),
      fill: col.hi, 'fill-opacity': 0.08,
    }));

    // ⑤ Continent label — cartographic style, inside the land mass
    const lbl = mkSvg('text', {
      class: 'atlas-continent-label',
      x: reg.cx, y: reg.cy,
      'text-anchor': 'middle', 'dominant-baseline': 'middle',
    });
    lbl.textContent = parent_family.toUpperCase();
    grp.appendChild(lbl);

    // ⑥ Cities container
    grp.appendChild(mkSvg('g', { class: 'continent-cities' }));

    atlasSvg.appendChild(grp);
    continentGroups.set(parent_family, grp);

    // Fade in after one frame so CSS transition fires
    requestAnimationFrame(() => {
      grp.style.transition = 'opacity 0.5s';
      grp.style.opacity = 1;
    });
  } else {
    // Update blob paths for new size
    const paths = {
      '.continent-land':    [rx,        ry,        parent_family],
      '.continent-coast':   [rx * 1.06, ry * 1.06, parent_family],
      '.continent-shore':   [rx * 0.90, ry * 0.90, parent_family + '_s'],
      '.continent-terrain': [rx * 0.52, ry * 0.50, parent_family + '_h', -rx * 0.10, -ry * 0.12],
    };
    for (const [sel, args] of Object.entries(paths)) {
      const el = grp.querySelector(sel);
      if (!el) continue;
      const [erx, ery, seed, dxOff = 0, dyOff = 0] = args;
      el.setAttribute('d', buildBlobPath(reg.cx + dxOff, reg.cy + dyOff, erx, ery, seed));
    }
    grp.style.opacity = 1;
  }

  updateCities(grp, continent, reg, rx, ry, mode);
}

// ── City dots ─────────────────────────────────────────────────────────────────
function updateCities(grp, continent, reg, rx, ry, mode) {
  const citiesG = grp.querySelector('.continent-cities');
  if (!citiesG) return;

  const { cities, parent_family } = continent;
  const existingMap = new Map();
  citiesG.querySelectorAll('.atlas-city-group').forEach(cg => existingMap.set(cg.dataset.key, cg));

  const positions    = cityPositions(cities.length, rx, ry);
  const maxProb      = cities[0]?.probability || 1;
  const activeKeys   = new Set(cities.map(c => parent_family + '|' + c.style));

  // Remove stale dots (fade r to 0 then detach)
  for (const [key, dotGrp] of existingMap) {
    if (!activeKeys.has(key)) {
      const circle = dotGrp.querySelector('circle.atlas-city-dot');
      if (circle) { tweenAttr(circle, 'r', 0); }
      setTimeout(() => dotGrp.parentNode && dotGrp.parentNode.removeChild(dotGrp), 500);
      existingMap.delete(key);
    }
  }

  cities.forEach((city, i) => {
    const key          = parent_family + '|' + city.style;
    const [dx, dy]     = positions[i] || [0, 0];
    const dotCx        = reg.cx + dx;
    const dotCy        = reg.cy + dy;
    const baseR        = dotBaseR(city.probability, maxProb);
    const phaseOff     = ((i / Math.max(cities.length, 1)) * 0.5).toFixed(4);

    let cityGrp = existingMap.get(key);

    if (!cityGrp) {
      cityGrp = mkSvg('g', { class: 'atlas-city-group' });
      cityGrp.dataset.key         = key;
      cityGrp.dataset.phaseOffset = phaseOff;

      // Glow halo
      cityGrp.appendChild(mkSvg('circle', {
        class: 'atlas-city-glow',
        cx: dotCx, cy: dotCy, r: baseR * 1.85,
        fill: 'none', stroke: 'rgba(255,255,255,0.18)', 'stroke-width': 0.8,
      }));

      // City dot — cream/parchment colour, map aesthetic
      const dot = mkSvg('circle', {
        class: 'atlas-city-dot',
        cx: dotCx, cy: dotCy, r: 0,
        fill: '#e8dfc0', 'fill-opacity': 0.92,
        stroke: '#fff', 'stroke-width': 0.7, 'stroke-opacity': 0.55,
        cursor: 'pointer',
      });
      dot.dataset.baseR        = baseR;
      dot.dataset.phaseOffset  = phaseOff;
      cityGrp.appendChild(dot);

      // Label — placed radially away from continent center
      appendCityLabel(cityGrp, city, dotCx, dotCy, baseR, dx, dy);

      // Hover / click events
      cityGrp.addEventListener('mouseenter', () => {
        cityGrp.querySelector('.atlas-city-dot')?.setAttribute('fill', '#ffffff');
        window.showAtlasDetail && window.showAtlasDetail({
          parent_family, style: city.style,
          probability: city.probability,
          contributing_stems: city.contributing_stems,
        });
      });
      cityGrp.addEventListener('mouseleave', () => {
        if (!cityGrp.dataset.pinned) {
          cityGrp.querySelector('.atlas-city-dot')?.setAttribute('fill', '#e8dfc0');
          window.hideAtlasDetail && window.hideAtlasDetail();
        }
      });
      cityGrp.addEventListener('click', e => {
        e.stopPropagation();
        atlasSvg.querySelectorAll('.atlas-city-group[data-pinned]').forEach(g => {
          delete g.dataset.pinned;
          g.querySelector('.atlas-city-dot')?.setAttribute('fill', '#e8dfc0');
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
      const dot  = cityGrp.querySelector('.atlas-city-dot');
      const glow = cityGrp.querySelector('.atlas-city-glow');
      if (dot) {
        dot.dataset.baseR = baseR;
        tweenAttr(dot, 'cx', dotCx); tweenAttr(dot, 'cy', dotCy); tweenAttr(dot, 'r', baseR);
      }
      if (glow) {
        tweenAttr(glow, 'cx', dotCx); tweenAttr(glow, 'cy', dotCy);
        tweenAttr(glow, 'r', baseR * 1.85);
      }
      updateCityLabel(cityGrp, city, dotCx, dotCy, baseR, dx, dy);
    }
  });
}

// ── Label placement (radially outward from continent center) ──────────────────
function radialLabelPos(dotCx, dotCy, baseR, dx, dy) {
  const len  = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx   = Math.abs(dx) < 1 && Math.abs(dy) < 1 ? 1  : dx / len;
  const ny   = Math.abs(dx) < 1 && Math.abs(dy) < 1 ? 0  : dy / len;
  const off  = baseR + 8;
  return {
    lx:     dotCx + nx * off,
    ly:     dotCy + ny * off,
    anchor: nx >= 0 ? 'start' : 'end',
    nameY:  dotCy + ny * off,
    pctY:   dotCy + ny * off + 12,
  };
}

function appendCityLabel(grp, city, cx, cy, r, dx, dy) {
  const { lx, anchor, nameY, pctY } = radialLabelPos(cx, cy, r, dx, dy);

  const nm = mkSvg('text', {
    class: 'atlas-city-label',
    x: lx, y: nameY,
    'dominant-baseline': 'central',
    'text-anchor': anchor,
    'font-family': "'Jaini', monospace",
    'font-size': 9.5,
    fill: '#cec8a8',
  });
  nm.textContent = city.style;
  grp.appendChild(nm);

  const pct = mkSvg('text', {
    class: 'atlas-city-sublabel',
    x: lx, y: pctY,
    'text-anchor': anchor,
    'font-family': "'Jaini', monospace",
    'font-size': 8,
    fill: '#788868',
  });
  pct.textContent = (city.probability * 100).toFixed(1) + '%';
  grp.appendChild(pct);
}

function updateCityLabel(grp, city, cx, cy, r, dx, dy) {
  const nm  = grp.querySelector('.atlas-city-label');
  const pct = grp.querySelector('.atlas-city-sublabel');
  if (!nm || !pct) return;

  const { lx, anchor, nameY, pctY } = radialLabelPos(cx, cy, r, dx, dy);
  nm.setAttribute('x', lx);  nm.setAttribute('y', nameY);  nm.setAttribute('text-anchor', anchor);
  nm.textContent = city.style;
  pct.setAttribute('x', lx); pct.setAttribute('y', pctY);  pct.setAttribute('text-anchor', anchor);
  pct.textContent = (city.probability * 100).toFixed(1) + '%';
}
