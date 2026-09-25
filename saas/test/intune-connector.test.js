import test from 'node:test';
import assert from 'node:assert/strict';
import { intuneProvider, toIntuneExportRow } from '../src/connectors/intune.js';

test('toIntuneExportRow matches CSV export headers', () => {
  const row = toIntuneExportRow({
    id: 'dev-1',
    deviceName: 'ANA-LAPTOP',
    managedDeviceName: 'ANA-LAPTOP',
    serialNumber: 'INTUNE001',
    manufacturer: 'Microsoft',
    model: 'Surface Laptop',
    operatingSystem: 'Windows',
    osVersion: '11',
    imei: '',
    userPrincipalName: 'ana@contoso.test',
    userDisplayName: 'Ana Pop',
    emailAddress: 'ana@contoso.test',
    deviceCategoryDisplayName: 'Corp',
    lastSyncDateTime: '2026-09-24T08:00:00Z',
    enrolledDateTime: '2025-06-01T00:00:00Z'
  });
  assert.equal(row['Device ID'], 'dev-1');
  assert.equal(row['Serial number'], 'INTUNE001');
  assert.equal(row['Primary user UPN'], 'ana@contoso.test');
  assert.equal(row['Last check-in'], '2026-09-24T08:00:00Z');
});

test('intune fetch obtains a token and maps managed devices', async () => {
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes('/oauth2/v2.0/token')) {
      return jsonResponse({ access_token: 'intune-tok', expires_in: 3600 });
    }
    if (href.includes('/deviceManagement/managedDevices')) {
      return jsonResponse({
        value: [{
          id: 'dev-1',
          deviceName: 'ANA-LAPTOP',
          serialNumber: 'INTUNE001',
          manufacturer: 'Microsoft',
          model: 'Surface',
          operatingSystem: 'Windows',
          osVersion: '11',
          userPrincipalName: 'ana@contoso.test',
          userDisplayName: 'Ana Pop',
          emailAddress: 'ana@contoso.test',
          lastSyncDateTime: '2026-09-24T08:00:00Z',
          enrolledDateTime: '2025-06-01T00:00:00Z'
        }]
      });
    }
    throw new Error(`unexpected ${href}`);
  };

  const result = await intuneProvider.fetch({
    credentials: { tenantId: 't', clientId: 'c', clientSecret: 's' },
    fetchImpl
  });
  assert.equal(result.devices.source, 'intune');
  assert.equal(result.devices.records.length, 1);
  assert.equal(result.devices.records[0]['Serial number'], 'INTUNE001');
});

test('intune fetch requires credentials', async () => {
  await assert.rejects(
    () => intuneProvider.fetch({ credentials: { tenantId: 't' } }),
    (error) => error.status === 400
  );
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    }
  };
}
