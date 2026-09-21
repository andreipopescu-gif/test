/**
 * Invoice-driven import: preview + apply.
 *
 * Preview flow:
 *   1. Extract text lines from PDF buffer.
 *   2. Parse serial/model rows via vendor template.
 *   3. Resolve each row against the catalog (fuzzy match).
 *   4. Return a preview with per-row decisions (create / skip / needsReview).
 *
 * Apply flow:
 *   1. Validate no unresolved rows remain.
 *   2. Optionally create new catalog models requested by the user.
 *   3. Create assets with status in_stock.
 *   4. Attach a single invoice record (linked to all created assets) per PDF.
 */

import { extractLinesFromPdf } from './invoice-pdf-parser.js';
import { mergeInvoiceFields, extractInvoiceMetaFromPdf } from './invoice-meta-parser.js';
import { parseInvoiceLines, TEMPLATES } from './invoice-template-parsers.js';
import { resolveLenovoMtmByCode } from './model-resolver.js';
import { resolveLenovoMtmPrefix, extractLenovoMtmCode } from './lenovo-mtm-map.js';
import { normalizeImportDate } from './date-utils.js';
import {
  extractDocumentDeviceFields,
  buildDeviceDatesFromExtracted,
  resolveWarrantyFromExtracted
} from './invoice-fields-extractor.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export { TEMPLATES as invoiceTemplates };
export { extractInvoiceMetaFromPdf, mergeInvoiceFields } from './invoice-meta-parser.js';

/**
 * Build a preview from an uploaded invoice PDF.
 *
 * @param {import('../store.js').InventoryStore} store
 * @param {{ buffer: Buffer, originalName: string }} file
 * @param {{ templateId?: string, invoiceNumber?: string, invoiceDate?: string, vendor?: string, amount?: string }} fields
 * @returns {InvoicePreview}
 */
export function buildInvoicePreview(store, file, fields = {}) {
  const lines = extractLinesFromPdf(file.buffer);
  if (!lines.length) throw Object.assign(new Error('Could not extract text from PDF. The file may be scanned / image-only.'), { status: 422 });

  const templateId = fields.templateId || 'auto';
  const { templateId: detectedTemplate, rows: parsedRows } = parseInvoiceLines(lines, templateId);
  const catalog = store.listCatalog();
  const extractedMeta = extractInvoiceMetaFromPdf(file.buffer);
  const invoiceMeta = mergeInvoiceFields(fields, extractedMeta);
  const documentFields = extractDocumentDeviceFields(lines);
  const purchaseDate = documentFields.purchaseDate || invoiceMeta.invoiceDate;

  const previewRows = parsedRows.map((parsed, idx) =>
    buildPreviewRow(store, catalog, parsed, idx, {
      purchaseDate,
      documentFields
    })
  );

  return {
    fileName: file.originalName,
    templateId: detectedTemplate,
    invoiceMeta,
    extractedMeta,
    rows: previewRows,
    summary: summarize(previewRows)
  };
}

/**
 * Apply a confirmed invoice preview.
 * Creates assets + attaches invoice to each new asset.
 * New catalog models requested in `newModels` are created first.
 *
 * @param {import('../store.js').InventoryStore} store
 * @param {InvoicePreview} preview
 * @param {{ buffer: Buffer, originalName: string }} file  – original PDF buffer
 * @param {{ relativePath: string, fileName: string, size: number, mimeType: string }} savedFile  – persisted PDF info
 * @param {string} actor
 */
