/**
 * Live Microsoft Entra ID connector (Graph client credentials).
 *
 * Records are shaped like the Entra CSV export / demo connector so sync and
 * file import stay on the same mapper and exception path.
 */

import {
  DEFAULT_GRAPH,
  DEFAULT_LOGIN,
  clean,
  getGraphAccessToken,
  graphGetAll,
  requireGraphCredentials,
  trimSlash
} from './graph.js';

const USER_SELECT = [
  'id',
  'displayName',
  'givenName',
  'surname',
  'mail',
  'userPrincipalName',
  'jobTitle',
  'department',
  'officeLocation',
  'accountEnabled',
  'mobilePhone',
  'businessPhones'
].join(',');

export const entraProvider = {
  key: 'entra',
  label: 'Microsoft Entra ID',
  live: true,
  datasets: ['users'],
  requiredScopes: ['User.Read.All'],
  auth: 'OAuth 2.0 admin consent (client credentials); no passwords are stored.',
  credentialFields: ['tenantId', 'clientId', 'clientSecret'],
  async fetch({ credentials = {}, config = {}, fetchImpl = globalThis.fetch } = {}) {
    const { tenantId, clientId, clientSecret } = requireGraphCredentials(credentials, 'Entra');
    // Test-only env overrides point at a local mock Graph; never accept host
    // overrides from stored connection config (SSRF).
    void config;
    const loginBase = trimSlash(process.env.SAAS_GRAPH_LOGIN_URL || DEFAULT_LOGIN);
    const graphBase = trimSlash(process.env.SAAS_GRAPH_BASE_URL || DEFAULT_GRAPH);
    const token = await getGraphAccessToken({
      fetchImpl,
      loginBase,
      tenantId,
      clientId,
      clientSecret,
      label: 'Entra token'
    });
    const users = await graphGetAll(
      fetchImpl,
      token,
      `${graphBase}/v1.0/users?$select=${USER_SELECT}&$expand=manager($select=displayName,mail,userPrincipalName)&$top=999`,
      'Microsoft Graph'
    );

    return {
      users: {
        source: 'entra',
        records: users.map(toEntraExportRow)
      }
    };
  }
};

export function toEntraExportRow(user) {
  const manager = user?.manager || {};
  const businessPhone = Array.isArray(user?.businessPhones) ? user.businessPhones[0] : '';
  return {
    'User principal name': clean(user?.userPrincipalName),
    Mail: clean(user?.mail) || clean(user?.userPrincipalName),
    'Display name': clean(user?.displayName),
    'First name': clean(user?.givenName),
    'Last name': clean(user?.surname),
    Department: clean(user?.department),
    'Job title': clean(user?.jobTitle),
    'Account enabled': user?.accountEnabled === false ? 'No' : 'Yes',
    Manager: clean(manager.displayName) || clean(manager.mail) || clean(manager.userPrincipalName),
    'Office location': clean(user?.officeLocation),
    'Mobile phone': clean(user?.mobilePhone) || clean(businessPhone),
    'Object Id': clean(user?.id)
  };
}
