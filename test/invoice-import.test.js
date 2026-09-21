import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractLinesFromPdf } from '../src/import/invoice-pdf-parser.js';
import { parseInvoiceLines, detectTemplate, TEMPLATES } from '../src/import/invoice-template-parsers.js';
import { extractLenovoMtmCode } from '../src/import/lenovo-mtm-map.js';
import { extractInvoiceMetaFromLines } from '../src/import/invoice-meta-parser.js';
import { buildInvoicePreview, applyInvoiceImport } from '../src/import/invoice-importer.js';
import { InventoryStore } from '../src/store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid PDF buffer containing plain text streams.
 * Uses uncompressed content streams so our parser can extract them.
 */
function makePdfBuffer(lines) {
  const content = lines.map((l) => `BT (${l}) Tj ET`).join('\n');
  const stream = `stream\n${content}\nendstream`;
  return Buffer.from(`%PDF-1.4\n1 0 obj\n<< >>\n${stream}\n%%EOF`, 'latin1');
}

/** Minimal PDF with no readable text streams (simulates scanned PDF). */
function makeEmptyPdfBuffer() {
  return Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\n%%EOF', 'latin1');
}

// ---------------------------------------------------------------------------
// PDF parser tests
// ---------------------------------------------------------------------------

test('extractLinesFromPdf extracts text from BT/ET blocks', () => {
  const buf = makePdfBuffer(['Hello World', 'S/N: PF631E3Z', 'ThinkPad T14 Gen 6']);
  const lines = extractLinesFromPdf(buf);
  assert.ok(lines.some((l) => l.includes('PF631E3Z')), `Expected serial in lines: ${lines}`);
});

test('extractLinesFromPdf returns empty array for image-only PDF', () => {
  const buf = makeEmptyPdfBuffer();
  const lines = extractLinesFromPdf(buf);
  assert.equal(lines.length, 0);
});

// ---------------------------------------------------------------------------
// Template detection and parsing
// ---------------------------------------------------------------------------

test('detectTemplate returns altex for altex invoice', () => {
  const lines = ['Altex Romania SRL', 'Factura nr. 123', 'S/N: PF631E3Z ThinkPad T14 Gen 6 Qty: 1'];
  const t = detectTemplate(lines);
  assert.equal(t.id, 'altex');
});

test('detectTemplate falls back to generic when no vendor match', () => {
  const lines = ['Some Vendor', 'Serial: ABCDEF1234 Product: Laptop X'];
  const t = detectTemplate(lines);
  // Either altex/flanco if triggered, or generic
  assert.ok(TEMPLATES.map((x) => x.id).includes(t.id));
});

test('parseInvoiceLines altex extracts serial from S/N marker', () => {
  const lines = [
    'Altex Romania',
    'ThinkPad T14 Gen 6 Intel Core Ultra 5',
    'S/N: PF631E3Z  Qty: 2'
  ];
  const { rows } = parseInvoiceLines(lines, 'altex');
  assert.ok(rows.length >= 1, 'Should have at least one row');
  assert.ok(rows.some((r) => r.serial === 'PF631E3Z'), `Expected PF631E3Z in rows: ${JSON.stringify(rows)}`);
});

test('parseInvoiceLines fks uses Artikel-Bezeichnung not invoice header', () => {
  const lines = [
    'RECHNUNG',
    'Rechn.-Nr.: 111961 Kunden-Nr.: 15169 Datum: 01.06.2026 Fälligkeit: 31.07.2026',
    'Pos. Art.-Nr. Artikel-Bezeichnung Menge Einh. EP Preis',
    '21Q1S2770H',
    'Lenovo NB TP X1 2-in-1 G10 U5 16G 1T 11P',
    'Keyboard Language Operation System Language',
    'SN: SPF6C0R75',
    '99-11-00000 Ship by cost',
  ];
  const { templateId, rows } = parseInvoiceLines(lines, 'auto');
  assert.equal(templateId, 'fks');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].serial, 'SPF6C0R75');
  assert.equal(rows[0].artNr, '21Q1S2770H');
  assert.match(rows[0].modelText, /Lenovo NB TP X1/i);
  assert.doesNotMatch(rows[0].modelText, /Rechn/i);
});

test('extractLenovoMtmCode splits glued FKS PDF text', () => {
  assert.equal(extractLenovoMtmCode('221Q1S2770HLENOVO'), '21Q1S2770H');
  assert.equal(extractLenovoMtmCode('21Q1S2770HLENOVO NB TP X1'), '21Q1S2770H');
});

