/**
 * Shared helpers for HTTP MDM connectors that emit CSV-shaped rows matching
 * saas/src/import/mdm-presets.js so live sync reuses the preset mapper.
 */

import { getPreset } from '../../import/mdm-presets.js';

export function clean(value) {
  return String(value ?? '').trim();
}

export function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

export function requireFields(credentials, fields, label) {
  const out = {};
  const missing = [];
  for (const field of fields) {
    const value = clean(credentials?.[field]);
    if (!value) missing.push(field);
    else out[field] = value;
  }
  if (missing.length) {
    const error = new Error(`${label} credentials require ${missing.join(', ')}.`);
    error.status = 400;
    throw error;
  }
  return out;
}

export function normalizeHttpsBase(value, { allowHttpLoopback = true } = {}) {
  const raw = clean(value).replace(/\/+$/, '');
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    const error = new Error('baseUrl must be a valid http(s) URL.');
    error.status = 400;
    throw error;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    const error = new Error('baseUrl must use http or https.');
    error.status = 400;
    throw error;
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost';
  if (url.protocol === 'http:' && !(allowHttpLoopback && loopback) && process.env.SAAS_MDM_ALLOW_INSECURE !== '1') {
    const error = new Error('baseUrl must use https.');
    error.status = 400;
    throw error;
  }
  return trimSlash(url.toString());
}

/** Build a CSV row using each preset field's primary header alias. */
export function rowFromPreset(presetKey, values = {}) {
  const preset = getPreset(presetKey);
  if (!preset) throw new Error(`Unknown MDM preset: ${presetKey}`);
  const row = {};
  for (const [field, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    const header = preset.fields?.[field]?.[0];
    if (header) row[header] = clean(value);
  }
  return row;
}

export async function readJson(fetchImpl, url, options = {}, label = 'MDM API') {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(apiErrorMessage(label, response.status, text));
    error.status = response.status >= 400 && response.status < 600 ? response.status : 502;
    throw error;
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error(`${label} response was not JSON.`);
    error.status = 502;
    throw error;
  }
}

export function apiErrorMessage(label, status, text) {
  let detail = String(text || '').slice(0, 300);
  try {
    const json = JSON.parse(text);
    detail = json.error_description
      || json.error?.message
      || json.message
      || json.error
      || detail;
  } catch {
    // keep truncated body
  }
  return `${label} request failed (${status}): ${detail}`;
}

export function asList(payload, keys = ['devices', 'data', 'items', 'results', 'systems', 'value']) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}
