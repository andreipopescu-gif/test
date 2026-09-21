export async function readJson(req, maxBytes = 1_000_000) {
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
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON');
    error.status = 400;
    throw error;
  }
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
  sendJson(res, { error: error.message || 'Server error' }, status);
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