export async function applyInvoiceImport(store, preview, file, savedFile, actor) {
  // Validate: reject if any row still needs review
  const blocking = preview.rows.filter((r) => r.action !== 'skip' && r.needsReview);
  if (blocking.length) throw new Error('There are rows that still need model selection.');

  // Create any new catalog models first
  if (preview.newModels?.length) {
    for (const nm of preview.newModels) {
      const created = await store.createCatalogModel(nm, actor);
      // Patch rows that reference this new model by rowKey
      for (const row of preview.rows) {
        if (row.newModelRef === nm.ref) {
          row.modelId = created.id;
          row.modelLabel = `${nm.brandName} ${nm.name} ${nm.generation}`.trim();
          row.modelMatch = 'new';
          row.needsReview = false;
        }
      }
    }
  }

  const created = [];
  const skipped = [];

  for (const row of preview.rows) {
    if (row.action === 'skip' || row.needsReview) { skipped.push(row); continue; }

    const asset = await store.createAsset({
      assetTag: row.assetTag || row.serial,
      serialNumber: row.serial,
      modelId: row.modelId,
      status: 'in_stock',
      vendor: preview.invoiceMeta.vendor,
      purchaseDate: row.purchaseDate || preview.invoiceMeta.invoiceDate,
      warrantyUntil: row.warrantyUntil || ''
    }, actor);

    // Attach invoice to each newly created asset
    await store.addInvoice(asset.id, preview.invoiceMeta, savedFile, actor);

    created.push(asset);
  }

  return {
    created,
    skipped,
    summary: { created: created.length, skipped: skipped.length }
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildPreviewRow(store, catalog, parsed, idx, { purchaseDate = '', documentFields = {} } = {}) {
  const rowKey = `invoice:${idx}:${parsed.serial}`;
  const serial = parsed.serial || '';
  const artNr = (parsed.artNr || extractLenovoMtmCode(parsed.modelText) || '').trim();
  const modelText = parsed.modelText || '';
  const warranty = resolveWarrantyFromExtracted(parsed, documentFields);
  const { purchaseDate: purchase, warrantyUntil, warrantyMonths } = buildDeviceDatesFromExtracted(
    purchaseDate,
    warranty.warrantyMonths,
    warranty.warrantyUntil
  );

  // Check for duplicate serial in existing inventory
  const existing = serial ? store.findAssetBySerial(serial) : null;

  if (!serial) {
    return {
      rowKey, idx, serial, artNr, modelText, purchaseDate: purchase, warrantyUntil, warrantyMonths,
      assetTag: parsed.assetTag || '',
      qty: parsed.qty ?? 1,
      action: 'skip',
      needsReview: false,
      modelId: '',
      modelLabel: '',
      modelMatch: 'none',
      newModelRef: null,
      warnings: ['Missing serial number — row skipped.']
    };
  }

  if (existing) {
    return {
      rowKey, idx, serial, artNr, modelText, purchaseDate: purchase, warrantyUntil, warrantyMonths,
      assetTag: parsed.assetTag || serial,
      qty: parsed.qty ?? 1,
      action: 'skip',
      needsReview: false,
      modelId: existing.modelId || '',
      modelLabel: '',
      modelMatch: 'duplicate',
      newModelRef: null,
      warnings: [`Serial ${serial} already exists in inventory — skipped.`]
    };
  }

  // Fuzzy-match against catalog
  const resolution = resolveInvoiceModel(catalog, modelText, artNr);
  const needsReview = !resolution.model;

  return {
    rowKey, idx, serial, artNr, modelText, purchaseDate: purchase, warrantyUntil, warrantyMonths,
    assetTag: parsed.assetTag || serial,
    qty: parsed.qty ?? 1,
    action: needsReview ? 'needsReview' : 'create',
    needsReview,
    modelId: resolution.model?.id || '',
    modelLabel: resolution.model ? fullModelLabel(catalog, resolution.model) : '',
    modelMatch: resolution.match,
    newModelRef: null,
    warnings: resolution.warnings
  };
}

/**
 * Resolve a model from free-form invoice text.
 * Uses the same catalog scoring approach as model-resolver.js.
 */
function resolveInvoiceModel(catalog, modelText, artNr = '') {
  const lenovoMapped = artNr ? resolveLenovoMtmPrefix(artNr) : null;
  if (lenovoMapped) {
    const mtmRes = resolveLenovoMtmByCode(catalog, artNr);
    if (mtmRes.model) {
      return { model: mtmRes.model, match: 'mtm', warnings: [] };
    }
    return {
      model: null,
      match: 'none',
      warnings: [`MTM ${artNr} → ${lenovoMapped.name} ${lenovoMapped.generation} (add to catalog or select manually).`]
    };
  }

  if (!modelText) {
    return {
      model: null,
      match: 'none',
      warnings: [artNr ? `No description text; MTM ${artNr} is not in the Lenovo map.` : 'No model text found near serial.']
    };
  }

  const normalized = norm(modelText);
  const scored = catalog.models
    .map((m) => ({ m, score: scoreInvoiceModel(m, normalized) }))
    .sort((a, b) => b.score - a.score);

  if (scored[0]?.score >= 2) {
    const match = scored[0].score >= 4 ? 'auto' : 'fuzzy';
    return { model: scored[0].m, match, warnings: [] };
  }

  return { model: null, match: 'none', warnings: [`Could not match model from text: "${modelText.slice(0, 60)}"`] };
}

function scoreInvoiceModel(model, normalizedText) {
  let text = normalizedText;
  if (/\bnb\s+tp\b/.test(text)) text += ' thinkpad lenovo';
  if (/thinkvision|t27qd|monitor/i.test(text)) text += ' thinkvision monitor';
  if (/macbook/i.test(text)) {
    text += ' macbook apple';
    if (/pro\s*14|14\.2/i.test(text)) text += ' macbook pro 14';
    if (/pro\s*16|16\.2/i.test(text)) text += ' macbook pro 16';
    if (/air/i.test(text)) text += ' macbook air';
    if (/m4\s*pro/i.test(text)) text += ' m4';
    else if (/m4\b/i.test(text)) text += ' m4';
    else if (/m3\b/i.test(text)) text += ' m3';
  }
  const name = norm(model.name);
  const generation = norm(model.generation);
  let score = 0;
  for (const token of name.split(' ')) {
    if (token && token.length >= 3 && text.includes(token)) score += 1;
  }
  if (generation && generation.length >= 2 && text.includes(generation)) score += 3;
  const genNum = text.match(/\bg\s*(\d{1,2})\b/);
  if (genNum && generation && generation.includes(genNum[1])) score += 3;
  return score;
}

function fullModelLabel(catalog, model) {
  const brand = catalog.brands.find((b) => b.id === model.brandId);
  if (model.generation === 'Standard' || model.generation === 'Pro') return model.name;
  return `${brand?.name || ''} ${model.name} ${model.generation || ''}`.trim();
}

function summarize(rows) {
  const s = { total: rows.length, create: 0, skip: 0, needsReview: 0 };
  for (const r of rows) {
    if (r.needsReview) s.needsReview++;
    else if (r.action === 'skip') s.skip++;
    else s.create++;
  }
  return s;
}

function norm(v) {
  return String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** @typedef {{ fileName:string, templateId:string, invoiceMeta:object, rows:InvoicePreviewRow[], summary:object, newModels?:object[] }} InvoicePreview */
/** @typedef {{ rowKey:string, idx:number, serial:string, artNr:string, modelText:string, assetTag:string, qty:number, action:string, needsReview:boolean, modelId:string, modelLabel:string, modelMatch:string, newModelRef:string|null, warnings:string[] }} InvoicePreviewRow */
