import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedPath = join(__dirname, '..', 'seed', 'catalog-default.json');

let seedPromise = null;

function loadSeed() {
  seedPromise ??= readFile(seedPath, 'utf8').then((content) => JSON.parse(content));
  return seedPromise;
}

function skipSeedCategory(name) {
  const text = clean(name);
  return text === 'MTR RO' || text === 'MTR BG';
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
    let categoryOrder = 0;
    for (const category of seed.categories || []) {
      if (skipSeedCategory(category.name)) continue;
      const categoryId = await upsertSeedCategory(tx, organizationId, category.name, categoryOrder);
      categoryOrder += 1;

      let brandOrder = 0;
      for (const brand of category.brands || []) {
        const brandId = await upsertSeedBrand(tx, organizationId, categoryId, brand.name, brandOrder);
        brandOrder += 1;

        let modelOrder = 0;
        for (const model of brand.models || []) {
          const name = clean(model.name);
          const generation = clean(model.generation) || 'Standard';
          await upsertSeedModel(tx, organizationId, brandId, name, generation, modelMeta(model), modelOrder);
          modelOrder += 1;
        }
      }
    }
  });
  return true;
}

export async function listCatalog(db, organizationId, { includeArchived = false } = {}) {
  await ensureCatalogSeeded(db, organizationId);
  const archiveFilter = includeArchived ? '' : 'AND archived_at IS NULL';
  const [categories, brands, models] = await Promise.all([
    db.all(`
      SELECT id, key, name, sort_order AS "sortOrder", archived_at AS "archivedAt"
      FROM catalog_categories
      WHERE organization_id = ? ${archiveFilter}
      ORDER BY sort_order, LOWER(name)
    `, [organizationId]),
    db.all(`
      SELECT id, category_id AS "categoryId", key, name, sort_order AS "sortOrder", archived_at AS "archivedAt"
      FROM catalog_brands
      WHERE organization_id = ? ${archiveFilter}
      ORDER BY sort_order, LOWER(name)
    `, [organizationId]),
    db.all(`
      SELECT m.id, m.brand_id AS "brandId", b.category_id AS "categoryId", m.key, m.name,
             m.aliases_json AS "aliasesJson", m.sort_order AS "sortOrder", m.archived_at AS "archivedAt"
      FROM catalog_models m
      JOIN catalog_brands b ON b.id = m.brand_id AND b.organization_id = m.organization_id
      WHERE m.organization_id = ? ${archiveFilter.replace(/archived_at/g, 'm.archived_at')}
      ORDER BY m.sort_order, LOWER(m.name)
    `, [organizationId])
  ]);
  return {
    categories,
    brands,
    models: models.map((model) => decorateModel(model))
  };
}

export async function createCategory(db, organizationId, input) {
  await ensureCatalogSeeded(db, organizationId);
  const name = clean(input.name);
  if (!name) throw badRequest('Category name is required');
  const key = catalogKey(name);
  const duplicate = await db.get(
    'SELECT id FROM catalog_categories WHERE organization_id = ? AND key = ? AND archived_at IS NULL',
    [organizationId, key]
  );
  if (duplicate) throw badRequest('Category already exists');

  const sortOrder = Number.isFinite(input.sortOrder) ? input.sortOrder : await nextSortOrder(
    db,
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM catalog_categories WHERE organization_id = ?',
    [organizationId]
  );
  const id = randomUUID();
  await db.run(`
    INSERT INTO catalog_categories (id, organization_id, key, name, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `, [id, organizationId, key, name, sortOrder]);
  return getCategory(db, organizationId, id);
}

export async function updateCategory(db, organizationId, categoryId, input) {
  const existing = await getCategory(db, organizationId, categoryId);
  if (!existing) throw notFound('Category not found');

  const name = input.name === undefined ? existing.name : clean(input.name);
  if (!name) throw badRequest('Category name is required');
  const key = catalogKey(name);
  const duplicate = await db.get(
    `SELECT id FROM catalog_categories
     WHERE organization_id = ? AND key = ? AND id <> ? AND archived_at IS NULL`,
    [organizationId, key, categoryId]
  );
  if (duplicate) throw badRequest('Another category already uses that name');

  const sortOrder = input.sortOrder === undefined ? existing.sortOrder : input.sortOrder;
  await db.run(`
    UPDATE catalog_categories
    SET name = ?, key = ?, sort_order = ?
    WHERE id = ? AND organization_id = ?
  `, [name, key, sortOrder, categoryId, organizationId]);
  return getCategory(db, organizationId, categoryId);
}

