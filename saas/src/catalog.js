import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedPath = join(__dirname, '..', '..', 'seed', 'models.json');

// The seed file never changes at runtime, so it is parsed once per process and
// then copied into whichever organization asks for a catalog first.
let seedPromise = null;

function loadSeed() {
  seedPromise ??= readFile(seedPath, 'utf8').then((content) => JSON.parse(content));
  return seedPromise;
}

/**
 * Catalogs are per organization and seeded on first access rather than at
 * registration: a tenant that never opens the device catalogue never pays for
 * the rows, and an organization created before this feature still gets one.
 */
export async function ensureCatalogSeeded(db, organizationId) {
  const existing = await db.get(
    'SELECT 1 AS present FROM catalog_categories WHERE organization_id = ? LIMIT 1',
    [organizationId]
  );
  if (existing) return false;

  const seed = await loadSeed();
  await db.transaction(async (tx) => {
    for (const category of seed.categories || []) {
      const categoryId = randomUUID();
      await tx.run(`
        INSERT INTO catalog_categories (id, organization_id, key, name)
        VALUES (?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `, [categoryId, organizationId, catalogKey(category.name), clean(category.name)]);

      for (const brand of category.brands || []) {
        const brandId = randomUUID();
        await tx.run(`
          INSERT INTO catalog_brands (id, organization_id, category_id, key, name)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING
        `, [brandId, organizationId, categoryId, catalogKey(brand.name), clean(brand.name)]);

        for (const model of brand.models || []) {
          // Keep the seed's base name + generation separate so the shared
          // model-resolver can match Intune/Jamf rows the same way the offline
          // app does. Display labels are composed at the edge.
          const name = clean(model.name);
          await tx.run(`
            INSERT INTO catalog_models (id, organization_id, brand_id, key, name, aliases_json)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING
          `, [
            randomUUID(),
            organizationId,
            brandId,
            catalogKey(`${name} ${clean(model.generation)}`.trim()),
            name,
            JSON.stringify(modelMeta(model))
          ]);
        }
      }
    }
  });
  return true;
}

export async function listCatalog(db, organizationId) {
  await ensureCatalogSeeded(db, organizationId);
  const [categories, brands, models] = await Promise.all([
    db.all(`
      SELECT id, key, name FROM catalog_categories
      WHERE organization_id = ?
      ORDER BY LOWER(name)
    `, [organizationId]),
    db.all(`
      SELECT id, category_id AS "categoryId", key, name FROM catalog_brands
      WHERE organization_id = ?
      ORDER BY LOWER(name)
    `, [organizationId]),
    db.all(`
      SELECT m.id, m.brand_id AS "brandId", b.category_id AS "categoryId", m.key, m.name,
             m.aliases_json AS "aliasesJson"
      FROM catalog_models m
      JOIN catalog_brands b ON b.id = m.brand_id AND b.organization_id = m.organization_id
      WHERE m.organization_id = ?
      ORDER BY LOWER(m.name)
    `, [organizationId])
  ]);
  return {
    categories,
    brands,
    models: models.map((model) => decorateModel(model))
  };
}

/**
 * Shape the SaaS catalogue for `src/import/model-resolver.js`, which expects
 * the offline fields `generation` and `deviceType` on every model.
 */
export function asResolverCatalog(catalog) {
  return {
    categories: catalog.categories,
    brands: catalog.brands,
    models: catalog.models.map((model) => ({
      id: model.id,
      brandId: model.brandId,
      name: model.name,
      generation: model.generation || 'Standard',
      deviceType: model.deviceType || '',
      aliases: model.aliases || []
    }))
  };
}

export function modelLabel(model, brands = []) {
  if (!model) return '';
  const brand = brands.find((item) => item.id === model.brandId);
  const generation = clean(model.generation);
  const suffix = generation && generation !== 'Standard' ? ` ${generation}` : '';
  return `${clean(brand?.name)} ${clean(model.name)}${suffix}`.trim();
}

export async function getCatalogModel(db, organizationId, modelId) {
  const row = await db.get(`
    SELECT m.id, m.brand_id AS "brandId", m.key, m.name, m.aliases_json AS "aliasesJson",
           b.name AS "brandName", b.category_id AS "categoryId",
           c.name AS "categoryName"
    FROM catalog_models m
    JOIN catalog_brands b ON b.id = m.brand_id AND b.organization_id = m.organization_id
    JOIN catalog_categories c ON c.id = b.category_id AND c.organization_id = m.organization_id
    WHERE m.id = ? AND m.organization_id = ?
  `, [modelId, organizationId]);
  if (!row) return null;
  const decorated = decorateModel(row);
  return {
    ...decorated,
    brandName: row.brandName,
    categoryName: row.categoryName,
    label: `${clean(row.brandName)} ${decorated.name}${
      decorated.generation && decorated.generation !== 'Standard' ? ` ${decorated.generation}` : ''
    }`.trim()
  };
}

/**
 * Accepts either an existing brandId or the brand/category names to create on
 * the fly, mirroring the offline app's dynamic catalogue growth during import.
 */
