import test from 'node:test';
import assert from 'node:assert/strict';
import { entraProvider, toEntraExportRow } from '../src/connectors/entra.js';

test('toEntraExportRow matches the CSV / demo column names', () => {
  const row = toEntraExportRow({
    id: 'obj-1',
    userPrincipalName: 'ana@contoso.com',
    mail: 'ana@contoso.com',
    displayName: 'Ana Pop',
    givenName: 'Ana',
    surname: 'Pop',
    department: 'Engineering',
    jobTitle: 'Developer',
    accountEnabled: true,
    officeLocation: 'Bucharest',
    mobilePhone: '+40 700',
    businessPhones: ['+40 21'],
    manager: { displayName: 'Radu Marin' }
  });
  assert.equal(row['User principal name'], 'ana@contoso.com');
  assert.equal(row.Mail, 'ana@contoso.com');
  assert.equal(row['Display name'], 'Ana Pop');
  assert.equal(row['Account enabled'], 'Yes');
  assert.equal(row.Manager, 'Radu Marin');
  assert.equal(row['Object Id'], 'obj-1');
  assert.equal(row['Mobile phone'], '+40 700');
});

test('toEntraExportRow marks disabled accounts', () => {
  const row = toEntraExportRow({
    id: 'obj-2',
    userPrincipalName: 'x@y.z',
    accountEnabled: false,
    manager: {}
  });
  assert.equal(row['Account enabled'], 'No');
  assert.equal(row.Mail, 'x@y.z');
});

test('entra fetch obtains a token and maps Graph users', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body?.toString?.() || '' });
    if (String(url).includes('/oauth2/v2.0/token')) {
      return jsonResponse({ access_token: 'tok-1', token_type: 'Bearer', expires_in: 3600 });
    }
    if (String(url).includes('/v1.0/users')) {
      return jsonResponse({
        value: [
          {
            id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            userPrincipalName: 'ana@contoso.com',
            mail: 'ana@contoso.com',
            displayName: 'Ana Pop',
            givenName: 'Ana',
            surname: 'Pop',
            department: 'Engineering',
            jobTitle: 'Developer',
            accountEnabled: true,
            officeLocation: 'HQ',
            mobilePhone: null,
            businessPhones: [],
            manager: { displayName: 'Radu Marin' }
          }
        ]
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await entraProvider.fetch({
    credentials: { tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'secret-1' },
    fetchImpl
  });

  assert.equal(result.users.source, 'entra');
  assert.equal(result.users.records.length, 1);
  assert.equal(result.users.records[0]['Display name'], 'Ana Pop');
  assert.equal(result.users.records[0].Manager, 'Radu Marin');
  assert.ok(calls[0].url.includes('/tenant-1/oauth2/v2.0/token'));
  assert.ok(calls[0].body.includes('client_id=client-1'));
  assert.ok(calls[1].url.includes('/v1.0/users?'));
  assert.ok(calls[1].url.includes('$expand=manager'));
});

test('entra fetch requires all credential fields', async () => {
  await assert.rejects(
    () => entraProvider.fetch({ credentials: { tenantId: 't', clientId: 'c' } }),
    (error) => error.status === 400
  );
});

test('entra fetch surfaces token errors', async () => {
  const fetchImpl = async () => jsonResponse({ error: 'invalid_client', error_description: 'bad secret' }, 401);
  await assert.rejects(
    () => entraProvider.fetch({
      credentials: { tenantId: 't', clientId: 'c', clientSecret: 's' },
      fetchImpl
    }),
    (error) => error.status === 401 && /bad secret/.test(error.message)
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