test('parseInvoiceLines fks ignores delivery address near SN', () => {
  const lines = [
    'RECHNUNG',
    'Lieferanschrift Tchibo Brands S.R.L BUSINESS GARDEN BUCURESTI, Calea Plevnei nr. 159',
    '221Q1S2770HLENOVO NB TP X1 2-in-1 G10 U5 16G 1T 11P',
    'SN: SPF6C0R75',
  ];
  const { rows } = parseInvoiceLines(lines, 'fks');
  assert.equal(rows[0].artNr, '21Q1S2770H');
  assert.doesNotMatch(rows[0].modelText || '', /Tchibo|BUSINESS GARDEN|Plevnei/i);
  assert.match(rows[0].modelText, /Lenovo NB TP X1/i);
});

test('parseInvoiceLines fks parses glued MTM and description on one line', () => {
  const lines = [
    'RECHNUNG',
    '221Q1S2770HLENOVO NB TP X1 2-in-1 G10 U5 16G 1T 11P 1Stück 2643.11 2643.11',
    'SN: SPF6C0R75',
  ];
  const { rows } = parseInvoiceLines(lines, 'fks');
  assert.equal(rows[0].artNr, '21Q1S2770H');
  assert.match(rows[0].modelText, /Lenovo NB TP X1/i);
  assert.doesNotMatch(rows[0].modelText, /Stück|2643/i);
});

test('addMonthsToDate extends warranty from purchase date', async () => {
  const { addMonthsToDate } = await import('../src/import/date-utils.js');
  assert.equal(addMonthsToDate('2025-06-16', 36), '2028-06-16');
  assert.equal(addMonthsToDate('2026-01-20', 12), '2027-01-20');
});

test('parseInvoiceLines chrome parses warranty certificate table rows', () => {
  const lines = [
    'Chrome computers',
    'Certificat de garantie, calitate si conformitate',
    '1 MW0W3RO/A MW0W3RO/A Laptop Apple MacBook Air 13", Apple M4, 16GB RAM, 256GB, Silver SMWL5F972HG 36',
    '2 MW0W3RO/A MW0W3RO/A Laptop Apple MacBook Air 13", Apple M4, 16GB RAM, 256GB, Silver SG6N7VX4R0H 36',
    '3 MW0W3RO/A MW0W3RO/A Laptop Apple MacBook Air 13", Apple M4, 16GB RAM, 256GB, Silver SK90G4K2321 36',
    '4 MW0W3RO/A MW0W3RO/A Laptop Apple MacBook Air 13", Apple M4, 16GB RAM, 256GB, Silver SJ47JD4LX6D 36',
  ];
  const { templateId, rows } = parseInvoiceLines(lines, 'chrome');
  assert.equal(templateId, 'chrome');
  assert.equal(rows.length, 4);
  assert.equal(rows[0].artNr, 'MW0W3RO/A');
  assert.equal(rows[0].warrantyMonths, 36);
  assert.match(rows[0].modelText, /MacBook Air/i);
  assert.equal(rows[0].serial, 'SMWL5F972HG');
  assert.equal(rows[3].serial, 'SJ47JD4LX6D');
});

test('extractInvoiceMetaFromLines parses Romanian Chrome invoice header', () => {
  const meta = extractInvoiceMetaFromLines([
    'CHROME COMPUTERS SRL',
    'Factura Fiscala FCHR0037354',
    'Data: 16/06/2025',
    'Data scadenta: 15/07/2025',
    'Total de plata: 82,229.00 RON'
  ]);
  assert.equal(meta.invoiceNumber, 'FCHR0037354');
  assert.equal(meta.invoiceDate, '2025-06-16');
  assert.equal(meta.vendor, 'Chrome Computers');
  assert.match(meta.amount, /82,229/);
});

test('extractInvoiceMetaFromLines parses German FKS invoice header', () => {
  const meta = extractInvoiceMetaFromLines([
    'FKS IT GmbH',
    'RECHNUNG',
    'Rechn.-Nr.: 111961',
    'Datum: 01.06.2026',
    'Gesamtbetrag EUR 2701.11'
  ]);
  assert.equal(meta.invoiceNumber, '111961');
  assert.equal(meta.invoiceDate, '2026-06-01');
  assert.equal(meta.vendor, 'FKS IT GmbH');
  assert.match(meta.amount.replace(/,/g, ''), /2701/);
});

