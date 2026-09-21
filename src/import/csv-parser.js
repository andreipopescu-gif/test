export function parseCsv(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const delimiter = detectDelimiter(normalized);
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      row.push(cell.trim());
      cell = '';
      continue;
    }

    if (!inQuotes && char === '\n') {
      row.push(cell.trim());
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  row.push(cell.trim());
  if (row.some((value) => value !== '')) rows.push(row);
  if (!rows.length) return { headers: [], records: [], delimiter };

  const headers = rows[0].map(normalizeHeader);
  const records = rows.slice(1).map((values, index) => {
    const record = { __line: index + 2 };
    headers.forEach((header, headerIndex) => {
      record[header] = values[headerIndex] ?? '';
    });
    return record;
  });

  return { headers, records, delimiter };
}

export function detectDelimiter(text) {
  const firstLine = text.split('\n').find((line) => line.trim()) ?? '';
  return countUnquoted(firstLine, ';') > countUnquoted(firstLine, ',') ? ';' : ',';
}

export function normalizeHeader(header) {
  return String(header ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function countUnquoted(line, delimiter) {
  let count = 0;
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') inQuotes = !inQuotes;
    if (!inQuotes && char === delimiter) count += 1;
  }
  return count;
}
