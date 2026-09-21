import { createServer } from 'node:http';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InventoryStore, clean, id } from './store.js';
import { applyImport, buildImportPreview, importTemplates } from './import/importer.js';
import { applyUserImport, buildUserImportPreview, userImportTemplates } from './import/user-importer.js';
import { applyInvoiceImport, buildInvoicePreview, extractInvoiceMetaFromPdf, invoiceTemplates, mergeInvoiceFields } from './import/invoice-importer.js';
import { renderHandoverDocx } from './documents/docx-template.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const publicDir = join(rootDir, 'public');
const uploadRoot = process.env.ITINV_UPLOAD_PATH || join(rootDir, 'data', 'uploads');
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 8080);
const maxUploadBytes = Number(process.env.ITINV_MAX_UPLOAD_MB || 20) * 1024 * 1024;

const store = new InventoryStore();
await store.init();

const server = createServer(async (req, res) => {
  try {
    addSecurityHeaders(res);
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendError(res, error);
  }
});

server.listen(port, host, () => {
  console.log(`IT Inventory ruleaza la http://${host}:${port}`);
});

async function handleApi(req, res, url) {
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter(Boolean).slice(1);
  const actor = req.headers['x-it-actor'] || req.socket.remoteAddress || 'IT';

  if (method === 'GET' && url.pathname === '/api/health') {
    const catalog = store.listCatalog();
    sendJson(res, {
      ok: true,
      time: new Date().toISOString(),
      importResolver: '2026-06-11',
      userImport: true,
      iphoneModels: catalog.models.filter((m) => m.name?.startsWith('iPhone')).length,
      catalogModels: catalog.models.length
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/dashboard') {
    sendJson(res, store.dashboard());
    return;
  }

  if (method === 'GET' && url.pathname === '/api/catalog') {
    sendJson(res, store.listCatalog());
    return;
  }

  if (segments[0] === 'import') {
    if (method === 'GET' && segments[1] === 'templates') return sendJson(res, importTemplates());

    if (method === 'POST' && segments[1] === 'preview') {
      const upload = await readMultipartImport(req);
      await store.seedMissingCatalog();
      return sendJson(res, buildImportPreview(store, upload.file, upload.fields));
    }
    if (method === 'POST' && segments[1] === 'apply') {
      return sendJson(res, await applyImport(store, await readJson(req), actor));
    }

    if (method === 'GET' && segments[1] === 'users' && segments[2] === 'templates') {
      return sendJson(res, userImportTemplates());
    }
    if (method === 'POST' && segments[1] === 'users' && segments[2] === 'preview') {
      const upload = await readMultipartImport(req);
      return sendJson(res, buildUserImportPreview(store, upload.file, upload.fields));
    }
    if (method === 'POST' && segments[1] === 'users' && segments[2] === 'apply') {
      return sendJson(res, await applyUserImport(store, await readJson(req), actor));
    }

    // Invoice-driven import
    if (method === 'GET' && segments[1] === 'invoices' && segments[2] === 'templates') {
      return sendJson(res, invoiceTemplates.map((t) => ({ id: t.id, label: t.label })));
    }
    if (method === 'POST' && segments[1] === 'invoices' && segments[2] === 'parse-meta') {
      const upload = await readMultipartPdf(req);
      return sendJson(res, extractInvoiceMetaFromPdf(upload.file.buffer));
    }
    if (method === 'POST' && segments[1] === 'invoices' && segments[2] === 'preview') {
      const upload = await readMultipartPdf(req);
      return sendJson(res, buildInvoicePreview(store, upload.file, upload.fields));
    }
    if (method === 'POST' && segments[1] === 'invoices' && segments[2] === 'apply') {
      const body = await readJson(req);
      // savedFile info is embedded in the preview (we re-save the PDF from the body reference)
      // The client sends the preview JSON; the PDF was already stored during preview via a prior upload.
      // Here we accept preview + optional savedFile path from body.
      if (!body.preview) throw Object.assign(new Error('Missing preview payload.'), { status: 400 });
      const result = await applyInvoiceImport(store, body.preview, null, body.savedFile, actor);
      return sendJson(res, result);
    }
    if (method === 'POST' && segments[1] === 'invoices' && segments[2] === 'upload') {
      // Two-step: upload PDF first → get savedFile info + preview in one shot
      const upload = await readMultipartPdf(req);
      const preview = buildInvoicePreview(store, upload.file, upload.fields);
      // Persist the PDF immediately so it can be attached during apply
      const saved = await saveInvoiceFile('_invoice_import', upload);
      preview._savedFile = saved;
      return sendJson(res, preview);
    }
  }

  if (segments[0] === 'catalog') {
    if (method === 'GET' && segments.length === 1) return sendJson(res, store.listCatalog());
    if (method === 'POST' && segments[1] === 'models') {
      return sendJson(res, await store.createCatalogModel(await readJson(req), actor), 201);
    }
  }

  if (segments[0] === 'people') {
    if (method === 'GET' && segments.length === 1) return sendJson(res, store.listPeople());
    if (method === 'POST' && segments.length === 1) return sendJson(res, await store.createPerson(await readJson(req), actor), 201);
    if (method === 'POST' && segments[1] === 'merge') {
      const body = await readJson(req);
      return sendJson(res, await store.mergePeopleByIds(body.primaryId, body.secondaryId, actor));
    }
    if (method === 'GET' && segments.length === 2) return sendMaybe(res, store.getPerson(segments[1]));
    if (method === 'PUT' && segments.length === 2) return sendMaybe(res, await store.updatePerson(segments[1], await readJson(req), actor));
    if (method === 'DELETE' && segments.length === 2) return sendMaybe(res, await store.deletePerson(segments[1], actor));
    if (method === 'GET' && segments.length === 3 && segments[2] === 'documents') {
      if (!store.getPerson(segments[1])) return sendError(res, Object.assign(new Error('Persoana nu exista.'), { status: 404 }));
      return sendJson(res, store.listPersonDocuments(segments[1]));
    }
    if (method === 'POST' && segments.length === 3 && segments[2] === 'documents') {
      const upload = await readMultipartPdf(req);
      const saved = await savePersonDocumentFile(segments[1], upload);
      return sendJson(res, await store.addPersonDocument(segments[1], upload.fields, saved, actor), 201);
    }
  }

  if (segments[0] === 'settings') {
    if (method === 'GET' && segments.length === 1) return sendJson(res, store.getSettings());
    if (method === 'PUT' && segments.length === 1) {
      return sendJson(res, await store.updateSettings(await readJson(req), actor));
    }
  }

  if (segments[0] === 'reports') {
    if (method === 'GET' && segments.length === 1) return sendJson(res, store.listReportTypes());
    if (method === 'GET' && segments.length === 2) {
      const rows = store.buildReportRows(segments[1]);
      return sendCsv(res, rowsToCsv(rows), `report-${segments[1]}.csv`);
    }
  }

  if (segments[0] === 'backup') {
    if (method === 'GET' && segments[1] === 'database') {
      const content = await readFile(store.dbPath);
      return sendBinary(res, content, {
        contentType: 'application/json; charset=utf-8',
        fileName: `app.db-${new Date().toISOString().slice(0, 10)}.json`
      });
    }
    if (method === 'POST' && segments[1] === 'restore') {
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || !Array.isArray(body.people) || !Array.isArray(body.assets)) {
        throw Object.assign(new Error('Backup invalid: lipsesc people/assets.'), { status: 400 });
      }
      await store.restoreDatabase(body, actor);
      return sendJson(res, { ok: true, people: store.listPeople().length, assets: store.listAssets().length });
    }
  }

  if (segments[0] === 'person-documents') {
    if (method === 'GET' && segments.length === 2) {
      const document = store.getPersonDocument(segments[1]);
      if (!document) return sendError(res, Object.assign(new Error('Documentul nu exista.'), { status: 404 }));
      return streamPdfFile(res, document);
    }
    if (method === 'DELETE' && segments.length === 2) {
      const removed = await store.deletePersonDocument(segments[1], actor);
      await unlink(join(uploadRoot, removed.relativePath)).catch(() => {});
      return sendJson(res, { ok: true, id: removed.id });
    }
  }

  if (segments[0] === 'assets') {
    if (method === 'GET' && segments.length === 1) return sendJson(res, store.listAssets());
    if (method === 'POST' && segments.length === 1) return sendJson(res, await store.createAsset(await readJson(req), actor), 201);
    if (method === 'GET' && segments.length === 2) return sendMaybe(res, store.getAsset(segments[1]));
    if (method === 'PUT' && segments.length === 2) return sendMaybe(res, await store.updateAsset(segments[1], await readJson(req), actor));
    if (method === 'DELETE' && segments.length === 2) return sendMaybe(res, await store.deleteAsset(segments[1], actor));
    if (method === 'POST' && segments.length === 3 && segments[2] === 'reassign') {
      return sendJson(res, await store.reassignAsset(segments[1], await readJson(req), actor));
    }
    if (method === 'POST' && segments.length === 3 && segments[2] === 'unassign') {
      return sendJson(res, await store.unassignAsset(segments[1], await readJson(req), actor));
    }
    if (method === 'POST' && segments.length === 3 && segments[2] === 'invoices') {
      const upload = await readMultipartPdf(req);
      const extracted = extractInvoiceMetaFromPdf(upload.file.buffer);
      upload.fields = mergeInvoiceFields(upload.fields, extracted);
      const saved = await saveInvoiceFile(segments[1], upload);
      return sendJson(res, await store.addInvoice(segments[1], upload.fields, saved, actor), 201);
    }
  }

  if (segments[0] === 'handover-documents') {
    if (method === 'GET' && segments.length === 1) return sendJson(res, store.listHandoverDocuments());
    if (method === 'POST' && segments[1] === 'preview') {
      return sendJson(res, store.previewHandoverDocument(await readJson(req)));
    }
    if (method === 'POST' && segments.length === 1) {
      return sendJson(res, await store.createHandoverDocument(await readJson(req), actor), 201);
    }
    if (method === 'GET' && segments.length === 3 && segments[2] === 'download') {
      const document = store.getHandoverDocument(segments[1]);
      if (!document) return sendError(res, Object.assign(new Error('Procesul verbal nu exista.'), { status: 404 }));
      const templatePath = join(rootDir, 'templates', 'pv-tchibo.docx');
      const buffer = await renderHandoverDocx(document, templatePath);
      return sendBinary(res, buffer, {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileName: `${document.type}-${document.date}-${safeFileName(document.person?.lastName || 'utilizator')}.docx`
      });
    }
  }

  if (segments[0] === 'invoices' && method === 'GET' && segments.length === 2) {
    const invoice = store.getInvoice(segments[1]);
    if (!invoice) return sendError(res, Object.assign(new Error('Factura nu exista.'), { status: 404 }));
    return streamPdfFile(res, invoice);
  }

  if (segments[0] === 'export' && segments[1] === 'assets' && method === 'GET') {
    return sendCsv(res, buildAssetsCsv(store.listAssets()), 'inventar-it.csv');
  }

  sendError(res, Object.assign(new Error('Ruta API nu exista.'), { status: 404 }));
}

async function serveStatic(req, res, url) {
  let requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  requested = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(publicDir, requested);
  if (!filePath.startsWith(publicDir)) {
    sendError(res, Object.assign(new Error('Cale invalida.'), { status: 400 }));
    return;
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cache-Control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=3600'
    });
    res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      const index = await readFile(join(publicDir, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(index);
      return;
    }
    throw error;
  }
}

