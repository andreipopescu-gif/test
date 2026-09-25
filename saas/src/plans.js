/**
 * Entitlement + price list. Payments stay manual for the first customers;
 * this module is the single source of plan limits and public pricing copy.
 */

export const BILLING_STATUSES = ['trial', 'active', 'past_due', 'suspended'];

/** Managed (non-retired) devices are the billing metric. */
export const RETIRED_STATUSES = new Set(['retired']);

export const PLANS = {
  trial: {
    key: 'trial',
    label: 'Trial',
    deviceLimit: 50,
    trialDays: 14,
    priceMonthlyEur: 0,
    priceYearlyEur: 0,
    headline: 'Try Issues on your own sample org',
    includes: [
      'Up to 50 managed devices',
      'CSV import + one live connector',
      'Issues inbox (assign / snooze / resolve)',
      'Admin + IT + read-only seats'
    ]
  },
  starter: {
    key: 'starter',
    label: 'Starter',
    deviceLimit: 100,
    trialDays: 0,
    priceMonthlyEur: 79,
    priceYearlyEur: 790,
    headline: 'For a single site or small IT team',
    includes: [
      'Up to 100 managed devices',
      'Entra + one MDM (Jamf or Intune)',
      'Issues inbox and audit log',
      'Email support (business days)'
    ]
  },
  team: {
    key: 'team',
    label: 'Team',
    deviceLimit: 500,
    trialDays: 0,
    priceMonthlyEur: 199,
    priceYearlyEur: 1_990,
    headline: 'For orgs that live in Entra + MDM daily',
    includes: [
      'Up to 500 managed devices',
      'Entra + Jamf + Intune live sync',
      'Configurable issue rules',
      'Priority support'
    ]
  },
  org: {
    key: 'org',
    label: 'Organization',
    deviceLimit: 2_000,
    trialDays: 0,
    priceMonthlyEur: null,
    priceYearlyEur: null,
    headline: 'Negotiated for larger estates / MSP',
    includes: [
      'Custom device limit',
      'DPA + subprocessor list',
      'Named onboarding',
      'SLA by agreement'
    ]
  }
};

export function getPlan(key) {
  return PLANS[String(key || '').toLowerCase()] || PLANS.trial;
}

export function listPublicPlans() {
  return ['starter', 'team', 'org'].map((key) => {
    const plan = PLANS[key];
    return {
      key: plan.key,
      label: plan.label,
      headline: plan.headline,
      deviceLimit: plan.deviceLimit,
      priceMonthlyEur: plan.priceMonthlyEur,
      priceYearlyEur: plan.priceYearlyEur,
      includes: [...plan.includes]
    };
  });
}

export function defaultTrialEndsAt(now = new Date()) {
  const ends = new Date(now.getTime() + PLANS.trial.trialDays * 24 * 60 * 60 * 1000);
  return ends.toISOString();
}

export function normalizeBillingRow(row = {}) {
  const plan = getPlan(row.plan || row.plan_key || 'trial');
  let status = String(row.status || 'trial').toLowerCase();
  if (!BILLING_STATUSES.includes(status)) status = 'trial';
  const trialEndsAt = row.trial_ends_at || row.trialEndsAt || null;
  if (status === 'trial' && trialEndsAt && trialEndsAt < new Date().toISOString()) {
    status = 'past_due';
  }
  const deviceLimit = Number.isFinite(Number(row.device_limit ?? row.deviceLimit))
    ? Math.max(0, Math.floor(Number(row.device_limit ?? row.deviceLimit)))
    : plan.deviceLimit;
  return {
    plan: plan.key,
    planLabel: plan.label,
    status,
    deviceLimit,
    trialEndsAt,
    billingEmail: row.billing_email || row.billingEmail || ''
  };
}

export function paymentRequired(message, details = {}) {
  const error = new Error(message);
  error.status = 402;
  error.details = details;
  return error;
}

/**
 * Hard limit for manual device creates. Imports surface overage instead of
 * truncating — call annotateImportOverage for those paths.
 */
export function assertWithinPlan(billing, usage, { adding = 1 } = {}) {
  const deviceUsage = Math.max(0, Math.floor(Number(usage) || 0));
  const addingDevices = Math.max(0, Math.floor(Number(adding) || 0));
  const projected = deviceUsage + addingDevices;
  if (projected <= billing.deviceLimit) return;
  throw paymentRequired('Device plan limit reached', {
    plan: billing.plan,
    status: billing.status,
    deviceUsage,
    deviceLimit: billing.deviceLimit,
    overage: projected - billing.deviceLimit
  });
}

export function annotateImportOverage(summary, billing, usage) {
  const creates = Math.max(0, Math.floor(Number(summary?.create) || 0));
  const deviceUsage = Math.max(0, Math.floor(Number(usage) || 0));
  const projected = deviceUsage + creates;
  const overage = Math.max(0, projected - billing.deviceLimit);
  return {
    ...summary,
    deviceUsage,
    deviceLimit: billing.deviceLimit,
    deviceOverage: overage,
    billingWarning: overage
      ? `This import would add ${creates} device(s) and exceed the ${billing.planLabel} limit (${deviceUsage}/${billing.deviceLimit} managed). Apply is allowed; overage is billed manually.`
      : ''
  };
}

export function suspendedBlocksMutation(method) {
  const verb = String(method || 'GET').toUpperCase();
  return verb !== 'GET' && verb !== 'HEAD' && verb !== 'OPTIONS';
}
