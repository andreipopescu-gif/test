import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSaasImportPreview } from '../src/import-service.js';
import { parseCsv } from '../../src/import/csv-parser.js';

const intuneHeaders = [
  'Device ID',
  'Device name',
  'Serial number',
  'Primary user UPN',
  'Primary user display name',
  'Last check-in',
  'Manufacturer',
  'Model',
  'OS'
];

function buildCsv({ extraColumns = 0, rows = 1 }) {
  const headers = [...intuneHeaders, ...Array.from({ length: extraColumns }, (_, i) => `Filler ${i}`)];
  const lines = [headers.join(',')];
  for (let row = 0; row < rows; row += 1) {
    const values = [
      `device-${row}`,
      `PC-${row}`,
      `SN-${row}`,
      `user${row}@example.test`,
      `User ${row}`,
      '2026-09-01',
      'Lenovo',
      'ThinkPad T14',
      'Windows',
      ...Array.from({ length: extraColumns }, () => 'x')
    ];
    lines.push(values.join(','));
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

function preview(buffer, source = 'auto') {
  return buildSaasImportPreview({ buffer, fileName: 'devices.csv', source });
}

test('an unknown source is rejected instead of reaching the database', () => {
  assert.throws(
    () => preview(buildCsv({ rows: 1 }), 'evil'),
    (error) => error.status === 400 && /source must be one of/.test(error.message)
  );
});

test('a declared source still overrides detection', () => {
  const result = preview(buildCsv({ rows: 1 }), 'intune');
  assert.equal(result.source, 'intune');
  assert.equal(result.rows.length, 1);
});

test('a CSV with more columns than the cap is refused', () => {
  assert.throws(
    () => preview(buildCsv({ extraColumns: 400, rows: 1 })),
    (error) => error.status === 413 && /columns/.test(error.message)
  );
});

test('a CSV with more rows than the cap is refused', () => {
  const buffer = buildCsv({ rows: 3 });
  assert.throws(
    () => parseCsv(buffer, { maxRows: 2 }),
    (error) => error.status === 413 && /data rows/.test(error.message)
  );
});

// Header lookups used to rescan every column of every record, so cost grew as
// columns x rows and one upload blocked the process for every tenant. A file
// that stays inside the caps must stay well inside a request budget.
test('a wide file inside the caps maps in linear time', () => {
  const buffer = buildCsv({ extraColumns: 240, rows: 1_500 });
  const startedAt = process.hrtime.bigint();
  const result = preview(buffer);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.equal(result.rows.length, 1_500);
  assert.ok(elapsedMs < 5_000, `import took ${Math.round(elapsedMs)}ms`);
});