export async function deleteCategory(db, organizationId, categoryId) {
  const existing = await getCategory(db, organizationId, categoryId);
  if (!existing) throw notFound('Category not found');

  const brandCount = await db.get(
    'SELECT COUNT(*) AS count FROM catalog_brands WHERE organization_id = ? AND category_id = ? AND archived_at IS NULL',
    [organizationId, categoryId]
  );
  const assetCount = await db.get(`
    SELECT COUNT(*) AS count
    FROM assets a
    JOIN catalog_models m ON m.id = a.model_id AND m.organization_id = a.organization_id
    JOIN catalog_brands b ON b.id = m.brand_id AND b.organization_id = m.organization_id
    WHERE b.category_id = ? AND a.organization_id = ?
  `, [categoryId, organizationId]);

  if ((brandCount?.count || 0) > 0 || (assetCount?.count || 0) > 0) {
    const archivedAt = nowIso();
    await db.run(
      'UPDATE catalog_categories SET archived_at = ? WHERE id = ? AND organization_id = ?',
      [archivedAt, categoryId, organizationId]
    );
    return { archived: true, id: categoryId };
  }

  await db.run('DELETE FROM catalog_categories WHERE id = ? AND organization_id = ?', [categoryId, organizationId]);
  return { deleted: true, id: categoryId };
}

