// ── atlas-data.js ─────────────────────────────────────────────────────────────
// Pure data transform: stem state + analysis JSON → atlas continent/city tree.
// Preserves full hierarchy: (parent_family, style) tuples are the keys.

const ALL_STEM_IDS = ['vocals', 'drums', 'bass', 'wind', 'guitar', 'keys'];

window.getActiveAtlasData = function(activeStemIds, analysis) {
  const n = activeStemIds.length;

  if (n === 0) return null;

  // All 6 stems active → full-mix baseline
  if (n === ALL_STEM_IDS.length &&
      ALL_STEM_IDS.every(id => activeStemIds.includes(id)) &&
      analysis.full_mix_classifications && analysis.full_mix_classifications.length) {
    return buildFromFullMix(analysis);
  }

  // Partial selection → average across selected stems
  return buildFromStemAverage(activeStemIds, analysis);
};

function buildFromFullMix(analysis) {
  const parentMap = {};
  for (const p of analysis.full_mix_parent_totals) {
    parentMap[p.parent_family] = p.total_probability;
  }

  const cityMap = {}; // key: "parent|style"
  for (const c of analysis.full_mix_classifications) {
    const key = c.parent_family + '|' + c.style;
    cityMap[key] = {
      style: c.style,
      probability: c.probability,
      contributing_stems: [], // full mix — no individual stems
    };
  }

  return assemble('FULL MIX DNA', ALL_STEM_IDS.length, parentMap, cityMap);
}

function buildFromStemAverage(activeStemIds, analysis) {
  const n = activeStemIds.length;

  // Accumulate city probabilities
  const cityAcc = {}; // key → { style, parent_family, sum, stems[] }
  for (const stemId of activeStemIds) {
    const entries = (analysis.stem_classifications && analysis.stem_classifications[stemId]) || [];
    for (const e of entries) {
      const key = e.parent_family + '|' + e.style;
      if (!cityAcc[key]) {
        cityAcc[key] = { style: e.style, parent_family: e.parent_family, sum: 0, stems: [] };
      }
      cityAcc[key].sum += e.probability;
      cityAcc[key].stems.push(stemId);
    }
  }

  // Accumulate parent probabilities
  const parentAcc = {}; // parent_family → sum
  for (const stemId of activeStemIds) {
    const entries = (analysis.stem_parent_totals && analysis.stem_parent_totals[stemId]) || [];
    for (const e of entries) {
      parentAcc[e.parent_family] = (parentAcc[e.parent_family] || 0) + e.total_probability;
    }
  }

  // Average
  const cityMap = {};
  for (const [key, acc] of Object.entries(cityAcc)) {
    cityMap[key] = {
      style: acc.style,
      probability: acc.sum / n,
      contributing_stems: acc.stems,
    };
  }

  const parentMap = {};
  for (const [fam, sum] of Object.entries(parentAcc)) {
    parentMap[fam] = sum / n;
  }

  return assemble('SELECTED STEM AVERAGE', n, parentMap, cityMap);
}

function assemble(mode, stemCount, parentMap, cityMap) {
  // Group cities by parent_family
  const continentMap = {};
  for (const [key, city] of Object.entries(cityMap)) {
    const parent = key.split('|')[0];
    if (!continentMap[parent]) continentMap[parent] = [];
    continentMap[parent].push(city);
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
