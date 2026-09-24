import { isWarrantyExpiringWithinDays } from '../../src/utils/asset-model-label.js';
import { countsAs } from './options.js';

export const reportTypes = [
  { id: 'in_stock', label: 'Devices in stock' },
  { id: 'assigned_by_department', label: 'Assigned devices by department' },
  { id: 'warranty_30', label: 'Warranty expiring in 30 days' },
  { id: 'warranty_90', label: 'Warranty expiring in 90 days' },
  { id: 'people_without_device', label: 'People without a device' },
  { id: 'missing_from_mdm', label: 'Missing from the last MDM import' },
  { id: 'by_category', label: 'Devices by category' }
];

export function buildReportRows(reportId, { assets = [], people = [], statusOptions = [] } = {}) {
  if (reportId === 'in_stock') {
    return assets
      .filter((asset) => countsAs(asset.status, statusOptions) === 'in_stock')
      .map(assetRow);
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
  if (reportId === 'by_category' || reportId === 'mtr_ro' || reportId === 'mtr_bg') {
    // mtr_ro / mtr_bg remain as aliases for older bookmarks; they now list
    // every device grouped by its category (Meeting room, Laptop, …).
    return assets
      .slice()
      .sort((a, b) => String(a.category || '').localeCompare(String(b.category || ''))
        || String(a.assetTag || '').localeCompare(String(b.assetTag || '')))
      .map((asset) => ({
        category: asset.category || 'Uncategorized',
        ...assetRow(asset)
      }));
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
    location: asset.locationKey || '',
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

function personName(asset) {
  return [asset.personFirstName, asset.personLastName].filter(Boolean).join(' ').trim();
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}