export async function createBrand(db, organizationId, input) {
  await ensureCatalogSeeded(db, organizationId);
  const name = clean(input.name);
  const categoryId = clean(input.categoryId);
  if (!name) throw badRequest('Brand name is required');
  if (!categoryId) throw badRequest('categoryId is required');

  const category = await getCategory(db, organizationId, categoryId);
  if (!category || category.archivedAt) throw badRequest('Category does not belong to this organization');

  const key = catalogKey(name);
  const duplicate = await db.get(
    `SELECT id FROM catalog_brands
     WHERE organization_id = ? AND category_id = ? AND key = ? AND archived_at IS NULL`,
    [organizationId, categoryId, key]
  );
  if (duplicate) throw badRequest('Brand already exists in this category');

  const sortOrder = Number.isFinite(input.sortOrder) ? input.sortOrder : await nextSortOrder(
    db,
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM catalog_brands WHERE organization_id = ? AND category_id = ?',
    [organizationId, categoryId]
  );
  const id = randomUUID();
  await db.run(`
    INSERT INTO catalog_brands (id, organization_id, category_id, key, name, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [id, organizationId, categoryId, key, name, sortOrder]);
  return getBrand(db, organizationId, id);
}

export async function updateBrand(db, organizationId, brandId, input) {
  const existing = await getBrand(db, organizationId, brandId);
  if (!existing) throw notFound('Brand not found');

  const name = input.name === undefined ? existing.name : clean(input.name);
  if (!name) throw badRequest('Brand name is required');
  const categoryId = input.categoryId === undefined ? existing.categoryId : clean(input.categoryId);
  const category = await getCategory(db, organizationId, categoryId);
  if (!category || category.archivedAt) throw badRequest('Category does not belong to this organization');

  const key = catalogKey(name);
  const duplicate = await db.get(
    `SELECT id FROM catalog_brands
     WHERE organization_id = ? AND category_id = ? AND key = ? AND id <> ? AND archived_at IS NULL`,
    [organizationId, categoryId, key, brandId]
  );
  if (duplicate) throw badRequest('Another brand already uses that name in this category');

  const sortOrder = input.sortOrder === undefined ? existing.sortOrder : input.sortOrder;
  await db.run(`
    UPDATE catalog_brands
    SET name = ?, key = ?, category_id = ?, sort_order = ?
    WHERE id = ? AND organization_id = ?
  `, [name, key, categoryId, sortOrder, brandId, organizationId]);
  return getBrand(db, organizationId, brandId);
}

export async function deleteBrand(db, organizationId, brandId) {
  const existing = await getBrand(db, organizationId, brandId);
  if (!existing) throw notFound('Brand not found');

  const modelCount = await db.get(
    'SELECT COUNT(*) AS count FROM catalog_models WHERE organization_id = ? AND brand_id = ? AND archived_at IS NULL',
    [organizationId, brandId]
  );
  const assetCount = await db.get(
    'SELECT COUNT(*) AS count FROM assets WHERE organization_id = ? AND model_id IN (SELECT id FROM catalog_models WHERE brand_id = ?)',
    [organizationId, brandId]
  );

  if ((modelCount?.count || 0) > 0 || (assetCount?.count || 0) > 0) {
    const archivedAt = nowIso();
    await db.run(
      'UPDATE catalog_brands SET archived_at = ? WHERE id = ? AND organization_id = ?',
      [archivedAt, brandId, organizationId]
    );
    return { archived: true, id: brandId };
  }

  await db.run('DELETE FROM catalog_brands WHERE id = ? AND organization_id = ?', [brandId, organizationId]);
  return { deleted: true, id: brandId };
}

export async function updateModel(db, organizationId, modelId, input) {
  const existing = await getCatalogModel(db, organizationId, modelId);
  if (!existing) throw notFound('Model not found');

  const name = input.name === undefined ? existing.name : clean(input.name);
  if (!name) throw badRequest('Model name is required');
  const generation = input.generation === undefined ? existing.generation : (clean(input.generation) || 'Standard');
  const deviceType = input.deviceType === undefined ? existing.deviceType : clean(input.deviceType);
  const aliases = input.aliases === undefined
    ? existing.aliases
    : [...new Set((Array.isArray(input.aliases) ? input.aliases : []).map(clean).filter(Boolean))];
  const sortOrder = input.sortOrder === undefined ? existing.sortOrder : input.sortOrder;
  const key = catalogKey(`${name} ${generation}`);

  const duplicate = await db.get(
    `SELECT id FROM catalog_models
     WHERE organization_id = ? AND brand_id = ? AND key = ? AND id <> ? AND archived_at IS NULL`,
    [organizationId, existing.brandId, key, modelId]
  );
  if (duplicate) throw badRequest('Another model already uses that name and generation');

  await db.run(`
    UPDATE catalog_models
    SET name = ?, key = ?, aliases_json = ?, sort_order = ?
    WHERE id = ? AND organization_id = ?
  `, [
    name,
    key,
    JSON.stringify({ generation, deviceType, aliases }),
    sortOrder,
    modelId,
    organizationId
  ]);
  return getCatalogModel(db, organizationId, modelId);
}

export async function deleteModel(db, organizationId, modelId) {
  const existing = await getCatalogModel(db, organizationId, modelId);
  if (!existing) throw notFound('Model not found');

  const assetCount = await db.get(
    'SELECT COUNT(*) AS count FROM assets WHERE organization_id = ? AND model_id = ?',
    [organizationId, modelId]
  );
  if ((assetCount?.count || 0) > 0) {
    const archivedAt = nowIso();
    await db.run(
      'UPDATE catalog_models SET archived_at = ? WHERE id = ? AND organization_id = ?',
      [archivedAt, modelId, organizationId]
    );
    return { archived: true, id: modelId };
  }

  await db.run('DELETE FROM catalog_models WHERE id = ? AND organization_id = ?', [modelId, organizationId]);
  return { deleted: true, id: modelId };
}

/**
 * Merge any seed entries missing from the tenant catalog without overwriting
 * customized rows. Keys are matched per entity type.
 */
export async function resetDefaults(db, organizationId) {
  await ensureCatalogSeeded(db, organizationId);
  const seed = await loadSeed();
  let added = { categories: 0, brands: 0, models: 0 };

  await db.transaction(async (tx) => {
    let categoryOrder = await maxSortOrder(tx, 'catalog_categories', organizationId);
    for (const category of seed.categories || []) {
      if (skipSeedCategory(category.name)) continue;
      const categoryKey = catalogKey(category.name);
      let categoryRow = await tx.get(
        'SELECT id FROM catalog_categories WHERE organization_id = ? AND key = ?',
        [organizationId, categoryKey]
      );
      if (!categoryRow) {
        const id = randomUUID();
        await tx.run(`
          INSERT INTO catalog_categories (id, organization_id, key, name, sort_order)
          VALUES (?, ?, ?, ?, ?)
        `, [id, organizationId, categoryKey, clean(category.name), categoryOrder]);
        categoryRow = { id };
        added.categories += 1;
        categoryOrder += 1;
      }

      let brandOrder = await maxSortOrder(tx, 'catalog_brands', organizationId, 'category_id = ?', [categoryRow.id]);
      for (const brand of category.brands || []) {
        const brandKey = catalogKey(brand.name);
        let brandRow = await tx.get(
          'SELECT id FROM catalog_brands WHERE organization_id = ? AND category_id = ? AND key = ?',
          [organizationId, categoryRow.id, brandKey]
        );
        if (!brandRow) {
          const id = randomUUID();
          await tx.run(`
            INSERT INTO catalog_brands (id, organization_id, category_id, key, name, sort_order)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [id, organizationId, categoryRow.id, brandKey, clean(brand.name), brandOrder]);
          brandRow = { id };
          added.brands += 1;
          brandOrder += 1;
        }

        let modelOrder = await maxSortOrder(tx, 'catalog_models', organizationId, 'brand_id = ?', [brandRow.id]);
        for (const model of brand.models || []) {
          const name = clean(model.name);
          const generation = clean(model.generation) || 'Standard';
          const key = catalogKey(`${name} ${generation}`);
          const existing = await tx.get(
            'SELECT id FROM catalog_models WHERE organization_id = ? AND brand_id = ? AND key = ?',
            [organizationId, brandRow.id, key]
          );
          if (existing) continue;
          await tx.run(`
            INSERT INTO catalog_models (id, organization_id, brand_id, key, name, aliases_json, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `, [
            randomUUID(),
            organizationId,
            brandRow.id,
            key,
            name,
            JSON.stringify(modelMeta(model)),
            modelOrder
          ]);
          added.models += 1;
          modelOrder += 1;
        }
      }
    }
  });

  return { added, catalog: await listCatalog(db, organizationId) };
}