async function readJson(req) {
  const buffer = await readBody(req, 10 * 1024 * 1024);
  if (!buffer.length) return {};
  return JSON.parse(buffer.toString('utf8'));
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('Request prea mare.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readMultipartPdf(req) {
  const upload = await readMultipartFile(req, maxUploadBytes);
  if (extname(upload.file.originalName).toLowerCase() !== '.pdf' || !upload.file.buffer.subarray(0, 4).equals(Buffer.from('%PDF'))) {
    throw Object.assign(new Error('Se accepta doar fisiere PDF valide.'), { status: 400 });
  }
  return upload;
}

async function readMultipartImport(req) {
  const upload = await readMultipartFile(req, maxUploadBytes * 2);
  const ext = extname(upload.file.originalName).toLowerCase();
  if (!['.csv', '.zip'].includes(ext)) {
    throw Object.assign(new Error('Se accepta doar fisiere CSV sau ZIP.'), { status: 400 });
  }
  return upload;
}

async function readMultipartFile(req, limitBytes) {
  const contentTypeHeader = req.headers['content-type'] || '';
  const boundary = contentTypeHeader.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] ?? contentTypeHeader.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) throw Object.assign(new Error('Formular upload invalid.'), { status: 400 });
  const body = await readBody(req, limitBytes);
  const parts = splitMultipart(body, boundary);
  const fields = {};
  let file = null;
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const rawHeaders = part.subarray(0, headerEnd).toString('utf8');
    let content = part.subarray(headerEnd + 4);
    if (content.subarray(-2).toString() === '\r\n') content = content.subarray(0, -2);
    const disposition = rawHeaders.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if (!disposition) continue;
    const name = disposition[1];
    const filename = disposition[2];
    if (filename) {
      const type = rawHeaders.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || 'application/pdf';
      file = { originalName: basename(filename), buffer: content, mimeType: type };
    } else {
      fields[name] = content.toString('utf8').trim();
    }
  }
  if (!file) throw Object.assign(new Error('Lipseste fisierul de import/upload.'), { status: 400 });
  return { fields, file };
}

