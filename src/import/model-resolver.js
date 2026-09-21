import { resolveLenovoMtmPrefix } from './lenovo-mtm-map.js';

/** Apple hardware identifiers from Intune (e.g. iPhone15,4). */
const iphoneIdentifierMap = new Map([
  ['iphone12 1', { name: 'iPhone 11', generation: 'Standard' }],
  ['iphone12 8', { name: 'iPhone SE', generation: '2nd gen' }],
  ['iphone13 1', { name: 'iPhone 12', generation: 'Standard' }],
  ['iphone14 5', { name: 'iPhone 13', generation: 'Standard' }],
  ['iphone14 6', { name: 'iPhone SE', generation: '3rd gen' }],
  ['iphone14 7', { name: 'iPhone 14', generation: 'Standard' }],
  ['iphone14 8', { name: 'iPhone 14', generation: 'Plus' }],
  ['iphone15 2', { name: 'iPhone 14 Pro', generation: 'Pro' }],
  ['iphone15 3', { name: 'iPhone 14 Pro Max', generation: 'Pro Max' }],
  ['iphone15 4', { name: 'iPhone 15', generation: 'Standard' }],
  ['iphone16 1', { name: 'iPhone 15 Pro', generation: 'Pro' }],
  ['iphone16 2', { name: 'iPhone 15 Pro Max', generation: 'Pro Max' }],
  ['iphone17 3', { name: 'iPhone 16e', generation: 'Standard' }],
  ['iphone17 1', { name: 'iPhone 16 Pro', generation: 'Pro' }]
]);

export function resolveModel(catalog, row, overrides = {}) {
  const overrideModelId = overrides[row.serialNumber] || overrides[row.externalId] || overrides[row.line];
  if (overrideModelId) {
    const model = catalog.models.find((item) => item.id === overrideModelId);
    if (model) return result(model, 'manual');
  }

  if (row.source === 'intune') return resolveIntuneModel(catalog, row);
  if (row.source === 'jamf') return resolveJamfModel(catalog, row);
  return { model: null, match: 'none', warnings: ['Sursa importului nu este cunoscuta.'] };
}

export function modelLabel(catalog, modelId) {
  const model = catalog.models.find((item) => item.id === modelId);
  if (!model) return '';
  const brand = catalog.brands.find((item) => item.id === model.brandId);
  return `${brand?.name ?? ''} ${model.name} ${model.generation}`.trim();
}

function resolveIntuneModel(catalog, row) {
  if (row.mtrRegion === 'RO' || row.mtrRegion === 'BG') {
    return resolveMtrModel(catalog, row.mtrRegion);
  }

  const manufacturer = normalize(row.manufacturer);
  const os = normalize(row.os);
  const modelText = normalize(row.model);
  const isApplePhone = modelText.includes('iphone') ||
    (manufacturer.includes('apple') && (os.includes('ios') || os.includes('ipados') || !os));

  if (isApplePhone) {
    return resolveAppleIphone(catalog, row.model);
  }

  if (manufacturer.includes('google') || modelText.includes('pixel')) {
    return resolveGooglePixel(catalog, row.model);
  }

  if (manufacturer.includes('xiaomi') || modelText.includes('redmi') || modelText.includes('poco')) {
    return resolveXiaomi(catalog, row.model);
  }

  if (manufacturer.includes('samsung') || (os.includes('android') && modelText.includes('galaxy'))) {
    return resolveSamsung(catalog, row.model);
  }

  if (os.includes('android')) {
    return resolveSamsung(catalog, row.model);
  }

  if (manufacturer.includes('lenovo') || modelText.includes('thinkpad')) {
    const mtmMatch = resolveLenovoMtm(catalog, row.model);
    if (mtmMatch.model) return mtmMatch;
    if (looksLikeLenovoMtm(row.model)) {
      return { model: null, match: 'none', warnings: [`MTM Lenovo necunoscut: ${row.model || '-'}.`] };
    }
    return findBestByBrand(catalog, 'Lenovo', row.model);
  }

  return { model: null, match: 'none', warnings: [`Nu am gasit model automat pentru ${row.manufacturer || '-'} ${row.model || '-'}.`] };
}