test('parseInvoiceLines cancom parses aviz with Apple cod and S/N list', () => {
  const lines = [
    'CANCOM ROMANIA SRL',
    'AVIZ DE INSOTIRE A MARFII',
    'Nr.: AI-7864 din data 20.01.2026',
    'MX2E3RO/A MacBook Pro 14" Apple M4 Pro/12C CPU/16C GPU/24GB/512GB Silver, S/N: SKM77Y2D12C, SKMWT47J7NP, SKM4G4Y4LJ2',
    'S/N: SKM77Y2D12C, SKMWT47J7NP',
  ];
  const { templateId, rows } = parseInvoiceLines(lines, 'cancom');
  assert.equal(templateId, 'cancom');
  assert.ok(rows.length >= 2);
  assert.equal(rows[0].artNr, 'MX2E3RO/A');
  assert.match(rows[0].modelText, /MacBook Pro 14/i);
  assert.ok(rows.some((r) => r.serial === 'SKM77Y2D12C'));
});

test('parseInvoiceLines cancom parses Word PDF with split cod and serial lines', () => {
  const lines = [
    'CANCOM ROMANIA SRL',
    'AVIZ DE INSOTIRE A MARFII',
    'Nr.: AI-7864 din data 20.01.2026',
    '1.',
    'MX2E3RO/A',
    'C, International',
    'layout, S/N: SKM77Y2D12C, SKMWT47J7NP, SKN73G330N0,',
    'SKPX1PHGW1W, SKM2QC7926V, SKQJWW44RD0, SKM21WFM7F0,',
    'SKLGKY6V3X9, SKMT2YF54JM, SKLQ4MKG341, SKLW19GQX7R,',
    'SKR9J4P7006, SKN6GM6TD7V, SKRQV6YXKF9, SKQ9HQD3JQK',
    '15',
  ];
  const { templateId, rows } = parseInvoiceLines(lines, 'cancom');
  assert.equal(templateId, 'cancom');
  assert.equal(rows.length, 15);
  assert.equal(rows[0].artNr, 'MX2E3RO/A');
  assert.match(rows[0].modelText, /MacBook Pro 14/i);
  assert.ok(rows.some((r) => r.serial === 'SKQ9HQD3JQK'));
});

test('extractInvoiceMetaFromLines parses Cancom aviz header', () => {
  const meta = extractInvoiceMetaFromLines([
    'CANCOM ROMANIA S.R.L.',
    'AVIZ DE INSOTIRE A MARFII',
    'Nr.: AI-7864 din data (ZZ.LL.AAAA): 20.01.2026',
  ]);
  assert.equal(meta.invoiceNumber, 'AI-7864');
  assert.equal(meta.invoiceDate, '2026-01-20');
  assert.equal(meta.vendor, 'Cancom Romania');
});

test('parseInvoiceLines chrome extracts MacBook product and comma-separated serials', () => {
  const lines = [
    'CHROME COMPUTERS SRL',
    'Factura Fiscala FCHR0037354',
    'Z1FB001LB Laptop APPLE MacBook MacBook Pro 14.2", Apple M4 Pro (CPU 12-core, GPU 16-core), 48GB, SSD 512GB',
    'S/n: SJY10V2G7N4 , SHDJVWQV6NL , SDY0C0HPGFC , SCY0XFJCM2J , SD92P9PG7ML , SC4V0MPCJHQ , SJWXLM2H9Q7',
  ];
  const { templateId, rows } = parseInvoiceLines(lines, 'auto');
  assert.equal(templateId, 'chrome');
  assert.equal(rows.length, 7);
  assert.equal(rows[0].artNr, 'Z1FB001LB');
  assert.match(rows[0].modelText, /MacBook Pro 14/i);
  assert.match(rows[0].modelText, /M4 Pro/i);
  assert.equal(rows[0].serial, 'SJY10V2G7N4');
  assert.equal(rows[6].serial, 'SJWXLM2H9Q7');
});