function splitMultipart(body, boundary) {
  const marker = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = body.indexOf(marker);
  while (start !== -1) {
    start += marker.length;
    if (body[start] === 45 && body[start + 1] === 45) break;
    if (body[start] === 13 && body[start + 1] === 10) start += 2;
    const next = body.indexOf(marker, start);
    if (next === -1) break;
    parts.push(body.subarray(start, next));
    start = next;
  }
  return parts;
}

async function saveInvoiceFile(assetId, upload) {
  const year = clean(upload.fields.invoiceDate).slice(0, 4) || String(new Date().getFullYear());
  const relativePath = join('invoices', year, assetId, `${id()}.pdf`);
  const absolutePath = join(uploadRoot, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, upload.file.buffer);
  return {
    fileName: basename(absolutePath),
    originalName: upload.file.originalName,
    relativePath,
    size: upload.file.buffer.length,
    mimeType: upload.file.mimeType
  };
}

async function savePersonDocumentFile(personId, upload) {
  const relativePath = join('people', personId, `${id()}.pdf`);
  const absolutePath = join(uploadRoot, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, upload.file.buffer);
  return {
    fileName: basename(absolutePath),
    originalName: upload.file.originalName,
    relativePath,
    size: upload.file.buffer.length,
    mimeType: upload.file.mimeType || 'application/pdf'
  };
}

