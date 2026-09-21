#!/usr/bin/env node
/**
 * Download Jamf Pro computers → CSV ready for IT Inventory Import.
 *
 * Env:
 *   JAMF_URL          e.g. https://company.jamfcloud.com
 *   JAMF_CLIENT_ID    (OAuth client credentials) OR
 *   JAMF_USER / JAMF_PASSWORD (basic auth fallback)
 *   OUT_DIR           default ./exports
 *
 * Usage:
 *   node scripts/download-jamf-exports.js
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const jamfUrl = (process.env.JAMF_URL || '').replace(/\/$/, '');
const outDir = process.env.OUT_DIR || join(process.cwd(), 'exports');
const clientId = process.env.JAMF_CLIENT_ID || '';
const clientSecret = process.env.JAMF_CLIENT_SECRET || '';
const basicUser = process.env.JAMF_USER || '';
const basicPass = process.env.JAMF_PASSWORD || '';

if (!jamfUrl) {
  console.error('Set JAMF_URL');
  process.exit(1);
}

const authHeader = await getAuthHeader();
await mkdir(outDir, { recursive: true });

const listResponse = await fetch(`${jamfUrl}/JSSResource/computers`, {
  headers: { ...authHeader, Accept: 'application/json' }
});
if (!listResponse.ok) throw new Error(`Jamf list failed ${listResponse.status}: ${await listResponse.text()}`);
const listJson = await listResponse.json();
const computers = listJson.computers || [];

const rows = [];
for (const item of computers) {
  const detail = await fetch(`${jamfUrl}/JSSResource/computers/id/${item.id}`, {
    headers: { ...authHeader, Accept: 'application/json' }
  });
  if (!detail.ok) {
    console.warn(`Skip computer ${item.id}: ${detail.status}`);
    continue;
  }
  const data = await detail.json();
  const computer = data.computer || {};
  const general = computer.general || {};
  const hardware = computer.hardware || {};
  const location = computer.location || {};
  rows.push({
    'Computer Name': general.name || '',
    'Serial Number': general.serial_number || '',
    Make: hardware.make || '',
    Model: hardware.model || '',
    'Model Identifier': hardware.model_identifier || '',
    'Asset Tag': general.asset_tag || '',
    Username: location.username || '',
    'Full Name': location.realname || '',
    'Email Address': location.email_address || '',
    Department: location.department || '',
    'Operating System': hardware.os_name || '',
    'Operating System Version': hardware.os_version || '',
    'Total RAM MB': hardware.total_ram_mb || hardware.total_ram || '',
    'Jamf Pro Computer ID': general.id || item.id,
    'Initial Entry Date': general.initial_entry_date_utc || general.initial_entry_date || '',
    'Last Enrollment Date': general.last_enrolled_date_utc || general.last_enrolled_date || ''
  });
  process.stdout.write(`\rFetched ${rows.length}/${computers.length}`);
}
process.stdout.write('\n');

const stamp = new Date().toISOString().slice(0, 10);
const path = join(outDir, `jamf-computers-${stamp}.csv`);
await writeFile(path, toCsv(rows), 'utf8');
console.log(`Wrote ${rows.length} computers → ${path}`);

async function getAuthHeader() {
  if (clientId && clientSecret) {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    });
    const response = await fetch(`${jamfUrl}/api/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!response.ok) throw new Error(`Jamf OAuth failed ${response.status}: ${await response.text()}`);
    const json = await response.json();
    return { Authorization: `Bearer ${json.access_token}` };
  }
  if (basicUser && basicPass) {
    const token = Buffer.from(`${basicUser}:${basicPass}`).toString('base64');
    return { Authorization: `Basic ${token}` };
  }
  throw new Error('Set JAMF_CLIENT_ID+JAMF_CLIENT_SECRET or JAMF_USER+JAMF_PASSWORD');
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
