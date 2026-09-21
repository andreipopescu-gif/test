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
          const name = modelDisplayName(model.name, model.generation);
          await tx.run(`
            INSERT INTO catalog_models (id, organization_id, brand_id, key, name, aliases_json)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING
          `, [
            randomUUID(),
            organizationId,
            brandId,
            catalogKey(name),
            name,
            JSON.stringify(modelAliases(model))
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
    models: models.map((model) => ({
      id: model.id,
      brandId: model.brandId,
      categoryId: model.categoryId,
      key: model.key,
      name: model.name,
      aliases: parseAliases(model.aliasesJson)
    }))
  };
}

export async function getCatalogModel(db, organizationId, modelId) {
  const row = await db.get(`
    SELECT m.id, m.brand_id AS "brandId", m.name, m.aliases_json AS "aliasesJson",
           b.name AS "brandName", c.id AS "categoryId", c.name AS "categoryName"
    FROM catalog_models m
    JOIN catalog_brands b ON b.id = m.brand_id AND b.organization_id = m.organization_id
    JOIN catalog_categories c ON c.id = b.category_id AND c.organization_id = m.organization_id
    WHERE m.id = ? AND m.organization_id = ?
  `, [modelId, organizationId]);
  if (!row) return null;
  return { ...row, aliases: parseAliases(row.aliasesJson), aliasesJson: undefined };
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

  const key = catalogKey(name);
  const existing = await db.get(
    'SELECT id FROM catalog_models WHERE organization_id = ? AND brand_id = ? AND key = ?',
    [organizationId, brand.id, key]
  );
  const aliases = Array.isArray(input.aliases)
    ? [...new Set(input.aliases.map(clean).filter(Boolean))]
    : [];
  if (existing) {
    if (aliases.length) {
      await db.run('UPDATE catalog_models SET aliases_json = ? WHERE id = ?', [
        JSON.stringify(aliases),
        existing.id
      ]);
    }
    return getCatalogModel(db, organizationId, existing.id);
  }

  const id = randomUUID();
  await db.run(`
    INSERT INTO catalog_models (id, organization_id, brand_id, key, name, aliases_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [id, organizationId, brand.id, key, name, JSON.stringify(aliases)]);
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

function modelDisplayName(name, generation) {
  const base = clean(name);
  const gen = clean(generation);
  if (!gen || gen === 'Standard' || base.toLowerCase().includes(gen.toLowerCase())) return base;
  return `${base} ${gen}`;
}

function modelAliases(model) {
  return [...new Set([clean(model.name), clean(model.deviceType)].filter(Boolean))];
}

function parseAliases(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function clean(value) {
  return String(value ?? '').trim();
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}
