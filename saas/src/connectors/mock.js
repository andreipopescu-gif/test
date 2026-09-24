const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * A fake Entra + Jamf pair for demos and tests. The data is shaped like the
 * real exports so it flows through the same mappers, and it is chosen so each
 * exception rule has something to find. `dropSerials` simulates a device that
 * disappeared from Jamf between two syncs.
 */
export const mockProvider = {
  key: 'mock',
  label: 'Demo data (Entra + Jamf)',
  live: false,
  datasets: ['users', 'devices'],
  requiredScopes: [],
  credentialFields: [],
  async fetch({ config = {}, now = new Date() } = {}) {
    const drop = new Set((config.dropSerials || []).map((value) => String(value).toUpperCase()));
    return {
      users: { source: 'entra', records: mockUsers() },
      devices: {
        source: 'jamf',
        records: mockDevices(now).filter((row) => !drop.has(row['Serial Number'].toUpperCase()))
      }
    };
  }
};

export function mockUsers() {
  return [
    user('ana.pop', 'Ana', 'Pop', 'Engineering', 'Developer', 'Yes', 'Radu Marin'),
    user('dan.ionescu', 'Dan', 'Ionescu', 'Sales', 'Account Manager', 'Yes', 'Ana Pop'),
    user('maria.stan', 'Maria', 'Stan', 'Finance', 'Accountant', 'No', 'Ana Pop'),
    user('radu.marin', 'Radu', 'Marin', 'Engineering', 'Engineering Manager', 'Yes', ''),
    user('ioana.dumitru', 'Ioana', 'Dumitru', 'Design', 'Designer', 'Yes', 'Radu Marin'),
    user('elena.vasile', 'Elena', 'Vasile', 'Sales', 'Sales Representative', 'Yes', 'Dan Ionescu')
  ];
}

export function mockDevices(now = new Date()) {
  const at = (ms) => new Date(now.getTime() - ms).toISOString();
  return [
    device('MBP-ANA', 'C02MOCK001', 'MacBook Pro 14', 'Mac15,6', '9001', 'Ana Pop', 'ana.pop', at(2 * HOUR_MS)),
    device('MBA-SPARE', 'C02MOCK002', 'MacBook Air', 'Mac14,2', '9002', '', '', at(5 * HOUR_MS)),
    device('MBP-MARIA', 'C02MOCK003', 'MacBook Pro 14', 'Mac15,6', '9003', 'Maria Stan', 'maria.stan', at(1 * DAY_MS)),
    device('MBA-RADU', 'C02MOCK004', 'MacBook Air', 'Mac14,2', '9004', 'Radu Marin', 'radu.marin', at(45 * DAY_MS)),
    device('MBP-IOANA-1', 'C02MOCK005', 'MacBook Pro 16', 'Mac15,7', '9005', 'Ioana Dumitru', 'ioana.dumitru', at(3 * HOUR_MS)),
    device('MBA-IOANA-2', 'C02MOCK006', 'MacBook Air', 'Mac14,2', '9006', 'Ioana Dumitru', 'ioana.dumitru', at(6 * HOUR_MS))
  ];
}

const DOMAIN = 'demo.example';

function user(alias, first, last, department, title, enabled, manager) {
  return {
    'User principal name': `${alias}@${DOMAIN}`,
    Mail: `${alias}@${DOMAIN}`,
    'Display name': `${first} ${last}`,
    'First name': first,
    'Last name': last,
    Department: department,
    'Job title': title,
    'Account enabled': enabled,
    Manager: manager,
    'Object Id': `00000000-0000-4000-8000-${alias.replace(/[^a-z]/g, '').padEnd(12, '0').slice(0, 12)}`
  };
}

function device(name, serial, model, identifier, jamfId, fullName, alias, lastCheckIn) {
  return {
    'Computer Name': name,
    'Serial Number': serial,
    Model: model,
    'Model Identifier': identifier,
    'Jamf Pro Computer ID': jamfId,
    'Full Name': fullName,
    'Email Address': alias ? `${alias}@${DOMAIN}` : '',
    Username: alias,
    'Total RAM MB': '16384',
    'Operating System Version': '15.4',
    'Last Check-in': lastCheckIn
  };
}
