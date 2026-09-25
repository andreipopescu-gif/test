#!/usr/bin/env node
/**
 * Manually set an organization's plan / status / device limit.
 *
 *   SAAS_DB_PATH=./data/saas.sqlite node scripts/set-plan.js --slug acme --plan starter --status active
 *   DATABASE_URL=postgres://… node scripts/set-plan.js --email a@b.com --plan team --status active --limit 500
 */

import { openDatabase } from '../src/db.js';
import { BILLING_STATUSES, PLANS, getPlan } from '../src/plans.js';

const args = parseArgs(process.argv.slice(2));
if (args.help || (!args.slug && !args.email && !args.id)) {
  console.log(`Usage:
  node scripts/set-plan.js (--slug SLUG | --email EMAIL | --id UUID)
    --plan trial|starter|team|org
    [--status trial|active|past_due|suspended]
    [--limit N]
    [--billing-email EMAIL]
    [--trial-ends ISO|none]
`);
  process.exit(args.help ? 0 : 1);
}

const plan = getPlan(args.plan || 'starter');
if (args.plan && !PLANS[String(args.plan).toLowerCase()]) {
  console.error(`Unknown plan: ${args.plan}`);
  process.exit(1);
}

const status = String(args.status || (plan.key === 'trial' ? 'trial' : 'active')).toLowerCase();
if (!BILLING_STATUSES.includes(status)) {
  console.error(`Unknown status: ${status}`);
  process.exit(1);
}

const deviceLimit = args.limit != null
  ? Math.max(0, Math.floor(Number(args.limit)))
  : plan.deviceLimit;
if (!Number.isFinite(deviceLimit)) {
  console.error('Invalid --limit');
  process.exit(1);
}

const db = await openDatabase();
try {
  const org = await findOrganization(db, args);
  if (!org) {
    console.error('Organization not found');
    process.exit(1);
  }

  let trialEndsAt = org.trial_ends_at;
  if (args['trial-ends'] === 'none') trialEndsAt = null;
  else if (args['trial-ends']) trialEndsAt = new Date(args['trial-ends']).toISOString();
  else if (status === 'active' || status === 'suspended') trialEndsAt = org.trial_ends_at;

  const billingEmail = args['billing-email'] != null
    ? String(args['billing-email']).trim().toLowerCase()
    : org.billing_email;

  await db.run(`
    UPDATE organizations
    SET plan = ?, status = ?, device_limit = ?, trial_ends_at = ?, billing_email = ?
    WHERE id = ?
  `, [plan.key, status, deviceLimit, trialEndsAt, billingEmail || null, org.id]);

  const updated = await db.get(`
    SELECT id, name, slug, plan, status, device_limit, trial_ends_at, billing_email
    FROM organizations WHERE id = ?
  `, [org.id]);
  console.log(JSON.stringify(updated, null, 2));
} finally {
  await db.close();
}

async function findOrganization(db, opts) {
  if (opts.id) {
    return db.get('SELECT * FROM organizations WHERE id = ?', [opts.id]);
  }
  if (opts.slug) {
    return db.get('SELECT * FROM organizations WHERE LOWER(slug) = LOWER(?)', [opts.slug]);
  }
  return db.get(`
    SELECT o.*
    FROM organizations o
    WHERE LOWER(COALESCE(o.billing_email, '')) = LOWER(?)
       OR o.id IN (
         SELECT m.organization_id
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         WHERE LOWER(u.email) = LOWER(?)
       )
    ORDER BY o.created_at
    LIMIT 1
  `, [opts.email, opts.email]);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}