export async function createCatalogModel(db, organizationId, input) {
  await ensureCatalogSeeded(db, organizationId);
  const name = clean(input.name);
  if (!name) throw badRequest('Model name is required');

  let brand = null;
  const brandId = clean(input.brandId);
  if (brandId) {
    brand = await db.get(
      'SELECT id, category_id AS "categoryId" FROM catalog_brands WHERE id = ? AND organization_id = ?',
      [brandId, organizationId]
    );
    if (!brand) throw badRequest('Brand does not belong to this organization');
  } else {
    const brandName = clean(input.brand);
    const categoryName = clean(input.category) || 'Other';
    if (!brandName) throw badRequest('brandId or brand name is required');
    const categoryId = await upsertCategory(db, organizationId, categoryName);
    brand = { id: await upsertBrand(db, organizationId, categoryId, brandName), categoryId };
  }

  const aliases = Array.isArray(input.aliases)
    ? [...new Set(input.aliases.map(clean).filter(Boolean))]
    : [];
  const generation = clean(input.generation) || 'Standard';
  const deviceType = clean(input.deviceType);
  const key = catalogKey(`${name} ${generation}`);
  const existing = await db.get(
    'SELECT id FROM catalog_models WHERE organization_id = ? AND brand_id = ? AND key = ?',
    [organizationId, brand.id, key]
  );
  const meta = {
    generation,
    deviceType,
    aliases
  };
  if (existing) {
    await db.run('UPDATE catalog_models SET aliases_json = ? WHERE id = ?', [
      JSON.stringify(meta),
      existing.id
    ]);
    return getCatalogModel(db, organizationId, existing.id);
  }

  const id = randomUUID();
  await db.run(`
    INSERT INTO catalog_models (id, organization_id, brand_id, key, name, aliases_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [id, organizationId, brand.id, catalogKey(`${name} ${generation}`), name, JSON.stringify(meta)]);
  return getCatalogModel(db, organizationId, id);
}

async function upsertCategory(db, organizationId, name) {
  const key = catalogKey(name);
  const existing = await db.get(
    'SELECT id FROM catalog_categories WHERE organization_id = ? AND key = ?',
    [organizationId, key]
  );
  if (existing) return existing.id;
  const id = randomUUID();
  await db.run(
    'INSERT INTO catalog_categories (id, organization_id, key, name) VALUES (?, ?, ?, ?)',
    [id, organizationId, key, name]
  );
  return id;
}

async function upsertBrand(db, organizationId, categoryId, name) {
  const key = catalogKey(name);
  const existing = await db.get(
    'SELECT id FROM catalog_brands WHERE organization_id = ? AND category_id = ? AND key = ?',
    [organizationId, categoryId, key]
  );
  if (existing) return existing.id;
  const id = randomUUID();
  await db.run(
    'INSERT INTO catalog_brands (id, organization_id, category_id, key, name) VALUES (?, ?, ?, ?, ?)',
    [id, organizationId, categoryId, key, name]
  );
  return id;
}

export function catalogKey(value) {
  return clean(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function modelMeta(model) {
  return {
    generation: clean(model.generation) || 'Standard',
    deviceType: clean(model.deviceType),
    aliases: [...new Set([clean(model.name), clean(model.deviceType)].filter(Boolean))]
  };
}

function decorateModel(model) {
  const meta = parseModelMeta(model.aliasesJson);
  const split = splitFlattenedName(model.name, meta.generation);
  return {
    id: model.id,
    brandId: model.brandId,
    categoryId: model.categoryId,
    key: model.key,
    name: split.name,
    generation: split.generation,
    deviceType: meta.deviceType || '',
    aliases: meta.aliases
  };
}

function parseModelMeta(raw) {
  if (Array.isArray(raw)) {
    return {
      generation: 'Standard',
      deviceType: raw.find((item) => /^(laptop|telefon|phone|mtr)/i.test(String(item))) || '',
      aliases: raw.map(clean).filter(Boolean)
    };
  }
  try {
    const parsed = JSON.parse(raw || '{}');
    if (Array.isArray(parsed)) {
      return parseModelMeta(parsed);
    }
    return {
      generation: clean(parsed.generation) || 'Standard',
      deviceType: clean(parsed.deviceType),
      aliases: Array.isArray(parsed.aliases) ? parsed.aliases.map(clean).filter(Boolean) : []
    };
  } catch {
    return { generation: 'Standard', deviceType: '', aliases: [] };
  }
}

function splitFlattenedName(name, fallbackGeneration = 'Standard') {
  const text = clean(name);
  const match = text.match(/^(.*?)(?:\s+(Gen\s+\d+|M\d(?:\s+(?:Pro|Max|Ultra))?|\d+(?:st|nd|rd|th)\s+gen|Pro Max|Pro|Plus|Standard))$/i);
  if (match) {
    return { name: clean(match[1]), generation: clean(match[2]) || fallbackGeneration };
  }
  return { name: text, generation: clean(fallbackGeneration) || 'Standard' };
}

function clean(value) {
  return String(value ?? '').trim();
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}