/**
 * Generic MDM row resolver: match brand by manufacturer, then score models by
 * tokens from model name and hardware identifier.
 */
export function resolveGenericModel(catalog, { manufacturer, model, modelIdentifier }) {
  const resolverCatalog = asResolverCatalog(catalog);
  const warnings = [];
  const combined = normalizeTokens([model, modelIdentifier].filter(Boolean).join(' '));
  if (!combined) {
    return { model: null, match: 'none', warnings: ['No model text to match.'] };
  }

  const brand = findBrandByManufacturer(resolverCatalog.brands, manufacturer);
  if (!brand) {
    warnings.push(`Unknown manufacturer: ${clean(manufacturer) || '-'}.`);
    return rankGenericModels(resolverCatalog.models, combined, warnings);
  }

  const brandModels = resolverCatalog.models.filter((item) => item.brandId === brand.id);
  if (!brandModels.length) {
    warnings.push(`No models under brand ${brand.name}.`);
    return { model: null, match: 'none', warnings };
  }

  return rankGenericModels(brandModels, combined, warnings);
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
           m.sort_order AS "sortOrder", m.archived_at AS "archivedAt",
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
      'SELECT id, category_id AS "categoryId" FROM catalog_brands WHERE id = ? AND organization_id = ? AND archived_at IS NULL',
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
    'SELECT id FROM catalog_models WHERE organization_id = ? AND brand_id = ? AND key = ? AND archived_at IS NULL',
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

  const sortOrder = await nextSortOrder(
    db,
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM catalog_models WHERE organization_id = ? AND brand_id = ?',
    [organizationId, brand.id]
  );
  const id = randomUUID();
  await db.run(`
    INSERT INTO catalog_models (id, organization_id, brand_id, key, name, aliases_json, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [id, organizationId, brand.id, catalogKey(`${name} ${generation}`), name, JSON.stringify(meta), sortOrder]);
  return getCatalogModel(db, organizationId, id);
}

async function upsertCategory(db, organizationId, name) {
  const key = catalogKey(name);
  const existing = await db.get(
    'SELECT id FROM catalog_categories WHERE organization_id = ? AND key = ? AND archived_at IS NULL',
    [organizationId, key]
  );
  if (existing) return existing.id;
  const sortOrder = await nextSortOrder(
    db,
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM catalog_categories WHERE organization_id = ?',
    [organizationId]
  );
  const id = randomUUID();
  await db.run(
    'INSERT INTO catalog_categories (id, organization_id, key, name, sort_order) VALUES (?, ?, ?, ?, ?)',
    [id, organizationId, key, name, sortOrder]
  );
  return id;
}

async function upsertBrand(db, organizationId, categoryId, name) {
  const key = catalogKey(name);
  const existing = await db.get(
    'SELECT id FROM catalog_brands WHERE organization_id = ? AND category_id = ? AND key = ? AND archived_at IS NULL',
    [organizationId, categoryId, key]
  );
  if (existing) return existing.id;
  const sortOrder = await nextSortOrder(
    db,
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM catalog_brands WHERE organization_id = ? AND category_id = ?',
    [organizationId, categoryId]
  );
  const id = randomUUID();
  await db.run(
    'INSERT INTO catalog_brands (id, organization_id, category_id, key, name, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    [id, organizationId, categoryId, key, name, sortOrder]
  );
  return id;
}

async function upsertSeedCategory(tx, organizationId, name, sortOrder) {
  const key = catalogKey(name);
  const existing = await tx.get(
    'SELECT id FROM catalog_categories WHERE organization_id = ? AND key = ?',
    [organizationId, key]
  );
  if (existing) return existing.id;
  const id = randomUUID();
  await tx.run(
    'INSERT INTO catalog_categories (id, organization_id, key, name, sort_order) VALUES (?, ?, ?, ?, ?)',
    [id, organizationId, key, clean(name), sortOrder]
  );
  return id;
}

async function upsertSeedBrand(tx, organizationId, categoryId, name, sortOrder) {
  const key = catalogKey(name);
  const existing = await tx.get(
    'SELECT id FROM catalog_brands WHERE organization_id = ? AND category_id = ? AND key = ?',
    [organizationId, categoryId, key]
  );
  if (existing) return existing.id;
  const id = randomUUID();
  await tx.run(
    'INSERT INTO catalog_brands (id, organization_id, category_id, key, name, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    [id, organizationId, categoryId, key, clean(name), sortOrder]
  );
  return id;
}

async function upsertSeedModel(tx, organizationId, brandId, name, generation, meta, sortOrder) {
  const key = catalogKey(`${name} ${generation}`);
  const existing = await tx.get(
    'SELECT id FROM catalog_models WHERE organization_id = ? AND brand_id = ? AND key = ?',
    [organizationId, brandId, key]
  );
  if (existing) return existing.id;
  await tx.run(`
    INSERT INTO catalog_models (id, organization_id, brand_id, key, name, aliases_json, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [randomUUID(), organizationId, brandId, key, name, JSON.stringify(meta), sortOrder]);
}

async function getCategory(db, organizationId, categoryId) {
  return db.get(`
    SELECT id, key, name, sort_order AS "sortOrder", archived_at AS "archivedAt"
    FROM catalog_categories
    WHERE id = ? AND organization_id = ?
  `, [categoryId, organizationId]);
}

async function getBrand(db, organizationId, brandId) {
  return db.get(`
    SELECT id, category_id AS "categoryId", key, name, sort_order AS "sortOrder", archived_at AS "archivedAt"
    FROM catalog_brands
    WHERE id = ? AND organization_id = ?
  `, [brandId, organizationId]);
}

async function nextSortOrder(db, sql, params) {
  const row = await db.get(sql, params);
  return row?.next ?? 0;
}

async function maxSortOrder(tx, table, organizationId, extraWhere = '', extraParams = []) {
  const where = extraWhere ? `AND ${extraWhere}` : '';
  const row = await tx.get(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM ${table} WHERE organization_id = ? ${where}`,
    [organizationId, ...extraParams]
  );
  return row?.next ?? 0;
}

function findBrandByManufacturer(brands, manufacturer) {
  const needle = normalizeTokens(manufacturer);
  if (!needle) return null;
  return brands.find((brand) => normalizeTokens(brand.name) === needle)
    || brands.find((brand) => normalizeTokens(brand.name).includes(needle))
    || brands.find((brand) => needle.includes(normalizeTokens(brand.name)));
}

function rankGenericModels(models, text, warnings = []) {
  const scored = models
    .map((model) => ({ model, score: scoreGenericModel(model, text) }))
    .sort((a, b) => b.score - a.score);
  if (scored[0]?.score >= 3) {
    return { model: scored[0].model, match: 'auto', warnings };
  }
  if (scored[0]?.score > 0) {
    warnings.push('Model match is uncertain.');
    return { model: scored[0].model, match: 'fuzzy', warnings };
  }
  warnings.push('No catalog model matched the import row.');
  return { model: null, match: 'none', warnings };
}

function scoreGenericModel(model, text) {
  const name = normalizeTokens(model.name);
  const generation = normalizeTokens(model.generation);
  let score = 0;
  if (name && text.includes(name)) score += 4;
  for (const token of name.split(' ')) {
    if (token.length >= 3 && text.includes(token)) score += 1;
  }
  if (generation && generation !== 'standard' && text.includes(generation)) score += 2;
  for (const alias of model.aliases || []) {
    const aliasNorm = normalizeTokens(alias);
    if (aliasNorm && text.includes(aliasNorm)) score += 2;
  }
  return score;
}

function normalizeTokens(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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
    aliases: meta.aliases,
    sortOrder: model.sortOrder ?? 0,
    archivedAt: model.archivedAt || null
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

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value ?? '').trim();
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}
