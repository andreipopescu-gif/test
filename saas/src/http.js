export async function readJson(req, maxBytes = 1_000_000) {
  const body = await readBody(req, maxBytes);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON');
    error.status = 400;
    throw error;
  }
}

export async function readMultipartForm(req, maxBytes = 10_000_000) {
  const contentType = String(req.headers['content-type'] || '');
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1]
    ?? contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2];
  if (!boundary) throw badRequest('Invalid multipart form');

  const body = await readBody(req, maxBytes);
  const marker = Buffer.from(`--${boundary}`);
  const fields = {};
  let file = null;
  let start = body.indexOf(marker);

  while (start !== -1) {
    start += marker.length;
    if (body[start] === 45 && body[start + 1] === 45) break;
    if (body[start] === 13 && body[start + 1] === 10) start += 2;
    const next = body.indexOf(marker, start);
    if (next === -1) break;

    const part = body.subarray(start, next);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const rawHeaders = part.subarray(0, headerEnd).toString('utf8');
      let content = part.subarray(headerEnd + 4);
      if (content.subarray(-2).toString() === '\r\n') content = content.subarray(0, -2);
      const disposition = rawHeaders.match(
        /content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i
      );
      if (disposition) {
        const [, name, originalName] = disposition;
        if (originalName) {
          file = {
            originalName: originalName.split(/[/\\]/).pop(),
            contentType: rawHeaders.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || 'text/csv',
            buffer: content
          };
        } else {
          fields[name] = content.toString('utf8').trim();
        }
      }
    }
    start = next;
  }

  if (!file) throw badRequest('CSV file is required');
  return { fields, file };
}

export function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

export function sendError(res, error) {
  const status = error.status || 500;
  // Only messages that were raised deliberately carry a status. Anything else
  // is an internal failure whose text leaks table names, driver internals and
  // file paths, so the client gets a generic message and the detail is logged.
  const message = error.status ? error.message : 'Server error';
  const payload = { error: message || 'Server error' };
  if (error.status && error.details && typeof error.details === 'object') {
    payload.details = error.details;
  }
  sendJson(res, payload, status);
  if (status >= 500) console.error(error);
}

export function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function unauthorized(message = 'Unauthorized') {
  const error = new Error(message);
  error.status = 401;
  return error;
}

export function notFound(message = 'Not found') {
  const error = new Error(message);
  error.status = 404;
  return error;
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error('Request too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
