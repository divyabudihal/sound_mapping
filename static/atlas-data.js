// ── atlas-data.js ─────────────────────────────────────────────────────────────
// Pure data transform: stem state + analysis JSON → atlas continent/city tree.
// (parent_family, style) tuples are the unit — hierarchy is never flattened.

const ALL_STEM_IDS = ['vocals', 'drums', 'bass', 'wind', 'guitar', 'keys'];
const MAX_CITIES   = 12; // global cap across all continents

window.getActiveAtlasData = function(activeStemIds, analysis) {
  const n = activeStemIds.length;
  if (n === 0) return null;

  // All 6 stems active → use full-mix baseline
  if (n === ALL_STEM_IDS.length &&
      ALL_STEM_IDS.every(id => activeStemIds.includes(id)) &&
      analysis.full_mix_classifications && analysis.full_mix_classifications.length) {
    return buildFromFullMix(analysis);
  }

  return buildFromStemAverage(activeStemIds, analysis);
};

// ─────────────────────────────────────────────────────────────────────────────

function buildFromFullMix(analysis) {
  const parentMap = {};
  for (const p of analysis.full_mix_parent_totals) {
    parentMap[p.parent_family] = p.total_probability;
  }

  // Take top MAX_CITIES by probability
  const sorted = [...analysis.full_mix_classifications]
    .sort((a, b) => b.probability - a.probability)
    .slice(0, MAX_CITIES);

  const cityMap = {};
  for (const c of sorted) {
    const key = c.parent_family + '|' + c.style;
    cityMap[key] = {
      parent_family: c.parent_family,
      style: c.style,
      probability: c.probability,
      contributing_stems: [], // full mix — no individual stem attribution
    };
  }

  return assemble('FULL MIX DNA', ALL_STEM_IDS.length, parentMap, cityMap);
}

function buildFromStemAverage(activeStemIds, analysis) {
  // Accumulate per (parent_family, style) pair.
  // Divide by stems that HAVE this genre — not by total selected stems.
  const cityAcc = {};
  for (const stemId of activeStemIds) {
    const entries = (analysis.stem_classifications && analysis.stem_classifications[stemId]) || [];
    for (const e of entries) {
      const key = e.parent_family + '|' + e.style;
      if (!cityAcc[key]) {
        cityAcc[key] = { parent_family: e.parent_family, style: e.style, sum: 0, stems: [] };
      }
      cityAcc[key].sum += e.probability;
      if (!cityAcc[key].stems.includes(stemId)) cityAcc[key].stems.push(stemId);
    }
  }

  // Parent totals: divide by stems that have that parent family.
  const parentAcc   = {};
  const parentCount = {};
  for (const stemId of activeStemIds) {
    const entries = (analysis.stem_parent_totals && analysis.stem_parent_totals[stemId]) || [];
    for (const e of entries) {
      parentAcc[e.parent_family]   = (parentAcc[e.parent_family]   || 0) + e.total_probability;
      parentCount[e.parent_family] = (parentCount[e.parent_family] || 0) + 1;
    }
  }

  // Build averaged city map
  const cityMap = {};
  for (const [key, acc] of Object.entries(cityAcc)) {
    cityMap[key] = {
      parent_family:     acc.parent_family,
      style:             acc.style,
      probability:       acc.sum / acc.stems.length, // average over stems that have it
      contributing_stems: acc.stems.slice(), // deduplicated above
    };
  }

  // Global top-12 cap
  const top12 = new Set(
    Object.entries(cityMap)
      .sort((a, b) => b[1].probability - a[1].probability)
      .slice(0, MAX_CITIES)
      .map(([key]) => key)
  );
  for (const key of Object.keys(cityMap)) {
    if (!top12.has(key)) delete cityMap[key];
  }

  // Average parent totals
  const parentMap = {};
  for (const [fam, sum] of Object.entries(parentAcc)) {
    parentMap[fam] = sum / parentCount[fam];
  }

  return assemble('SELECTED STEM AVERAGE', activeStemIds.length, parentMap, cityMap);
}

// ─────────────────────────────────────────────────────────────────────────────

function assemble(mode, stemCount, parentMap, cityMap) {
  // Group surviving cities by parent family
  const continentMap = {};
  for (const city of Object.values(cityMap)) {
    if (!continentMap[city.parent_family]) continentMap[city.parent_family] = [];
    continentMap[city.parent_family].push(city);
  }

  const continents = [];
  for (const [parent_family, cities] of Object.entries(continentMap)) {
    const total_prob = parentMap[parent_family] || 0;
    if (total_prob < 0.01) continue;

    const filteredCities = cities
      .filter(c => c.probability >= 0.005)
      .sort((a, b) => b.probability - a.probability);

    if (!filteredCities.length) continue;
    continents.push({ parent_family, total_prob, cities: filteredCities });
  }

  continents.sort((a, b) => b.total_prob - a.total_prob);
  return { mode, stemCount, continents };
}
