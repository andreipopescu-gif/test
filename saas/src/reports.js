import { isWarrantyExpiringWithinDays } from '../../src/utils/asset-model-label.js';

export const reportTypes = [
  { id: 'in_stock', label: 'Devices in stock' },
  { id: 'assigned_by_department', label: 'Assigned devices by department' },
  { id: 'warranty_30', label: 'Warranty expiring in 30 days' },
  { id: 'warranty_90', label: 'Warranty expiring in 90 days' },
  { id: 'people_without_device', label: 'People without a device' },
  { id: 'missing_from_mdm', label: 'Missing from the last MDM import' },
  { id: 'mtr_ro', label: 'Teams Rooms RO' },
  { id: 'mtr_bg', label: 'Teams Rooms BG' }
];

export function buildReportRows(reportId, { assets = [], people = [] } = {}) {
  if (reportId === 'in_stock') {
    return assets.filter((asset) => asset.status === 'in_stock').map(assetRow);
  }
  if (reportId === 'assigned_by_department') {
    return assets
      .filter((asset) => asset.personId)
      .map((asset) => ({
        department: asset.personDepartment || '',
        person: personName(asset),
        email: asset.personEmail || '',
        ...assetRow(asset)
      }))
      .sort((a, b) => a.department.localeCompare(b.department) || a.person.localeCompare(b.person));
  }
  if (reportId === 'warranty_30' || reportId === 'warranty_90') {
    const days = reportId === 'warranty_30' ? 30 : 90;
    return assets
      .filter((asset) => isWarrantyExpiringWithinDays(asset.warrantyEndsOn, days))
      .map(assetRow);
  }
  if (reportId === 'people_without_device') {
    const withDevice = new Set(assets.map((asset) => asset.personId).filter(Boolean));
    return people
      .filter((person) => person.status !== 'inactive' && !withDevice.has(person.id))
      .map((person) => ({
        firstName: person.firstName,
        lastName: person.lastName,
        email: person.email || '',
        department: person.department || '',
        role: person.role || '',
        status: person.status || 'active'
      }));
  }
  if (reportId === 'missing_from_mdm') {
    return assets
      .filter((asset) => asset.importMeta?.missingFromLastImport)
      .map((asset) => ({
        ...assetRow(asset),
        source: asset.importMeta?.source || '',
        missingDetectedAt: asset.importMeta?.missingDetectedAt || ''
      }));
  }
  if (reportId === 'mtr_ro' || reportId === 'mtr_bg') {
    // The offline app keys these off catalogue categories named "MTR RO"/"MTR BG".
    // SaaS assets may carry the category as free text or only in the device name,
    // so both are matched.
    const region = reportId === 'mtr_ro' ? 'ro' : 'bg';
    return assets.filter((asset) => mtrRegionOf(asset) === region).map(assetRow);
  }
  const error = new Error('Unknown report');
  error.status = 404;
  throw error;
}

export function assetsCsv(assets) {
  return rowsToCsv(assets.map((asset) => ({
    assetTag: asset.assetTag || '',
    serialNumber: asset.serialNumber || '',
    category: asset.category || '',
    brand: asset.brand || '',
    model: asset.modelName || '',
    status: asset.status || '',
    person: personName(asset),
    email: asset.personEmail || '',
    department: asset.personDepartment || '',
    operatingSystem: asset.operatingSystem || '',
    ramGb: asset.ramGb ?? '',
    storageGb: asset.storageGb ?? '',
    imei: asset.imei || '',
    vendor: asset.vendor || '',
    purchasedOn: asset.purchasedOn || '',
    warrantyEndsOn: asset.warrantyEndsOn || '',
    source: asset.importMeta?.source || ''
  })));
}

export function rowsToCsv(rows) {
  if (!rows.length) return '""\r\n';
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function assetRow(asset) {
  return {
    assetTag: asset.assetTag || '',
    serialNumber: asset.serialNumber || '',
    status: asset.status || '',
    category: asset.category || '',
    brand: asset.brand || '',
    model: asset.modelName || '',
    person: personName(asset),
    email: asset.personEmail || '',
    warrantyEndsOn: asset.warrantyEndsOn || ''
  };
}

function mtrRegionOf(asset) {
  const haystack = [asset.category, asset.modelName, asset.assetTag]
    .map((value) => String(value ?? '').toLowerCase().replace(/[\s_-]+/g, ''))
    .join(' ');
  if (haystack.includes('mtrro') || haystack.includes('roroom')) return 'ro';
  if (haystack.includes('mtrbg') || haystack.includes('bgroom')) return 'bg';
  return '';
}

function personName(asset) {
  return [asset.personFirstName, asset.personLastName].filter(Boolean).join(' ').trim();
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}