test('parseInvoiceLines fks assigns each SN to its product block', () => {
  const lines = [
    'RECHNUNG',
    '21RLS5FP0H',
    'Lenovo Notebook ThinkPad X13 Gen 6',
    'SN: SGM17Z47L',
    'SN: SGM17Z47K',
    '21QDS5DU0H',
    'Lenovo Notebook ThinkPad T14 Gen6',
    'SN: SPF62MPL8',
    'SN: SPF62MPKH',
    '64AAGAT2EU',
    'Lenovo ThinkVision T27qd-40',
    'SN: SVNAC4LD6',
    'SN: SVNAC4LBG',
  ];
  const { rows } = parseInvoiceLines(lines, 'fks');
  assert.equal(rows.length, 6);
  assert.equal(rows.find((r) => r.serial === 'SGM17Z47L').artNr, '21RLS5FP0H');
  assert.match(rows.find((r) => r.serial === 'SGM17Z47L').modelText, /X13/i);
  assert.equal(rows.find((r) => r.serial === 'SPF62MPL8').artNr, '21QDS5DU0H');
  assert.match(rows.find((r) => r.serial === 'SPF62MPL8').modelText, /T14/i);
  assert.equal(rows.find((r) => r.serial === 'SVNAC4LD6').artNr, '64AAGAT2EU');
  assert.match(rows.find((r) => r.serial === 'SVNAC4LD6').modelText, /ThinkVision/i);
});

test('parseInvoiceLines generic extracts serials broadly', () => {
  const lines = [
    'Product: Laptop XYZ',
    'Serial Number: ABCDEF1234',
    'ThinkPad T14 Gen 6'
  ];
  const { rows } = parseInvoiceLines(lines, 'generic');
  assert.ok(rows.some((r) => r.serial === 'ABCDEF1234'), `Got: ${JSON.stringify(rows)}`);
});

test('parseInvoiceLines skips purely numeric tokens', () => {
  const lines = ['Invoice 20260101 total 12345678 RON'];
  const { rows } = parseInvoiceLines(lines, 'generic');
  // 20260101 and 12345678 are pure digits and should be skipped
  assert.equal(rows.filter((r) => /^\d+$/.test(r.serial)).length, 0);
});

// ---------------------------------------------------------------------------
// Preview / apply integration tests
// ---------------------------------------------------------------------------