function resolveAppleIphone(catalog, rawModel) {
  const parsed = parseIphoneIntuneModel(rawModel);
  if (parsed) {
    const model = findCatalogModel(catalog, 'Apple iPhone', parsed)
      || findPhoneModelByName(catalog, parsed);
    if (model) return result(model, 'auto');
  }
  const brand = findAppleIphoneBrand(catalog);
  if (brand) return findBestByBrandId(catalog, brand.id, rawModel);
  return findBestByBrand(catalog, 'Apple iPhone', rawModel);
}

function resolveGooglePixel(catalog, rawModel) {
  const parsed = parsePixelModel(rawModel);
  if (parsed) {
    const model = findCatalogModel(catalog, 'Google', parsed);
    if (model) return result(model, 'auto');
  }
  return findBestByBrand(catalog, 'Google', rawModel);
}

function resolveXiaomi(catalog, rawModel) {
  const code = String(rawModel ?? '').trim();
  if (code) {
    const exact = findCatalogModel(catalog, 'Xiaomi', { name: code, generation: 'Standard' });
    if (exact) return result(exact, 'auto');
  }
  const generic = findCatalogModel(catalog, 'Xiaomi', { name: 'Xiaomi', generation: 'Standard' });
  if (generic) return result(generic, 'auto');
  return { model: null, match: 'none', warnings: [`Nu am gasit model automat pentru Xiaomi ${rawModel || '-'}.`] };
}

function resolveSamsung(catalog, rawModel) {
  const text = normalize(rawModel);
  if (text.includes('galaxy s24')) {
    return findByBrandAndName(catalog, 'Samsung', 'Galaxy S24');
  }
  const generic = findCatalogModel(catalog, 'Samsung', { name: 'Samsung', generation: 'Standard' });
  if (generic) return result(generic, 'auto');
  return findByBrandAndName(catalog, 'Samsung', 'Galaxy S24');
}

export function parseIphoneIntuneModel(rawModel) {
  const text = normalize(rawModel);
  if (!text.includes('iphone')) return null;

  const identifierMatch = text.match(/iphone\s*(\d+)\s*[, ]?\s*(\d+)/);
  if (identifierMatch) {
    const mapped = iphoneIdentifierMap.get(`iphone${identifierMatch[1]} ${identifierMatch[2]}`);
    if (mapped) return mapped;
  }

  if (text.includes('iphone se')) {
    if (text.includes('2nd') || text.includes('second')) return { name: 'iPhone SE', generation: '2nd gen' };
    if (text.includes('3rd') || text.includes('third')) return { name: 'iPhone SE', generation: '3rd gen' };
    return { name: 'iPhone SE', generation: 'Standard' };
  }

  const proMax = text.match(/iphone\s*(\d{2})\s*pro\s*max/);
  if (proMax) return { name: `iPhone ${proMax[1]} Pro Max`, generation: 'Pro Max' };

  const pro = text.match(/iphone\s*(\d{2})\s*pro/);
  if (pro) return { name: `iPhone ${pro[1]} Pro`, generation: 'Pro' };

  if (text.includes('iphone 16e') || text.match(/iphone\s*16\s*e/)) {
    return { name: 'iPhone 16e', generation: 'Standard' };
  }

  const plain = text.match(/iphone\s*(\d{2})/);
  if (plain) return { name: `iPhone ${plain[1]}`, generation: 'Standard' };

  return null;
}