function streamPdfFile(res, fileMeta) {
  const absolutePath = join(uploadRoot, fileMeta.relativePath);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${encodeURIComponent(fileMeta.originalName)}"`
  });
  createReadStream(absolutePath).pipe(res);
}

function sendMaybe(res, payload) {
  if (!payload) return sendError(res, Object.assign(new Error('Resursa nu exista.'), { status: 404 }));
  return sendJson(res, payload);
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendCsv(res, csv, fileName = 'inventar-it.csv') {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${fileName}"`
  });
  res.end(csv);
}

function rowsToCsv(rows) {
  if (!rows.length) return '""\r\n';
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(','));
  }
  return lines.join('\r\n');
}

function sendBinary(res, buffer, { contentType, fileName }) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`
  });
  res.end(buffer);
}

function sendError(res, error) {
  const status = error.status || 500;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: error.message || 'Eroare server.' }));
  if (status >= 500) console.error(error);
}

function addSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function contentType(filePath) {
  const ext = extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
  }[ext] || 'application/octet-stream';
}

function buildAssetsCsv(assets) {
  const rows = [
    ['Asset tag', 'Serie', 'Categorie', 'Brand', 'Model', 'Generatie', 'Status', 'Persoana', 'Departament', 'Garantie']
  ];
  for (const asset of assets) {
    rows.push([
      asset.assetTag,
      asset.serialNumber,
      asset.category?.name,
      asset.brand?.name,
      asset.model?.name,
      asset.model?.generation,
      statusLabel(asset.status),
      asset.currentAssignment?.person ? `${asset.currentAssignment.person.firstName} ${asset.currentAssignment.person.lastName}` : '',
      asset.currentAssignment?.person?.department,
      asset.warrantyUntil
    ]);
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function statusLabel(status) {
  return {
    in_stock: 'In stoc',
    assigned: 'Alocat',
    deployed: 'Deployed (MTR)',
    service: 'Service',
    retired: 'Casat'
  }[status] || status;
}

function safeFileName(value) {
  return String(value ?? 'document').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '') || 'document';
}