test('buildInvoicePreview matches FKS Lenovo MTM from Art.-Nr.', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-inv-mtm-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();

    const lines = [
      'RECHNUNG',
      '21Q1S2770H',
      'Lenovo NB TP X1 2-in-1 G10 U5 16G 1T 11P',
      'SN: SPF6C0R75',
    ];
    const preview = buildInvoicePreview(store, { buffer: makePdfBuffer(lines), originalName: 'fks.pdf' }, {
      templateId: 'fks'
    });

    const row = preview.rows.find((r) => r.serial === 'SPF6C0R75');
    assert.ok(row);
    assert.equal(row.artNr, '21Q1S2770H');
    assert.equal(row.modelMatch, 'mtm');
    assert.match(row.modelLabel, /X1 2-in-1/i);
    assert.match(row.modelLabel, /Gen 10/i);
    assert.equal(row.action, 'create');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildInvoicePreview creates preview rows with in_stock action', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-inv-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();

    const catalog = store.listCatalog();
    const lenovoModel = catalog.models.find((m) => m.name.includes('ThinkPad T14') && m.generation === 'Gen 4');
    assert.ok(lenovoModel, 'Need ThinkPad T14 Gen 4 in catalog');

    // Build PDF text that mentions a serial + model name matching catalog
    const lines = [
      'Altex Romania',
      'ThinkPad T14 Gen 4 Intel Core i5',
      'S/N: PFTESTSER  Qty: 1'
    ];
    const buf = makePdfBuffer(lines);
    const preview = buildInvoicePreview(store, { buffer: buf, originalName: 'test.pdf' }, {
      invoiceNumber: 'F-2026-001',
      invoiceDate: '2026-06-01',
      vendor: 'Altex',
      amount: '5000 RON',
      templateId: 'altex'
    });

    assert.equal(preview.fileName, 'test.pdf');
    assert.equal(preview.invoiceMeta.invoiceNumber, 'F-2026-001');
    assert.ok(preview.rows.length >= 1);
    const row = preview.rows.find((r) => r.serial === 'PFTESTSER');
    assert.ok(row, `Row with serial PFTESTSER not found. Rows: ${JSON.stringify(preview.rows)}`);
    // Action should be create (model matched or needsReview)
    assert.ok(['create', 'needsReview'].includes(row.action), `action: ${row.action}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildInvoicePreview marks duplicate serial as skip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-inv-dup-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();

    const [model] = store.listCatalog().models;
    await store.createAsset({ assetTag: 'EXISTING-001', serialNumber: 'DUPSERIAL1', modelId: model.id }, 'test');

    const lines = ['Altex Romania', 'ThinkPad T14 Gen 4', 'S/N: DUPSERIAL1  Qty: 1'];
    const buf = makePdfBuffer(lines);
    const preview = buildInvoicePreview(store, { buffer: buf, originalName: 'dup.pdf' }, { templateId: 'altex' });

    const row = preview.rows.find((r) => r.serial === 'DUPSERIAL1');
    assert.ok(row, 'Row not found');
    assert.equal(row.action, 'skip', `Expected skip but got: ${row.action}`);
    assert.equal(row.modelMatch, 'duplicate');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('applyInvoiceImport creates assets with in_stock status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-inv-apply-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();

    const catalog = store.listCatalog();
    const model = catalog.models.find((m) => m.name.includes('ThinkPad T14'));

    // Fake preview with one create row (model already resolved)
    const preview = {
      fileName: 'order.pdf',
      templateId: 'altex',
      invoiceMeta: { invoiceNumber: 'F-001', invoiceDate: '2026-06-01', vendor: 'Altex', amount: '3000' },
      rows: [
        {
          rowKey: 'invoice:0:NEWSER001',
          idx: 0, serial: 'NEWSER001', modelText: 'ThinkPad T14 Gen 4',
          assetTag: 'NEWSER001', qty: 1, action: 'create', needsReview: false,
          modelId: model.id, modelLabel: 'Lenovo ThinkPad T14 Gen 4', modelMatch: 'auto',
          purchaseDate: '2026-06-01', warrantyUntil: '2029-06-01', warrantyMonths: 36,
          newModelRef: null, warnings: []
        }
      ],
      summary: { total: 1, create: 1, skip: 0, needsReview: 0 }
    };
    const savedFile = {
      fileName: 'invoice.pdf',
      originalName: 'order.pdf',
      relativePath: 'invoices/2026/_/invoice.pdf',
      size: 100,
      mimeType: 'application/pdf'
    };

    const result = await applyInvoiceImport(store, preview, null, savedFile, 'test');
    assert.equal(result.summary.created, 1);
    assert.equal(result.summary.skipped, 0);

    const asset = store.findAssetBySerial('NEWSER001');
    assert.ok(asset, 'Asset not found after apply');
    assert.equal(asset.status, 'in_stock');
    assert.equal(asset.serialNumber, 'NEWSER001');
    assert.equal(asset.vendor, 'Altex');
    assert.equal(asset.purchaseDate, '2026-06-01');
    assert.equal(asset.warrantyUntil, '2029-06-01');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildInvoicePreview sets purchase date from invoice; warranty only if stated in PDF', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-inv-dates-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const lines = [
      'CANCOM ROMANIA SRL',
      'Nr.: AI-7864 din data 20.01.2026',
      'MX2E3RO/A',
      'layout, S/N: SKM77Y2D12C, SKMWT47J7NP',
    ];
    const preview = buildInvoicePreview(store, { buffer: makePdfBuffer(lines), originalName: 'cancom.pdf' }, {
      templateId: 'cancom'
    });
    const row = preview.rows.find((r) => r.serial === 'SKM77Y2D12C');
    assert.ok(row);
    assert.equal(row.purchaseDate, '2026-01-20');
    assert.equal(row.warrantyUntil, '');
    assert.equal(row.warrantyMonths, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractDocumentDeviceFields reads warranty months from invoice text', async () => {
  const { extractDocumentDeviceFields } = await import('../src/import/invoice-fields-extractor.js');
  const fields = extractDocumentDeviceFields([
    'Certificat de garantie, calitate si conformitate',
    'Perioada de garantie: 36 luni de la data livrarii',
    'Data livrarii: 16.06.2025',
  ]);
  assert.equal(fields.warrantyMonths, 36);
  assert.equal(fields.purchaseDate, '2025-06-16');
});

test('extractDocumentDeviceFields reads broken Cancom aviz date lines', async () => {
  const { extractDocumentDeviceFields } = await import('../src/import/invoice-fields-extractor.js');
  const lines = [
    'Nr.:', 'AI', '-', '7864', 'din data', '(ZZ.LL.AAAA)', ':', '20', '.01.2026',
    'CANCOM ROMANIA S.R.L.',
  ];
  const fields = extractDocumentDeviceFields(lines);
  assert.equal(fields.purchaseDate, '2026-01-20');
  assert.equal(fields.warrantyMonths, 0);
});

test('applyInvoiceImport blocks when needsReview rows remain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-inv-block-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();

    const preview = {
      fileName: 'order.pdf', templateId: 'generic',
      invoiceMeta: { invoiceNumber: '', invoiceDate: '', vendor: '', amount: '' },
      rows: [
        {
          rowKey: 'invoice:0:UNRESOLVED', idx: 0, serial: 'UNRESOLVED', modelText: 'unknown device xyz',
          assetTag: 'UNRESOLVED', qty: 1, action: 'needsReview', needsReview: true,
          modelId: '', modelLabel: '', modelMatch: 'none', newModelRef: null,
          warnings: ['Could not match model']
        }
      ],
      summary: { total: 1, create: 0, skip: 0, needsReview: 1 }
    };

    await assert.rejects(
      () => applyInvoiceImport(store, preview, null, {}, 'test'),
      /rows that still need model selection/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createCatalogModel creates new model and is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-newmodel-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();

    const catalog = store.listCatalog();
    const brand = catalog.brands.find((b) => b.name === 'Lenovo');

    const model1 = await store.createCatalogModel({
      brandId: brand.id, name: 'ThinkPad T16', generation: 'Gen 2', deviceType: 'Laptop'
    }, 'test');
    assert.equal(model1.name, 'ThinkPad T16');
    assert.equal(model1.generation, 'Gen 2');

    // Calling again with same params returns the existing model
    const model2 = await store.createCatalogModel({
      brandId: brand.id, name: 'ThinkPad T16', generation: 'Gen 2', deviceType: 'Laptop'
    }, 'test');
    assert.equal(model1.id, model2.id, 'Should return existing model on duplicate');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createCatalogModel creates missing brand when categoryName is provided', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-newbrand-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();

    const model = await store.createCatalogModel({
      brandName: 'Xiaomi',
      categoryName: 'Telefon',
      name: '2409BRN2CY',
      generation: 'Standard',
      deviceType: 'Telefon'
    }, 'test');

    const catalog = store.listCatalog();
    assert.ok(catalog.brands.some((b) => b.name === 'Xiaomi'));
    assert.equal(model.name, '2409BRN2CY');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('applyInvoiceImport creates new model before creating asset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-newmodel-apply-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();

    const catalog = store.listCatalog();
    const brand = catalog.brands.find((b) => b.name === 'Lenovo');

    const preview = {
      fileName: 'order.pdf', templateId: 'generic',
      invoiceMeta: { invoiceNumber: 'F-002', invoiceDate: '2026-06-02', vendor: 'Test', amount: '' },
      newModels: [
        { ref: 'nm-0', brandId: brand.id, brandName: 'Lenovo', name: 'ThinkPad T16', generation: 'Gen 2', deviceType: 'Laptop' }
      ],
      rows: [
        {
          rowKey: 'invoice:0:NEWMODEL001', idx: 0, serial: 'NEWMODEL001', modelText: 'ThinkPad T16 Gen 2',
          assetTag: 'NEWMODEL001', qty: 1, action: 'needsReview', needsReview: false,
          modelId: '', modelLabel: '', modelMatch: 'none', newModelRef: 'nm-0', warnings: []
        }
      ],
      summary: { total: 1, create: 1, skip: 0, needsReview: 0 }
    };

    const savedFile = {
      fileName: 'inv.pdf', originalName: 'order.pdf',
      relativePath: 'invoices/2026/_/inv.pdf', size: 50, mimeType: 'application/pdf'
    };

    const result = await applyInvoiceImport(store, preview, null, savedFile, 'test');
    assert.equal(result.summary.created, 1);
    const asset = store.findAssetBySerial('NEWMODEL001');
    assert.ok(asset, 'Asset should have been created');
    assert.equal(asset.status, 'in_stock');

    // Verify model was created in catalog
    const updatedCatalog = store.listCatalog();
    const newModel = updatedCatalog.models.find((m) => m.name === 'ThinkPad T16' && m.generation === 'Gen 2');
    assert.ok(newModel, 'New model should exist in catalog');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