function parsePixelModel(rawModel) {
  const text = normalize(rawModel);
  if (!text.includes('pixel')) return null;

  const proMax = text.match(/pixel\s*(\d+)\s*pro\s*xl/);
  if (proMax) return { name: `Pixel ${proMax[1]} Pro XL`, generation: 'Standard' };

  const pro = text.match(/pixel\s*(\d+)\s*pro/);
  if (pro) return { name: `Pixel ${pro[1]} Pro`, generation: 'Standard' };

  const plain = text.match(/pixel\s*(\d+)/);
  if (plain) return { name: `Pixel ${plain[1]}`, generation: 'Standard' };

  return null;
}

export function resolveLenovoMtmByCode(catalog, mtmCode) {
  return resolveLenovoMtm(catalog, mtmCode);
}

function resolveLenovoMtm(catalog, modelValue) {
  const mapped = resolveLenovoMtmPrefix(modelValue);
  if (!mapped) return { model: null, match: 'none', warnings: [] };
  const found = catalog.models.find((model) => {
    const brand = catalog.brands.find((item) => item.id === model.brandId);
    return normalize(brand?.name) === 'lenovo' &&
      normalize(model.name) === normalize(mapped.name) &&
      model.generation === mapped.generation;
  });
  return result(found, 'auto');
}

function resolveJamfModel(catalog, row) {
  const model = normalize(row.model);
  const identifier = normalize(row.modelIdentifier);
  const combined = `${model} ${identifier}`;
  const brandModels = catalog.models.filter((item) => {
    const brand = catalog.brands.find((brandItem) => brandItem.id === item.brandId);
    return normalize(brand?.name).includes('macbook');
  });

  const chipGenerations = appleSiliconGenerations(combined);

  if (combined.includes('air')) {
    const found = findMacBookByGeneration(brandModels, 'air', chipGenerations);
    if (found) return result(found, 'auto');
  }

  if (combined.includes('pro')) {
    const size = /\b16\b/.test(combined) ? '16' : /\b14\b/.test(combined) ? '14' : '';
    if (size) {
      const sized = brandModels.filter((item) => normalize(item.name).includes(`pro ${size}`));
      const found = findMacBookByGeneration(sized, '', chipGenerations);
      if (found) return result(found, 'auto');
    }
    const found = findMacBookByGeneration(
      brandModels.filter((item) => normalize(item.name).includes('pro')),
      '',
      chipGenerations
    );
    if (found) return result(found, 'auto');
  }

  return findBestByBrand(catalog, 'Apple MacBook', row.model);
}

function appleSiliconGenerations(text) {
  const match = String(text ?? '').match(/\bm\s*([1-9])\s*(pro|max|ultra)?\b/i);
  if (!match) return ['M4', 'M3'];
  const family = `M${match[1]}`;
  const suffix = match[2] ? ` ${match[2][0].toUpperCase()}${match[2].slice(1).toLowerCase()}` : '';
  const exact = `${family}${suffix}`.trim();
  return exact === family ? [family] : [exact, family];
}

function findMacBookByGeneration(models, nameToken, generations) {
  const pool = nameToken
    ? models.filter((item) => normalize(item.name).includes(nameToken))
    : models;
  for (const generation of generations) {
    const found = pool.find((item) => normalize(item.generation) === normalize(generation));
    if (found) return found;
  }
  return null;
}

function findAppleIphoneBrand(catalog) {
  return catalog.brands.find((brand) => normalize(brand.name) === 'apple iphone')
    || catalog.brands.find((brand) => normalize(brand.name) === 'apple')
    || catalog.brands.find((brand) => normalize(brand.name).includes('iphone'));
}

function findPhoneModelByName(catalog, { name, generation }) {
  const nameNorm = normalize(name);
  const generationNorm = normalize(generation);
  const candidates = catalog.models.filter((model) =>
    model.deviceType === 'Telefon' && normalize(model.name) === nameNorm
  );
  if (!candidates.length) return null;

  const exactGeneration = candidates.find((model) => normalize(model.generation) === generationNorm);
  if (exactGeneration) return exactGeneration;

  const standard = candidates.find((model) => normalize(model.generation) === 'standard');
  if (standard) return standard;

  return candidates.length === 1 ? candidates[0] : null;
}

