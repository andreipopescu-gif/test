#!/usr/bin/env node
/**
 * Download Entra users + Intune managed devices via Microsoft Graph → CSV files
 * ready for IT Inventory Import.
 *
 * Prerequisites:
 *   - Azure app registration with application permissions:
 *       User.Read.All, DeviceManagementManagedDevices.Read.All
 *   - Admin consent granted
 *
 * Env (or pass as args):
 *   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
 *   OUT_DIR (default: ./exports)
 *
 * Usage:
 *   node scripts/download-graph-exports.js
 *   OUT_DIR=C:\\invapp\\imports node scripts/download-graph-exports.js
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const tenantId = process.env.AZURE_TENANT_ID || '';
const clientId = process.env.AZURE_CLIENT_ID || '';
const clientSecret = process.env.AZURE_CLIENT_SECRET || '';
const outDir = process.env.OUT_DIR || join(process.cwd(), 'exports');

if (!tenantId || !clientId || !clientSecret) {
  console.error('Set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET');
  process.exit(1);
}

const token = await getToken();
await mkdir(outDir, { recursive: true });

const users = await graphGetAll(token, 'https://graph.microsoft.com/v1.0/users?$select=id,displayName,givenName,surname,mail,userPrincipalName,jobTitle,department,officeLocation,accountEnabled&$top=999');
const devices = await graphGetAll(token, 'https://graph.microsoft.com/v1.0/deviceManagement/managedDevices?$top=999');

const stamp = new Date().toISOString().slice(0, 10);
const usersPath = join(outDir, `entra-users-${stamp}.csv`);
const devicesPath = join(outDir, `intune-devices-${stamp}.csv`);

await writeFile(usersPath, toCsv(users.map((user) => ({
  id: user.id,
  displayName: user.displayName,
  givenName: user.givenName,
  surname: user.surname,
  mail: user.mail,
  userPrincipalName: user.userPrincipalName,
  jobTitle: user.jobTitle,
  department: user.department,
  officeLocation: user.officeLocation,
  accountEnabled: user.accountEnabled
})), 'utf8'));

await writeFile(devicesPath, toCsv(devices.map((device) => ({
  'Serial number': device.serialNumber,
  'Device name': device.deviceName,
  'Management name': device.managedDeviceName,
  Manufacturer: device.manufacturer,
  Model: device.model,
  OS: device.operatingSystem,
  'OS version': device.osVersion,
  IMEI: device.imei,
  'Primary user UPN': device.userPrincipalName,
  'Primary user display name': device.userDisplayName,
  'Primary user email address': device.emailAddress,
  'Device ID': device.id,
  'Group tag': device.deviceCategoryDisplayName || '',
  'Last check-in': device.lastSyncDateTime,
  'Enrollment date': device.enrolledDateTime
})), 'utf8');

console.log(`Wrote ${users.length} users → ${usersPath}`);
console.log(`Wrote ${devices.length} devices → ${devicesPath}`);
console.log('Import these CSVs in the app (Import → Users / Devices).');

async function getToken() {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });
  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) throw new Error(`Token error ${response.status}: ${await response.text()}`);
  const json = await response.json();
  return json.access_token;
}

async function graphGetAll(accessToken, url) {
  const items = [];
  let next = url;
  while (next) {
    const response = await fetch(next, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) throw new Error(`Graph error ${response.status}: ${await response.text()}`);
    const json = await response.json();
    items.push(...(json.value || []));
    next = json['@odata.nextLink'] || '';
  }
  return items;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}