function findCatalogModel(catalog, brandName, { name, generation }) {
  const brandNorm = normalize(brandName);
  const nameNorm = normalize(name);
  const generationNorm = normalize(generation);

  const candidates = catalog.models.filter((model) => {
    const brand = catalog.brands.find((item) => item.id === model.brandId);
    return normalize(brand?.name) === brandNorm && normalize(model.name) === nameNorm;
  });
  if (!candidates.length) return null;

  return pickGenerationMatch(candidates, generationNorm);
}

function pickGenerationMatch(candidates, generationNorm) {
  const exactGeneration = candidates.find((model) => normalize(model.generation) === generationNorm);
  if (exactGeneration) return exactGeneration;

  const standard = candidates.find((model) => normalize(model.generation) === 'standard');
  if (standard) return standard;

  return candidates.length === 1 ? candidates[0] : null;
}

function findBestByBrandId(catalog, brandId, text) {
  const candidates = catalog.models.filter((model) => model.brandId === brandId);
  return rankBrandCandidates(candidates, text);
}

function findBestByBrand(catalog, brandName, text) {
  const brand = catalog.brands.find((item) => normalize(item.name) === normalize(brandName))
    || (normalize(brandName).includes('iphone') ? findAppleIphoneBrand(catalog) : null);
  if (!brand) return { model: null, match: 'none', warnings: [`Nu am gasit model automat pentru ${text || brandName}.`] };
  return rankBrandCandidates(catalog.models.filter((model) => model.brandId === brand.id), text);
}

function rankBrandCandidates(candidates, text) {
  const normalizedText = normalize(text);
  const scored = candidates
    .map((model) => ({ model, score: scoreModel(model, normalizedText) }))
    .sort((a, b) => b.score - a.score);
  if (scored[0]?.score >= 3) return result(scored[0].model, 'auto');
  if (scored[0]?.score > 0) return result(scored[0].model, 'fuzzy');
  return { model: null, match: 'none', warnings: [`Nu am gasit model automat pentru ${text || 'model'}.`] };
}

function findByBrandAndName(catalog, brandName, modelName) {
  const found = catalog.models.find((model) => {
    const brand = catalog.brands.find((item) => item.id === model.brandId);
    return normalize(brand?.name) === normalize(brandName) && normalize(model.name) === normalize(modelName);
  });
  return result(found, 'auto');
}

function scoreModel(model, text) {
  const name = normalize(model.name);
  const generation = normalize(model.generation);
  let score = 0;

  if (name && text.includes(name)) score += 4;

  for (const token of name.split(' ')) {
    if (token && token.length >= 3 && text.includes(token)) score += 1;
  }
  const version = name.match(/iphone\s*(\d{2})/)?.[1] || name.match(/pixel\s*(\d+)/)?.[1];
  if (version && text.includes(version)) score += 3;
  if (generation && generation.length >= 4 && text.includes(generation)) score += 2;
  return score;
}

function looksLikeLenovoMtm(value) {
  const compact = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return compact.length >= 7 && /^[0-9]{2}[A-Z0-9]{2}/.test(compact);
}

function resolveMtrModel(catalog, region) {
  const categoryName = region === 'BG' ? 'MTR BG' : 'MTR RO';
  const brand = catalog.brands.find((item) => normalize(item.name) === normalize(categoryName));
  const model = catalog.models.find((item) =>
    item.brandId === brand?.id &&
    normalize(item.name).includes('teams room')
  ) || catalog.models.find((item) => item.brandId === brand?.id);
  if (model) return result(model, 'auto');
  return {
    model: null,
    match: 'none',
    warnings: [`Categorie ${categoryName} lipsa din catalog. Ruleaza seed / restart.`]
  };
}

export { resolveMtrModel };

function result(model, match) {
  return model
    ? { model, match, warnings: [] }
    : { model: null, match: 'none', warnings: ['Modelul necesita selectie manuala.'] };
}

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
