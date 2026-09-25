const app = document.querySelector('#app');
const sessionLabel = document.querySelector('#sessionLabel');

const state = {
  me: null,
  tab: 'dashboard',
  settingsTab: 'catalog',
  people: [],
  assets: [],
  catalog: { categories: [], brands: [], models: [] },
  options: { status: [], department: [], location: [] },
  customFields: { asset: [], person: [] },
  customFieldsEntity: 'asset',
  importPresets: [],
  importProfiles: [],
  importPreview: null,
  importMapping: null,
  importModelOverrides: {},
  importKind: 'devices',
  importSource: 'auto',
  members: [],
  audit: [],
  editingPerson: '',
  editingAsset: '',
  viewingAsset: null,
  viewingPerson: null,
  exceptionsSummary: null,
  issueFilter: { status: 'active', rule: '', severity: '', assignee: '' },
  assetFilter: { search: '', status: '', category: '' },
  mergeKeepId: '',
  mergeAbsorbId: '',
  signedIn: false
};

/** Kept outside state so File can be re-posted for mapping continue. */
let lastImportFile = null;

boot();

async function boot() {
  // Legacy query invites still work once, then we strip them from the URL.
  const inviteToken = readInviteToken();
  if (inviteToken) {
    clearInviteFromUrl();
    return renderInvitation(inviteToken);
  }
  try {
    state.me = await api('/api/me');
    state.signedIn = true;
    await loadData();
    renderApp();
  } catch {
    state.signedIn = false;
    state.me = null;
    renderAuth();
  }
}

function readInviteToken() {
  const hash = String(location.hash || '').replace(/^#/, '');
  const fromHash = new URLSearchParams(hash.includes('=') ? hash : '').get('invite');
  if (fromHash) return fromHash;
  // One-time bridge for links generated before fragment delivery.
  return new URLSearchParams(location.search).get('invite') || '';
}

function clearInviteFromUrl() {
  const url = new URL(location.href);
  url.searchParams.delete('invite');
  url.hash = '';
  history.replaceState({}, '', `${url.pathname}${url.search}`);
}

function setAuthMode(enabled) {
  document.body.classList.toggle('auth-mode', enabled);
}

function renderAuth() {
  setAuthMode(true);
  sessionLabel.textContent = '';
  app.innerHTML = `
    <div class="auth-shell">
      <section class="auth-hero" aria-label="Product">
        <p class="auth-kicker">Multi-tenant inventory</p>
        <h1>IT Inventory</h1>
        <p>People, devices, and imports — isolated per organization.</p>
      </section>
      <div class="auth-panel">
        <section class="auth-card">
          <h2>Create organization</h2>
          <p class="lede">Start a workspace. Each company keeps its own data.</p>
          <form id="registerForm" class="grid">
            <label>Organization <input name="orgName" required placeholder="Acme IT" autocomplete="organization"></label>
            <label>Your name <input name="name" required placeholder="Alex Pop" autocomplete="name"></label>
            <label>Email <input name="email" type="email" required autocomplete="email"></label>
            <label>Password <input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
            <div class="actions span-all">
              <button class="primary" type="submit">Register</button>
            </div>
          </form>
          <p id="authError" class="error" role="alert"></p>
        </section>
        <section class="auth-card">
          <h2>Sign in</h2>
          <p class="lede">Already have an account?</p>
          <form id="loginForm" class="grid">
            <label>Email <input name="email" type="email" required autocomplete="username"></label>
            <label>Password <input name="password" type="password" required autocomplete="current-password"></label>
            <div class="actions span-all">
              <button class="primary" type="submit">Log in</button>
            </div>
          </form>
        </section>
      </div>
    </div>
  `;
  document.querySelector('#registerForm').addEventListener('submit', onRegister);
  document.querySelector('#loginForm').addEventListener('submit', onLogin);
}

async function onRegister(event) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    const result = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(body) });
    await acceptSession(result);
  } catch (error) {
    document.querySelector('#authError').textContent = error.message;
  }
}

async function onLogin(event) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
    if (result.requiresOrganization) {
      renderOrganizationChoice(result, body);
      return;
    }
    await acceptSession(result);
  } catch (error) {
    document.querySelector('#authError').textContent = error.message;
  }
}

async function acceptSession(result) {
  // Session cookie is set by the server (HttpOnly). Never keep the JWT in JS.
  state.signedIn = true;
  state.me = await api('/api/me');
  history.replaceState({}, '', '/');
  await loadData();
  renderApp();
}

function renderOrganizationChoice(result, credentials) {
  setAuthMode(true);
  app.innerHTML = `
    <div class="auth-shell">
      <section class="auth-hero" aria-label="Product">
        <p class="auth-kicker">Choose workspace</p>
        <h1>IT Inventory</h1>
        <p>This account belongs to more than one organization.</p>
      </section>
      <div class="auth-panel">
        <section class="auth-card">
          <h2>Select organization</h2>
          <p class="lede">${escapeHtml(result.user.email)}</p>
          <div class="org-choice">
            ${result.organizations.map((org) => `
              <button type="button" data-login-org="${org.id}">
                ${escapeHtml(org.name)}
                <span class="role">${escapeHtml(org.role)}</span>
              </button>
            `).join('')}
          </div>
        </section>
      </div>
    </div>
  `;
  document.querySelectorAll('[data-login-org]').forEach((button) => {
    button.addEventListener('click', async () => {
      const login = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          ...credentials,
          organizationId: button.dataset.loginOrg
        })
      });
      await acceptSession(login);
    });
  });
}

function renderInvitation(token) {
  setAuthMode(true);
  sessionLabel.textContent = '';
  app.innerHTML = `
    <div class="auth-shell">
      <section class="auth-hero" aria-label="Product">
        <p class="auth-kicker">Invitation</p>
        <h1>IT Inventory</h1>
        <p>Join your organization’s inventory workspace.</p>
      </section>
      <div class="auth-panel">
        <section class="auth-card">
          <h2>Accept invitation</h2>
          <p class="lede">If you already have an account, enter its password. Otherwise choose a new one.</p>
          <form id="acceptInviteForm" class="grid">
            <label>Your name <input name="name" autocomplete="name"></label>
            <label>Password <input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
            <div class="actions span-all">
              <button class="primary" type="submit">Accept invitation</button>
            </div>
          </form>
          <p id="inviteError" class="error" role="alert"></p>
        </section>
      </div>
    </div>
  `;
  document.querySelector('#acceptInviteForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const fields = Object.fromEntries(new FormData(event.currentTarget).entries());
      const result = await api('/api/invitations/accept', {
        method: 'POST',
        body: JSON.stringify({ ...fields, token })
      });
      await acceptSession(result);
    } catch (error) {
      document.querySelector('#inviteError').textContent = error.message;
    }
  });
}

async function loadData() {
  const [people, assets, catalog, options, assetFields, personFields, importPresets, importProfiles, exceptionsSummary] =
    await Promise.all([
      api('/api/people'),
      api('/api/assets'),
      api('/api/catalog').catch(() => ({ categories: [], brands: [], models: [] })),
      api('/api/options').catch(() => ({ status: [], department: [], location: [] })),
      api('/api/custom-fields?entity=asset').catch(() => []),
      api('/api/custom-fields?entity=person').catch(() => []),
      api('/api/import/presets').catch(() => []),
      api('/api/import/profiles').catch(() => []),
      api('/api/exceptions/summary').catch(() => null)
    ]);
  state.exceptionsSummary = exceptionsSummary;
  state.people = people;
  state.assets = assets;
  state.catalog = catalog;
  state.options = {
    status: options.status || [],
    department: options.department || [],
    location: options.location || []
  };
  state.customFields = {
    asset: Array.isArray(assetFields) ? assetFields : (assetFields.fields || []),
    person: Array.isArray(personFields) ? personFields : (personFields.fields || [])
  };
  state.importPresets = Array.isArray(importPresets) ? importPresets : (importPresets.presets || []);
  state.importProfiles = Array.isArray(importProfiles)
    ? importProfiles
    : (importProfiles.profiles || []);
}

function isAdmin() {
  return state.me?.role === 'admin';
}

function canMutateSettings() {
  return isAdmin();
}

function statusOptionList() {
  if (state.options.status?.length) return state.options.status;
  return [
    { key: 'in_stock', label: 'In stock' },
    { key: 'assigned', label: 'Assigned' },
    { key: 'deployed', label: 'Deployed (MTR)' },
    { key: 'service', label: 'In service' },
    { key: 'retired', label: 'Retired' }
  ];
}

function statusSelectOptions(selected = '', { includeEmpty = false, emptyLabel = 'All' } = {}) {
  const empty = includeEmpty
    ? `<option value="">${escapeHtml(emptyLabel)}</option>`
    : '';
  return empty + statusOptionList().map((opt) => `
    <option value="${escapeHtml(opt.key)}" ${opt.key === selected ? 'selected' : ''}>
      ${escapeHtml(opt.label)}
    </option>
  `).join('');
}

function statusLabel(key) {
  const match = statusOptionList().find((opt) => opt.key === key);
  return match?.label || key || '';
}

function departmentFieldHtml(name, selected = '') {
  const list = state.options.department || [];
  if (!list.length) {
    return `<label>Department <input name="${name}" value="${escapeHtml(selected)}"></label>`;
  }
  return `
    <label>Department
      <select name="${name}">
        <option value="">— None —</option>
        ${list.map((opt) => `
          <option value="${escapeHtml(opt.label)}" ${opt.label === selected ? 'selected' : ''}>
            ${escapeHtml(opt.label)}
          </option>
        `).join('')}
      </select>
    </label>
  `;
}

function locationFieldHtml(selected = '') {
  const list = state.options.location || [];
  return `
    <label>Location
      <select name="locationKey">
        <option value="">— None —</option>
        ${list.map((opt) => `
          <option value="${escapeHtml(opt.key)}" ${opt.key === selected ? 'selected' : ''}>
            ${escapeHtml(opt.label)}
          </option>
        `).join('')}
      </select>
    </label>
  `;
}

function locationLabel(key) {
  if (!key) return '';
  const match = (state.options.location || []).find((opt) => opt.key === key);
  return match?.label || key;
}

function customFieldsInputs(entity, values = {}) {
  const bag = values?.custom && typeof values.custom === 'object' ? values.custom : values;
  return (state.customFields[entity] || []).map((field) => {
    const value = bag?.[field.key] ?? '';
    const req = field.required ? 'required' : '';
    const name = `custom.${field.key}`;
    if (field.type === 'boolean') {
      return `
        <label class="check-inline">
          <input type="checkbox" name="${name}" value="true" ${value ? 'checked' : ''}>
          ${escapeHtml(field.label)}${field.required ? ' *' : ''}
        </label>
      `;
    }
    if (field.type === 'select') {
      return `
        <label>${escapeHtml(field.label)}${field.required ? ' *' : ''}
          <select name="${name}" ${req}>
            <option value="">—</option>
            ${(field.options || []).map((opt) => `
              <option value="${escapeHtml(opt)}" ${String(opt) === String(value) ? 'selected' : ''}>
                ${escapeHtml(opt)}
              </option>
            `).join('')}
          </select>
        </label>
      `;
    }
    const inputType = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text';
    return `
      <label>${escapeHtml(field.label)}${field.required ? ' *' : ''}
        <input name="${name}" type="${inputType}" value="${escapeHtml(value)}" ${req}>
      </label>
    `;
  }).join('');
}

function collectCustomFromBody(body, entity) {
  const custom = {};
  const fields = state.customFields[entity] || [];
  for (const field of fields) {
    const key = `custom.${field.key}`;
    if (field.type === 'boolean') {
      custom[field.key] = body[key] === 'true' || body[key] === 'on' || body[key] === true;
    } else if (body[key] !== undefined && body[key] !== '') {
      custom[field.key] = field.type === 'number' ? Number(body[key]) : body[key];
    }
    delete body[key];
  }
  for (const key of Object.keys(body)) {
    if (key.startsWith('custom.')) delete body[key];
  }
  return custom;
}

function catalogModelSelect(selectedId = '', { name = 'modelId', emptyLabel = '— None —' } = {}) {
  return `
    <select name="${name}">
      <option value="">${escapeHtml(emptyLabel)}</option>
      ${catalogOptions(selectedId)}
    </select>
  `;
}

function renderApp() {
  setAuthMode(false);
  const org = state.me.organization?.name || '';
  const user = state.me.user?.email || '';
  sessionLabel.innerHTML = `<strong>${escapeHtml(org)}</strong><br>${escapeHtml(user)} · ${escapeHtml(state.me.role)}`;
  app.innerHTML = `
    <div class="app-chrome">
      <div class="nav-row">
        <nav class="tabs" aria-label="Sections">
          <button type="button" data-tab="dashboard" class="${state.tab === 'dashboard' ? 'active' : ''}">Dashboard</button>
          <button type="button" data-tab="issues" class="${state.tab === 'issues' ? 'active' : ''}">Issues${
            state.exceptionsSummary?.open ? ` <span class="tab-count">${escapeHtml(state.exceptionsSummary.open)}</span>` : ''
          }</button>
          <button type="button" data-tab="people" class="${state.tab === 'people' ? 'active' : ''}">People</button>
          <button type="button" data-tab="assets" class="${state.tab === 'assets' ? 'active' : ''}">Devices</button>
          <button type="button" data-tab="reports" class="${state.tab === 'reports' ? 'active' : ''}">Reports</button>
          ${canWrite() ? `<button type="button" data-tab="import" class="${state.tab === 'import' ? 'active' : ''}">Import</button>` : ''}
          ${state.me.role !== 'readonly' ? `<button type="button" data-tab="members" class="${state.tab === 'members' ? 'active' : ''}">Members</button>` : ''}
          ${state.me.role === 'admin' || state.me.role === 'it' ? `<button type="button" data-tab="settings" class="${state.tab === 'settings' ? 'active' : ''}">Settings</button>` : ''}
          <button type="button" data-tab="account" class="${state.tab === 'account' ? 'active' : ''}">Account</button>
        </nav>
        <div class="nav-actions">
          ${state.me.organizations?.length > 1 ? `
            <select id="organizationSwitch" aria-label="Organization">
              ${state.me.organizations.map((item) => `
                <option value="${item.id}" ${item.id === state.me.organization.id ? 'selected' : ''}>
                  ${escapeHtml(item.name)}
                </option>
              `).join('')}
            </select>
          ` : ''}
          <button type="button" id="logout" class="ghost">Log out</button>
        </div>
      </div>
      <div id="tabContent" class="section-stack"></div>
    </div>
  `;
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.tab = button.dataset.tab;
      renderApp();
    });
  });
  document.addEventListener('click', onTabJump);
  document.querySelector('#logout').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
    } catch {
      // Clear local UI even if the network call failed.
    }
    state.signedIn = false;
    state.me = null;
    renderAuth();
  });
  document.querySelector('#organizationSwitch')?.addEventListener('change', async (event) => {
    const result = await api('/api/auth/switch-organization', {
      method: 'POST',
      body: JSON.stringify({ organizationId: event.target.value })
    });
    await acceptSession(result);
  });
  if (state.tab === 'dashboard') renderDashboard();
  else if (state.tab === 'issues') renderIssues();
  else if (state.tab === 'people') renderPeople();
  else if (state.tab === 'assets') renderAssets();
  else if (state.tab === 'reports') renderReports();
  else if (state.tab === 'import') renderImport();
  else if (state.tab === 'settings') renderSettings();
  else if (state.tab === 'account') renderAccount();
  else renderMembers();
}

function onTabJump(event) {
  const button = event.target.closest?.('[data-tab-jump]');
  if (!button) return;
  state.tab = button.dataset.tabJump;
  renderApp();
}

async function renderDashboard() {
  const target = document.querySelector('#tabContent');
  target.innerHTML = '<section class="panel"><p class="muted">Loading…</p></section>';
  const [data, summary] = await Promise.all([
    api('/api/dashboard'),
    api('/api/exceptions/summary').catch(() => null)
  ]);
  if (state.tab !== 'dashboard') return;
  state.exceptionsSummary = summary;
  document.querySelector('#tabContent').innerHTML = `
    ${summary ? issuesSummaryPanel(summary) : ''}
    <section class="panel">
      <div class="page-head">
        <div>
          <h2>Overview</h2>
          <p class="lede">Everything below is scoped to ${escapeHtml(state.me.organization.name)}.</p>
        </div>
      </div>
      <div class="metrics">
        ${metricCard('Devices', data.counts.assets)}
        ${metricCard('Assigned', data.counts.assignedAssets)}
        ${metricCard('People', data.people.total)}
        ${metricCard('People without a device', data.counts.peopleWithoutDevice)}
        ${metricCard('Warranty ends in 30 days', data.warranty.expiring30)}
        ${metricCard('Missing from MDM', data.counts.missingFromMdm)}
      </div>
    </section>
    <section class="panel">
      <h2>Breakdown</h2>
      <div class="split">
        ${breakdownList('Devices by status', data.assets.byStatus)}
        ${breakdownList('Devices by category', data.assets.byCategory)}
        ${breakdownList('People by department', data.people.byDepartment)}
      </div>
    </section>
    <section class="panel">
      <h2>Warranties ending soon</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Tag</th><th>Serial</th><th>Model</th><th>Warranty ends</th></tr></thead>
          <tbody>
            ${data.warranty.soonest.map((asset) => `
              <tr>
                <td>${escapeHtml(asset.assetTag)}</td>
                <td>${escapeHtml(asset.serialNumber)}</td>
                <td>${escapeHtml(asset.modelName || '')}</td>
                <td>${escapeHtml(asset.warrantyEndsOn || '')}</td>
              </tr>
            `).join('') || '<tr><td colspan="4" class="empty">No warranty ends in the next 90 days.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>
    <section class="panel">
      <h2>Recent assignments</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Started</th><th>Device</th><th>Person</th><th>Source</th><th>Ended</th></tr></thead>
          <tbody>
            ${data.recentAssignments.map((item) => `
              <tr>
                <td>${escapeHtml(String(item.startedAt || '').slice(0, 10))}</td>
                <td>${escapeHtml(item.assetTag)} <span class="muted">${escapeHtml(item.serialNumber)}</span></td>
                <td>${escapeHtml(item.personName || '—')}</td>
                <td>${escapeHtml(item.source || '')}</td>
                <td>${escapeHtml(item.endedAt ? `${String(item.endedAt).slice(0, 10)} · ${item.endReason || ''}` : 'open')}</td>
              </tr>
            `).join('') || '<tr><td colspan="5" class="empty">No assignments yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>
  `;
  document.querySelectorAll('[data-issue-rule]').forEach((button) => {
    button.addEventListener('click', () => {
      state.issueFilter = { ...state.issueFilter, status: 'active', rule: button.dataset.issueRule };
      state.tab = 'issues';
      renderApp();
    });
  });
}

function issuesSummaryPanel(summary) {
  const rules = summary.byRule.filter((item) => item.count > 0);
  const severity = Object.fromEntries(summary.bySeverity.map((item) => [item.severity, item.count]));
  return `
    <section class="panel">
      <div class="page-head">
        <div>
          <h2>What needs fixing</h2>
          <p class="lede">${summary.open
            ? `${escapeHtml(summary.open)} open issue(s): ${escapeHtml(severity.high || 0)} high, ${escapeHtml(severity.medium || 0)} medium, ${escapeHtml(severity.low || 0)} low.`
            : 'No open issues. Import or sync Entra and your MDM to check again.'}</p>
        </div>
        <button type="button" data-tab-jump="issues">Open inbox</button>
      </div>
      ${rules.length ? `<div class="issue-cards">${rules.map((item) => `
        <button type="button" class="issue-card" data-issue-rule="${escapeHtml(item.ruleKey)}">
          <span class="metric-value">${escapeHtml(item.count)}</span>
          <span class="metric-label">${escapeHtml(item.label)}</span>
        </button>
      `).join('')}</div>` : ''}
    </section>
  `;
}

async function renderIssues() {
  const target = document.querySelector('#tabContent');
  target.innerHTML = '<section class="panel"><p class="muted">Loading…</p></section>';
  const filter = state.issueFilter;
  const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value)).toString();
  const [items, rulesInfo, summary] = await Promise.all([
    api(`/api/exceptions?${query}`),
    api('/api/exceptions/rules'),
    api('/api/exceptions/summary')
  ]);
  if (state.tab !== 'issues') return;
  state.exceptionsSummary = summary;
  const canAct = canWrite();
  const groups = ['high', 'medium', 'low'].map((severity) => [severity, items.filter((item) => item.severity === severity)]);
  target.innerHTML = `
    <section class="panel">
      <div class="page-head">
        <div>
          <h2>Issues</h2>
          <p class="lede">What to fix between your directory, your MDM and the inventory. Nothing here changes Entra or Jamf.</p>
        </div>
        ${canAct ? '<button type="button" id="runScan" class="primary">Re-check now</button>' : ''}
      </div>
      <form id="issueFilters" class="grid">
        <label>Status
          <select name="status">
            ${[['active', 'Open and snoozed'], ['open', 'Open'], ['snoozed', 'Snoozed'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed']]
              .map(([value, label]) => `<option value="${value}" ${filter.status === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        <label>Rule
          <select name="rule">
            <option value="">All rules</option>
            ${rulesInfo.rules.map((rule) => `<option value="${escapeHtml(rule.key)}" ${filter.rule === rule.key ? 'selected' : ''}>${escapeHtml(rule.label)}</option>`).join('')}
          </select>
        </label>
        <label>Severity
          <select name="severity">
            <option value="">All</option>
            ${['high', 'medium', 'low'].map((value) => `<option value="${value}" ${filter.severity === value ? 'selected' : ''}>${value}</option>`).join('')}
          </select>
        </label>
        <label>Assignee
          <select name="assignee">
            <option value="">Anyone</option>
            <option value="${escapeHtml(state.me.user.id)}" ${filter.assignee === state.me.user.id ? 'selected' : ''}>Me</option>
            <option value="unassigned" ${filter.assignee === 'unassigned' ? 'selected' : ''}>Unassigned</option>
          </select>
        </label>
      </form>
      <p id="issueMessage" class="muted" role="status"></p>
    </section>
    ${items.length ? groups.filter(([, list]) => list.length).map(([severity, list]) => `
      <section class="panel">
        <h2><span class="badge severity-${severity}">${severity}</span> ${list.length} issue(s)</h2>
        <ul class="issue-list">
          ${list.map((item) => issueRow(item, canAct)).join('')}
        </ul>
      </section>
    `).join('') : issuesEmptyState(filter, canAct, summary)}
  `;

  document.querySelector('#issueFilters').addEventListener('change', (event) => {
    const form = new FormData(event.currentTarget);
    state.issueFilter = Object.fromEntries(['status', 'rule', 'severity', 'assignee'].map((key) => [key, String(form.get(key) || '')]));
    renderIssues();
  });
  document.querySelector('#runScan')?.addEventListener('click', async () => {
    const result = await api('/api/exceptions/scan', { method: 'POST', body: '{}' });
    await loadData();
    renderApp();
    const message = document.querySelector('#issueMessage');
    if (message) {
      message.textContent = `Checked: ${result.detected} new, ${result.reopened} reopened, ${result.autoResolved} fixed since last check.`;
    }
  });
  document.querySelectorAll('[data-issue-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.issueAction;
      const body = { action };
      if (action === 'snooze') {
        const days = prompt('Snooze for how many days?', '7');
        if (!days) return;
        body.until = new Date(Date.now() + Number(days) * 86_400_000).toISOString();
      }
      if (action === 'resolve' || action === 'dismiss') {
        const note = prompt(action === 'resolve' ? 'What did you do? (optional)' : 'Why is this acceptable? (optional)', '');
        if (note === null) return;
        body.note = note;
      }
      try {
        await api(`/api/exceptions/${button.dataset.issueId}`, { method: 'PATCH', body: JSON.stringify(body) });
        await loadData();
        renderApp();
      } catch (error) {
        const message = document.querySelector('#issueMessage');
        if (message) message.textContent = error.message;
      }
    });
  });
  document.querySelectorAll('[data-issue-open-asset]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.editingAsset = '';
      state.viewingAsset = await api(`/api/assets/${button.dataset.issueOpenAsset}`);
      state.tab = 'assets';
      renderApp();
    });
  });
  document.querySelectorAll('[data-issue-open-person]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.editingPerson = '';
      state.viewingPerson = await api(`/api/people/${button.dataset.issueOpenPerson}/overview`);
      state.tab = 'people';
      renderApp();
    });
  });
}

function issuesEmptyState(filter, canAct, summary) {
  const narrowed = Boolean(filter.rule || filter.severity || filter.assignee || (filter.status && filter.status !== 'active'));
  const openCount = summary?.open ?? 0;
  if (!narrowed && openCount === 0) {
    return `
      <section class="panel empty-state">
        <h2>No open issues</h2>
        <p class="lede">Directory, MDM and inventory agree right now. Import or sync again after changes, or re-check manually.</p>
        ${canAct ? '<p class="muted">Tip: use <strong>Re-check now</strong> after an import if the list looks stale.</p>' : ''}
      </section>
    `;
  }
  return `
    <section class="panel empty-state">
      <h2>Nothing matches these filters</h2>
      <p class="lede">${openCount ? `There ${openCount === 1 ? 'is' : 'are'} still ${openCount} open issue(s) outside this view.` : 'Try clearing a filter or switching Status back to “Open and snoozed”.'}</p>
      <p class="muted">Adjust Status, Rule, Severity or Assignee above.</p>
    </section>
  `;
}

function issueRow(item, canAct) {
  const details = item.details || {};
  const asset = details.asset;
  const person = details.person || details.assignedTo;
  const subject = asset
    ? `${asset.assetTag || asset.serialNumber}${asset.modelName ? ` · ${asset.modelName}` : ''}`
    : (person ? `${person.name || person.email}` : '');
  const facts = [
    person && asset ? `${person.name || person.email}${person.status === 'inactive' ? ' (disabled)' : ''}` : '',
    details.reportedUserEmail ? `MDM user: ${details.reportedUserEmail}` : '',
    details.daysSinceSeen !== undefined ? `last check-in ${details.daysSinceSeen} days ago` : '',
    details.reason === 'same_external_id' ? `same MDM id ${details.externalId} on ${details.assets.length} records` : '',
    details.reason === 'same_person_same_category' ? `${details.assets.length} × ${details.category} on one person` : '',
    item.assigneeName ? `assigned to ${item.assigneeName}` : '',
    item.status === 'snoozed' && item.snoozeUntil ? `snoozed until ${String(item.snoozeUntil).slice(0, 10)}` : '',
    item.resolution ? `closed: ${item.resolution}` : ''
  ].filter(Boolean);
  const open = item.status === 'open' || item.status === 'snoozed';
  return `
    <li class="issue">
      <div>
        <strong>${escapeHtml(item.ruleLabel)}</strong>
        <span class="muted">${escapeHtml(subject)}</span>
        ${facts.length ? `<p class="muted">${facts.map(escapeHtml).join(' · ')}</p>` : ''}
        ${details.suggestion && open ? `<p class="issue-next">Next: ${escapeHtml(details.suggestion)}</p>` : ''}
        <p class="muted">First seen ${escapeHtml(relativeTime(item.firstDetectedAt))}</p>
      </div>
      <div class="row-actions">
        ${asset ? `<button type="button" data-issue-open-asset="${escapeHtml(asset.id)}">Device</button>` : ''}
        ${person?.id ? `<button type="button" data-issue-open-person="${escapeHtml(person.id)}">Person</button>` : ''}
        ${canAct && open ? `
          ${item.assigneeUserId === state.me.user.id ? '' : `<button type="button" data-issue-action="assign" data-issue-id="${item.id}">Assign to me</button>`}
          <button type="button" data-issue-action="snooze" data-issue-id="${item.id}">Snooze</button>
          <button type="button" class="primary" data-issue-action="resolve" data-issue-id="${item.id}">Resolve</button>
          <button type="button" class="ghost" data-issue-action="dismiss" data-issue-id="${item.id}">Dismiss</button>
        ` : ''}
        ${canAct && !open ? `<button type="button" data-issue-action="reopen" data-issue-id="${item.id}">Reopen</button>` : ''}
      </div>
    </li>
  `;
}

function presenceLine(presence = {}, { lastSeenAt = null, personStatus = '' } = {}) {
  const parts = [];
  for (const [source, entry] of Object.entries(presence)) {
    const label = source.charAt(0).toUpperCase() + source.slice(1);
    if (entry && entry.enabled !== undefined) {
      parts.push(`${label}: ${entry.enabled ? 'Active' : 'Disabled'}`);
    } else {
      parts.push(`${label}: seen ${relativeTime(entry?.seenAt || entry?.importedAt)}`);
    }
  }
  if (personStatus && !Object.values(presence).some((entry) => entry?.enabled !== undefined)) {
    parts.push(`Inventory: ${personStatus}`);
  }
  if (lastSeenAt) parts.push(`Last check-in: ${relativeTime(lastSeenAt)}`);
  return parts.length ? parts.join(' · ') : 'Not seen in any connected source yet.';
}

function exceptionsListHtml(list = []) {
  if (!list.length) return '<p class="muted">No open issues.</p>';
  return `<ul class="issue-list compact">${list.map((item) => `
    <li><span class="badge severity-${escapeHtml(item.severity)}">${escapeHtml(item.severity)}</span>
      ${escapeHtml(item.ruleLabel)}${item.details?.suggestion ? ` <span class="muted">— ${escapeHtml(item.details.suggestion)}</span>` : ''}</li>
  `).join('')}</ul>`;
}

function relativeTime(iso) {
  const time = Date.parse(iso || '');
  if (!Number.isFinite(time)) return 'never';
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function metricCard(label, value) {
  return `
    <div class="metric">
      <span class="metric-value">${escapeHtml(value)}</span>
      <span class="metric-label">${escapeHtml(label)}</span>
    </div>
  `;
}

function breakdownList(title, entries) {
  return `
    <div class="breakdown">
      <h3>${escapeHtml(title)}</h3>
      ${entries.length ? `<ul>${entries.map((entry) => `
        <li><span>${escapeHtml(entry.label)}</span><strong>${escapeHtml(entry.count)}</strong></li>
      `).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}
    </div>
  `;
}

async function renderReports() {
  const target = document.querySelector('#tabContent');
  target.innerHTML = '<section class="panel"><p class="muted">Loading…</p></section>';
  const reports = await api('/api/reports');
  if (state.tab !== 'reports') return;
  document.querySelector('#tabContent').innerHTML = `
    <section class="panel">
      <div class="page-head">
        <div>
          <h2>Reports</h2>
          <p class="lede">Every report downloads as CSV for this organization only.</p>
        </div>
        <button type="button" class="primary" data-download="/api/export/assets" data-file="devices.csv">
          Export all devices
        </button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Report</th><th></th></tr></thead>
          <tbody>
            ${reports.map((report) => `
              <tr>
                <td>${escapeHtml(report.label)}</td>
                <td class="row-actions">
                  <button type="button" data-download="/api/reports/${encodeURIComponent(report.id)}"
                          data-file="report-${escapeHtml(report.id)}.csv">Download CSV</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <p id="reportError" class="error" role="alert"></p>
    </section>
  `;
  document.querySelectorAll('[data-download]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await downloadCsv(button.dataset.download, button.dataset.file);
      } catch (error) {
        document.querySelector('#reportError').textContent = error.message;
      }
    });
  });
}

// CSV endpoints authenticate via the HttpOnly session cookie.
async function downloadCsv(path, fileName) {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function renderPeople() {
  document.querySelector('#tabContent').innerHTML = `
    ${canWrite() ? `<section class="panel">
      <div class="page-head">
        <div>
          <h2>People</h2>
          <p class="lede">Add people who can receive devices.</p>
        </div>
        <p class="stat"><strong>${state.people.length}</strong> in directory</p>
      </div>
      <form id="personForm" class="grid">
        <label>First name <input name="firstName" required></label>
        <label>Last name <input name="lastName" required></label>
        <label>Email <input name="email" type="email"></label>
        ${departmentFieldHtml('department')}
        ${customFieldsInputs('person')}
        <div class="actions span-all"><button class="primary" type="submit">Add person</button></div>
      </form>
    </section>` : ''}
    ${canWrite() ? `<section class="panel">
      <h2>Merge duplicates</h2>
      <p class="lede">
        Two exports often create the same colleague twice. Merging moves devices and
        assignment history onto the record you keep and files the other addresses on it.
      </p>
      <form id="mergeForm" class="grid">
        <label>Keep
          <select name="keepId" required>
            <option value="">— Select —</option>
            ${peopleOptions()}
          </select>
        </label>
        <label>Merge into the record above
          <select name="absorbId" required>
            <option value="">— Select —</option>
            ${peopleOptions()}
          </select>
        </label>
        <div class="actions span-all"><button class="primary" type="submit">Merge people</button></div>
      </form>
      <p id="mergeResult" class="muted"></p>
    </section>` : ''}
    <section class="panel">
      ${!canWrite() ? `
        <div class="page-head">
          <h2>People</h2>
          <p class="stat"><strong>${state.people.length}</strong> in directory</p>
        </div>` : ''}
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Department</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${state.people.map((person) => personRow(person)).join('') || '<tr><td colspan="5" class="empty">No people yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>
    ${state.viewingPerson ? personOverviewModal(state.viewingPerson) : ''}
    ${state.editingPerson ? personEditModal(state.people.find((person) => person.id === state.editingPerson)) : ''}
  `;
  document.querySelectorAll('[data-view-person]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.editingPerson = '';
      state.viewingPerson = await api(`/api/people/${button.dataset.viewPerson}/overview`);
      renderApp();
    });
  });
  bindPersonModalChrome();
  document.querySelector('#personForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    body.custom = collectCustomFromBody(body, 'person');
    await api('/api/people', { method: 'POST', body: JSON.stringify(body) });
    await loadData();
    renderApp();
  });
  document.querySelectorAll('[data-edit-person]').forEach((button) => {
    button.addEventListener('click', () => {
      state.viewingPerson = null;
      state.editingPerson = button.dataset.editPerson;
      renderApp();
    });
  });
  document.querySelector('#personEditForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget).entries());
    const custom = collectCustomFromBody(fields, 'person');
    const body = {
      ...fields,
      custom,
      externalIds: {
        upn: fields.upn || '',
        jamfUsername: fields.jamfUsername || '',
        alternateEmails: splitList(fields.alternateEmails)
      }
    };
    delete body.upn;
    delete body.jamfUsername;
    delete body.alternateEmails;
    await api(`/api/people/${state.editingPerson}`, { method: 'PUT', body: JSON.stringify(body) });
    state.editingPerson = '';
    await loadData();
    renderApp();
  });
  document.querySelectorAll('[data-del-person]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('Delete this person? Devices stay in inventory but become unassigned.')) return;
      await api(`/api/people/${button.dataset.delPerson}`, { method: 'DELETE' });
      if (state.viewingPerson?.person?.id === button.dataset.delPerson) state.viewingPerson = null;
      if (state.editingPerson === button.dataset.delPerson) state.editingPerson = '';
      await loadData();
      renderApp();
    });
  });
  document.querySelector('#mergeForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = document.querySelector('#mergeResult');
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const merged = await api('/api/people/merge', { method: 'POST', body: JSON.stringify(body) });
      await loadData();
      renderApp();
      const message = document.querySelector('#mergeResult');
      if (message) {
        message.textContent = `Merged. ${merged.movedAssets} device(s) moved.`;
        message.className = 'ok-text';
      }
    } catch (error) {
      result.textContent = error.message;
      result.className = 'error';
    }
  });
}

function bindPersonModalChrome() {
  const closeView = () => {
    state.viewingPerson = null;
    renderApp();
  };
  const closeEdit = () => {
    state.editingPerson = '';
    renderApp();
  };
  document.querySelectorAll('[data-close-person-view]').forEach((button) => {
    button.addEventListener('click', closeView);
  });
  document.querySelectorAll('[data-close-person-edit]').forEach((button) => {
    button.addEventListener('click', closeEdit);
  });
  document.querySelectorAll('[data-modal-dismiss]').forEach((node) => {
    node.addEventListener('click', (event) => {
      if (event.target !== node) return;
      if (node.dataset.modalDismiss === 'view') closeView();
      if (node.dataset.modalDismiss === 'edit') closeEdit();
    });
  });
}

function personOverviewModal(overview) {
  const { person, assets, exceptions } = overview;
  return `
    <div class="modal-backdrop" data-modal-dismiss="view" role="presentation">
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="personViewTitle">
        <div class="page-head">
          <div>
            <h2 id="personViewTitle">${escapeHtml(`${person.firstName} ${person.lastName}`)}</h2>
            <p class="lede">${escapeHtml([person.email, person.department, person.manager ? `manager ${person.manager}` : ''].filter(Boolean).join(' · '))}</p>
          </div>
          <button type="button" data-close-person-view class="ghost">Close</button>
        </div>
        <p class="presence ${person.status === 'inactive' ? 'presence-warn' : ''}">${escapeHtml(presenceLine(person.sourcePresence, { personStatus: person.status }))}</p>
        <h3>Devices</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Device</th><th>Serial</th><th>Status</th><th>Sources</th></tr></thead>
            <tbody>
              ${assets.map((asset) => `
                <tr>
                  <td>${escapeHtml(asset.modelName || asset.assetTag)}</td>
                  <td>${escapeHtml(asset.serialNumber)}</td>
                  <td>${escapeHtml(statusLabel(asset.status))}</td>
                  <td>${escapeHtml(presenceLine(asset.sourcePresence, { lastSeenAt: asset.lastSeenAt }))}</td>
                </tr>
              `).join('') || '<tr><td colspan="4" class="empty">No devices assigned.</td></tr>'}
            </tbody>
          </table>
        </div>
        <h3>Open issues</h3>
        ${exceptionsListHtml(exceptions)}
      </div>
    </div>
  `;
}

function peopleOptions(selectedId = '') {
  return state.people.map((person) => `
    <option value="${person.id}" ${person.id === selectedId ? 'selected' : ''}>
      ${escapeHtml(person.firstName)} ${escapeHtml(person.lastName)}${person.email ? ` · ${escapeHtml(person.email)}` : ''}
    </option>
  `).join('');
}

function personRow(person) {
  return `
    <tr>
      <td>${escapeHtml(person.firstName)} ${escapeHtml(person.lastName)}</td>
      <td>${escapeHtml(person.email || '')}</td>
      <td>${escapeHtml(person.department || '')}</td>
      <td><span class="badge ${escapeHtml(person.status)}">${escapeHtml(person.status)}</span></td>
      <td class="row-actions">
        <button type="button" data-view-person="${person.id}">View</button>${canWrite() ? `
        <button type="button" data-edit-person="${person.id}">Edit</button>
        <button type="button" class="danger" data-del-person="${person.id}">Delete</button>
      ` : ''}</td>
    </tr>
  `;
}

function personEditModal(person) {
  if (!person) return '';
  return `
    <div class="modal-backdrop" data-modal-dismiss="edit" role="presentation">
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="personEditTitle">
        <div class="page-head">
          <div>
            <h2 id="personEditTitle">Edit person</h2>
            <p class="lede">${escapeHtml(`${person.firstName} ${person.lastName}`)}${person.email ? ` · ${escapeHtml(person.email)}` : ''}</p>
          </div>
          <button type="button" data-close-person-edit class="ghost">Close</button>
        </div>
        <form id="personEditForm" class="grid">
          <label>First name <input name="firstName" value="${escapeHtml(person.firstName)}" required></label>
          <label>Last name <input name="lastName" value="${escapeHtml(person.lastName)}" required></label>
          <label>Email <input name="email" type="email" value="${escapeHtml(person.email || '')}"></label>
          ${departmentFieldHtml('department', person.department || '')}
          <label>Status
            <select name="status">
              ${['active', 'inactive'].map((status) =>
                `<option value="${status}" ${status === person.status ? 'selected' : ''}>${status}</option>`
              ).join('')}
            </select>
          </label>
          <label>UPN <input name="upn" value="${escapeHtml(person.externalIds?.upn || '')}"></label>
          <label>Jamf username <input name="jamfUsername" value="${escapeHtml(person.externalIds?.jamfUsername || '')}"></label>
          <label class="span-all">Alternate emails <span class="hint">comma separated</span>
            <input name="alternateEmails" value="${escapeHtml((person.externalIds?.alternateEmails || []).join(', '))}">
          </label>
          ${customFieldsInputs('person', person.custom || person)}
          <div class="actions span-all">
            <button class="primary" type="submit">Save</button>
            <button type="button" data-close-person-edit>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderAssets() {
  const visible = filteredAssets();
  const categories = [...new Set(state.assets.map((asset) => asset.category).filter(Boolean))].sort();
  document.querySelector('#tabContent').innerHTML = `
    ${canWrite() ? `<section class="panel">
      <div class="page-head">
        <div>
          <h2>Devices</h2>
          <p class="lede">Register hardware and assign it to people.</p>
        </div>
        <p class="stat"><strong>${state.assets.length}</strong> devices</p>
      </div>
      <form id="assetForm" class="grid">
        <label>Asset tag <input name="assetTag" required></label>
        <label>Serial <input name="serialNumber" required></label>
        <label>Model name <input name="modelName"></label>
        <label>Category
          <select name="catalogCategoryId" id="assetCatalogCategory">
            <option value="">— Any —</option>
            ${(state.catalog.categories || []).map((category) => `
              <option value="${category.id}">${escapeHtml(category.name)}</option>
            `).join('')}
          </select>
        </label>
        <label>Brand
          <select name="catalogBrandId" id="assetCatalogBrand">
            <option value="">— Any —</option>
            ${(state.catalog.brands || []).map((brand) => `
              <option value="${brand.id}" data-category="${brand.categoryId}">${escapeHtml(brand.name)}</option>
            `).join('')}
          </select>
        </label>
        <label>Catalog model
          <select name="modelId" id="assetCatalogModel">
            <option value="">— None —</option>
            ${catalogOptions()}
          </select>
        </label>
        <label>Status
          <select name="status">${statusSelectOptions('in_stock')}</select>
        </label>
        ${locationFieldHtml()}
        <label>Category text <input name="category"></label>
        <label>Brand text <input name="brand"></label>
        <label>RAM (GB) <input name="ramGb" type="number" min="0"></label>
        <label>Storage (GB) <input name="storageGb" type="number" min="0"></label>
        <label>Operating system <input name="operatingSystem"></label>
        <label>Warranty ends <input name="warrantyEndsOn" type="date"></label>
        <label>Assign to
          <select name="personId">
            <option value="">— Unassigned —</option>
            ${peopleOptions()}
          </select>
        </label>
        ${customFieldsInputs('asset')}
        <div class="actions span-all">
          <button class="primary" type="submit">Add device</button>
          ${canWrite() ? '<button type="button" id="addCatalogModelBtn">Add model…</button>' : ''}
        </div>
      </form>
    </section>` : ''}
    <section class="panel">
      <div class="page-head">
        <div>
          ${!canWrite() ? '<h2>Devices</h2>' : '<h2>Fleet</h2>'}
          <p class="lede">${visible.length} of ${state.assets.length} devices shown.</p>
        </div>
        <button type="button" data-download="/api/export/assets" data-file="devices.csv">Export CSV</button>
      </div>
      <form id="assetFilters" class="grid">
        <label>Search <span class="hint">tag, serial, model or person</span>
          <input name="search" value="${escapeHtml(state.assetFilter.search)}">
        </label>
        <label>Status
          <select name="status">
            ${statusSelectOptions(state.assetFilter.status, { includeEmpty: true, emptyLabel: 'All' })}
          </select>
        </label>
        <label>Category
          <select name="category">
            <option value="">All</option>
            ${categories.map((category) =>
              `<option value="${escapeHtml(category)}" ${category === state.assetFilter.category ? 'selected' : ''}>${escapeHtml(category)}</option>`
            ).join('')}
          </select>
        </label>
      </form>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Tag</th><th>Serial</th><th>Model</th><th>Assigned to</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${visible.map((asset) => assetRow(asset)).join('') || '<tr><td colspan="6" class="empty">No devices match.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>
    ${state.viewingAsset ? assetDetailModal(state.viewingAsset) : ''}
    ${state.editingAsset ? assetEditModal(state.assets.find((asset) => asset.id === state.editingAsset)) : ''}
  `;
  document.querySelector('#assetForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    delete body.catalogCategoryId;
    delete body.catalogBrandId;
    body.custom = collectCustomFromBody(body, 'asset');
    if (body.personId) body.status = 'assigned';
    await api('/api/assets', { method: 'POST', body: JSON.stringify(body) });
    await loadData();
    renderApp();
  });
  wireCatalogCascade('#assetCatalogCategory', '#assetCatalogBrand', '#assetCatalogModel');
  document.querySelector('#addCatalogModelBtn')?.addEventListener('click', () => promptAddCatalogModel());
  document.querySelector('#assetFilters')?.addEventListener('input', (event) => {
    const form = new FormData(event.currentTarget);
    state.assetFilter = {
      search: String(form.get('search') || ''),
      status: String(form.get('status') || ''),
      category: String(form.get('category') || '')
    };
    renderApp();
    const focused = document.querySelector(`#assetFilters [name="${event.target.name}"]`);
    focused?.focus();
    if (focused?.setSelectionRange && focused.type === 'text') {
      focused.setSelectionRange(focused.value.length, focused.value.length);
    }
  });
  document.querySelectorAll('[data-view-asset]').forEach((button) => {
    button.addEventListener('click', async () => {
      state.editingAsset = '';
      state.viewingAsset = await api(`/api/assets/${button.dataset.viewAsset}`);
      renderApp();
    });
  });
  bindAssetModalChrome();
  document.querySelectorAll('[data-download]').forEach((button) => {
    button.addEventListener('click', () => downloadCsv(button.dataset.download, button.dataset.file));
  });
  document.querySelectorAll('[data-assign-asset]').forEach((select) => {
    select.addEventListener('change', async () => {
      await api(`/api/assets/${select.dataset.assignAsset}`, {
        method: 'PUT',
        body: JSON.stringify({ personId: select.value })
      });
      await loadData();
      renderApp();
    });
  });
  document.querySelectorAll('[data-edit-asset]').forEach((button) => {
    button.addEventListener('click', () => {
      state.viewingAsset = null;
      state.editingAsset = button.dataset.editAsset;
      renderApp();
    });
  });
  document.querySelector('#assetEditForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    body.custom = collectCustomFromBody(body, 'asset');
    await api(`/api/assets/${state.editingAsset}`, { method: 'PUT', body: JSON.stringify(body) });
    state.editingAsset = '';
    await loadData();
    renderApp();
  });
  document.querySelectorAll('[data-del-asset]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('Delete this device from inventory? Assignment history is removed with it.')) return;
      await api(`/api/assets/${button.dataset.delAsset}`, { method: 'DELETE' });
      if (state.viewingAsset?.id === button.dataset.delAsset) state.viewingAsset = null;
      if (state.editingAsset === button.dataset.delAsset) state.editingAsset = '';
      await loadData();
      renderApp();
    });
  });
}

function bindAssetModalChrome() {
  const closeView = () => {
    state.viewingAsset = null;
    renderApp();
  };
  const closeEdit = () => {
    state.editingAsset = '';
    renderApp();
  };
  document.querySelectorAll('[data-close-asset-view]').forEach((button) => {
    button.addEventListener('click', closeView);
  });
  document.querySelectorAll('[data-close-asset-edit]').forEach((button) => {
    button.addEventListener('click', closeEdit);
  });
  document.querySelectorAll('[data-modal-dismiss="asset-view"], [data-modal-dismiss="asset-edit"]').forEach((node) => {
    node.addEventListener('click', (event) => {
      if (event.target !== node) return;
      if (node.dataset.modalDismiss === 'asset-view') closeView();
      if (node.dataset.modalDismiss === 'asset-edit') closeEdit();
    });
  });
}

function assetRow(asset) {
  const personName = [asset.personFirstName, asset.personLastName].filter(Boolean).join(' ');
  return `
    <tr>
      <td>${escapeHtml(asset.assetTag)}</td>
      <td>${escapeHtml(asset.serialNumber)}</td>
      <td>${escapeHtml(asset.modelName || '')}</td>
      <td>${canWrite() ? `
        <select data-assign-asset="${asset.id}">
          <option value="">— Unassigned —</option>
          ${state.people.map((person) => `
            <option value="${person.id}" ${person.id === asset.personId ? 'selected' : ''}>
              ${escapeHtml(person.firstName)} ${escapeHtml(person.lastName)}
            </option>
          `).join('')}
        </select>
      ` : escapeHtml(personName || '—')}</td>
      <td>
        <span class="badge ${escapeHtml(asset.status)}">${escapeHtml(statusLabel(asset.status))}</span>
        ${asset.importMeta?.missingFromLastImport ? '<span class="badge service">missing from MDM</span>' : ''}
      </td>
      <td class="row-actions">
        <button type="button" data-view-asset="${asset.id}">View</button>
        ${canWrite() ? `
          <button type="button" data-edit-asset="${asset.id}">Edit</button>
          <button type="button" class="danger" data-del-asset="${asset.id}">Delete</button>
        ` : ''}
      </td>
    </tr>
  `;
}

function filteredAssets() {
  const search = state.assetFilter.search.trim().toLowerCase();
  return state.assets.filter((asset) => {
    if (state.assetFilter.status && asset.status !== state.assetFilter.status) return false;
    if (state.assetFilter.category && asset.category !== state.assetFilter.category) return false;
    if (!search) return true;
    return [
      asset.assetTag, asset.serialNumber, asset.modelName, asset.brand, asset.category,
      asset.personFirstName, asset.personLastName, asset.personEmail
    ].some((value) => String(value ?? '').toLowerCase().includes(search));
  });
}

function catalogOptions(selectedId = '', { brandId = '', categoryId = '' } = {}) {
  return (state.catalog.models || [])
    .filter((model) => {
      if (brandId && model.brandId !== brandId) return false;
      if (categoryId && model.categoryId !== categoryId) return false;
      return true;
    })
    .map((model) => `
      <option value="${model.id}" data-brand="${model.brandId || ''}" data-category="${model.categoryId || ''}" ${
        model.id === selectedId ? 'selected' : ''
      }>${escapeHtml(model.name)}</option>
    `).join('');
}

function wireCatalogCascade(categorySel, brandSel, modelSel) {
  const category = document.querySelector(categorySel);
  const brand = document.querySelector(brandSel);
  const model = document.querySelector(modelSel);
  if (!category || !brand || !model) return;

  const refreshBrands = () => {
    const categoryId = category.value;
    [...brand.options].forEach((option, index) => {
      if (index === 0) return;
      const match = !categoryId || option.dataset.category === categoryId;
      option.hidden = !match;
      if (!match && option.selected) brand.value = '';
    });
    refreshModels();
  };

  const refreshModels = () => {
    const categoryId = category.value;
    const brandId = brand.value;
    const selected = model.value;
    model.innerHTML = `<option value="">— None —</option>${catalogOptions(selected, { brandId, categoryId })}`;
  };

  category.addEventListener('change', refreshBrands);
  brand.addEventListener('change', refreshModels);
  refreshBrands();
}

async function promptAddCatalogModel() {
  const brandSelect = document.querySelector('#assetCatalogBrand');
  const brandId = brandSelect?.value || '';
  const name = window.prompt('Model name');
  if (!name) return;
  try {
    const body = brandId
      ? { name, brandId }
      : {
          name,
          brand: window.prompt('Brand name') || 'Other',
          category: window.prompt('Category') || 'Other'
        };
    if (!brandId && !body.brand) return;
    await api('/api/catalog/models', { method: 'POST', body: JSON.stringify(body) });
    await loadData();
    renderApp();
  } catch (error) {
    alert(error.message);
  }
}

function assetDetailModal(asset) {
  const fields = [
    ['Serial', asset.serialNumber],
    ['Model', asset.modelName || asset.model?.name],
    ['Category', asset.category],
    ['Brand', asset.brand],
    ['RAM (GB)', asset.ramGb],
    ['Storage (GB)', asset.storageGb],
    ['CPU', asset.cpu],
    ['IMEI', asset.imei],
    ['Operating system', asset.operatingSystem],
    ['Vendor', asset.vendor],
    ['Purchased', asset.purchasedOn],
    ['Warranty ends', asset.warrantyEndsOn],
    ['Enrolled', asset.enrolledAt],
    ['Last enrolled', asset.lastEnrolledAt],
    ['Notes', asset.notes],
    ['Location', locationLabel(asset.locationKey)]
  ].filter(([, value]) => value !== null && value !== undefined && value !== '');
  const externalIds = Object.entries(asset.externalIds || {});
  const customEntries = Object.entries(asset.custom || {});

  return `
    <div class="modal-backdrop" data-modal-dismiss="asset-view" role="presentation">
      <div class="modal-dialog modal-dialog-wide" role="dialog" aria-modal="true" aria-labelledby="assetViewTitle">
        <div class="page-head">
          <div>
            <h2 id="assetViewTitle">${escapeHtml(asset.assetTag)}</h2>
            <p class="lede">${escapeHtml(asset.person
              ? `Assigned to ${asset.person.firstName} ${asset.person.lastName}`
              : 'Unassigned')}</p>
          </div>
          <button type="button" data-close-asset-view class="ghost">Close</button>
        </div>
        <dl class="detail-grid">
          ${fields.map(([label, value]) => `
            <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>
          `).join('')}
          ${customEntries.map(([key, value]) => `
            <div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>
          `).join('')}
        </dl>
        <h3>Sources</h3>
        <p class="presence">${escapeHtml(presenceLine(asset.sourcePresence, { lastSeenAt: asset.lastSeenAt }))}</p>
        <h3>Open issues</h3>
        ${exceptionsListHtml(asset.exceptions)}
        <h3>Identity in other systems</h3>
        ${externalIds.length
          ? `<dl class="detail-grid">${externalIds.map(([key, value]) => `
              <div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>
            `).join('')}</dl>`
          : '<p class="muted">No external ids recorded.</p>'}
        <h3>Import</h3>
        ${asset.importMeta?.source
          ? `<p class="muted">
              ${escapeHtml(asset.importMeta.source)} ·
              last seen ${escapeHtml(String(asset.importMeta.lastImportedAt || '').slice(0, 10))}
              ${asset.importMeta.lastImportFile ? `· ${escapeHtml(asset.importMeta.lastImportFile)}` : ''}
              ${asset.importMeta.missingFromLastImport ? '· <strong>missing from the last import</strong>' : ''}
            </p>`
          : '<p class="muted">Added manually.</p>'}
        <h3>Assignment history</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>From</th><th>To</th><th>Person</th><th>Source</th><th>Reason</th></tr></thead>
            <tbody>
              ${(asset.assignments || []).map((item) => `
                <tr>
                  <td>${escapeHtml(String(item.startedAt || '').slice(0, 10))}</td>
                  <td>${escapeHtml(item.endedAt ? String(item.endedAt).slice(0, 10) : 'open')}</td>
                  <td>${escapeHtml(item.person
                    ? `${item.person.firstName} ${item.person.lastName}`
                    : '—')}</td>
                  <td>${escapeHtml(item.source || '')}</td>
                  <td>${escapeHtml(item.endReason || '')}</td>
                </tr>
              `).join('') || '<tr><td colspan="5" class="empty">Never assigned.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function assetEditModal(asset) {
  if (!asset) return '';
  return `
    <div class="modal-backdrop" data-modal-dismiss="asset-edit" role="presentation">
      <div class="modal-dialog modal-dialog-wide" role="dialog" aria-modal="true" aria-labelledby="assetEditTitle">
        <div class="page-head">
          <div>
            <h2 id="assetEditTitle">Edit device</h2>
            <p class="lede">${escapeHtml(asset.assetTag)} · ${escapeHtml(asset.serialNumber || '')}</p>
          </div>
          <button type="button" data-close-asset-edit class="ghost">Close</button>
        </div>
        <form id="assetEditForm" class="grid">
          <label>Asset tag <input name="assetTag" value="${escapeHtml(asset.assetTag)}" required></label>
          <label>Serial <input name="serialNumber" value="${escapeHtml(asset.serialNumber)}" required></label>
          <label>Model <input name="modelName" value="${escapeHtml(asset.modelName || '')}"></label>
          <label>Catalog model
            ${catalogModelSelect(asset.modelId || '')}
          </label>
          <label>Status
            <select name="status">${statusSelectOptions(asset.status || 'in_stock')}</select>
          </label>
          ${locationFieldHtml(asset.locationKey || '')}
          <label>Category <input name="category" value="${escapeHtml(asset.category || '')}"></label>
          <label>Brand <input name="brand" value="${escapeHtml(asset.brand || '')}"></label>
          <label>RAM (GB) <input name="ramGb" type="number" min="0" value="${escapeHtml(asset.ramGb ?? '')}"></label>
          <label>Storage (GB) <input name="storageGb" type="number" min="0" value="${escapeHtml(asset.storageGb ?? '')}"></label>
          <label>CPU <input name="cpu" value="${escapeHtml(asset.cpu || '')}"></label>
          <label>IMEI <input name="imei" value="${escapeHtml(asset.imei || '')}"></label>
          <label>Operating system <input name="operatingSystem" value="${escapeHtml(asset.operatingSystem || '')}"></label>
          <label>Vendor <input name="vendor" value="${escapeHtml(asset.vendor || '')}"></label>
          <label>Purchased <input name="purchasedOn" type="date" value="${escapeHtml(asset.purchasedOn || '')}"></label>
          <label>Warranty ends <input name="warrantyEndsOn" type="date" value="${escapeHtml(asset.warrantyEndsOn || '')}"></label>
          <label class="span-all">Notes <textarea name="notes" rows="3">${escapeHtml(asset.notes || '')}</textarea></label>
          ${customFieldsInputs('asset', asset.custom || asset)}
          <div class="actions span-all">
            <button class="primary" type="submit">Save</button>
            <button type="button" data-close-asset-edit>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function importSourceOptions(users) {
  const kind = users ? 'users' : 'devices';
  const legacy = users
    ? `
      <option value="auto" ${state.importSource === 'auto' ? 'selected' : ''}>Auto detect</option>
      <option value="entra" ${state.importSource === 'entra' ? 'selected' : ''}>Entra users</option>
      <option value="intune_users" ${state.importSource === 'intune_users' ? 'selected' : ''}>Intune primary users</option>
    `
    : `
      <option value="auto" ${state.importSource === 'auto' ? 'selected' : ''}>Auto detect</option>
      <option value="intune" ${state.importSource === 'intune' ? 'selected' : ''}>Intune</option>
      <option value="jamf" ${state.importSource === 'jamf' ? 'selected' : ''}>Jamf</option>
    `;

  const presets = (state.importPresets || [])
    .filter((preset) => preset.kind === kind)
    .filter((preset) => !['intune', 'jamf', 'entra', 'intune_users'].includes(preset.key));
  const generic = presets.filter((preset) => preset.key === 'generic');
  const other = presets.filter((preset) => preset.key !== 'generic');
  const ordered = [...other, ...generic];

  const profiles = (state.importProfiles || []).filter((profile) => {
    if (!profile.kind) return true;
    return profile.kind === kind;
  });

  return `
    ${legacy}
    ${ordered.length ? `
      <optgroup label="Other MDMs">
        ${ordered.map((preset) => `
          <option value="${escapeHtml(preset.key)}" ${state.importSource === preset.key ? 'selected' : ''}>
            ${escapeHtml(preset.label || preset.key)}
          </option>
        `).join('')}
      </optgroup>
    ` : ''}
    ${profiles.length ? `
      <optgroup label="Saved profiles">
        ${profiles.map((profile) => `
          <option value="profile:${profile.id}" ${state.importSource === `profile:${profile.id}` ? 'selected' : ''}>
            ${escapeHtml(profile.name)}
          </option>
        `).join('')}
      </optgroup>
    ` : ''}
  `;
}

function selectedPresetHowTo() {
  const source = state.importSource || 'auto';
  if (!source || source === 'auto' || source.startsWith('profile:')) return '';
  const preset = (state.importPresets || []).find((item) => item.key === source);
  return preset?.howToExport || '';
}

function renderImport() {
  const preview = state.importPreview;
  const mapping = state.importMapping;
  const users = state.importKind === 'users';
  const howTo = selectedPresetHowTo();
  document.querySelector('#tabContent').innerHTML = `
    <section class="panel">
      <div class="page-head">
        <div>
          <h2>Import ${users ? 'users' : 'devices'}</h2>
          <p class="lede">Preview stays inside ${escapeHtml(state.me.organization.name)} until you apply it.</p>
        </div>
        <div class="actions">
          <button type="button" data-import-kind="devices" class="${users ? '' : 'primary'}">Devices</button>
          <button type="button" data-import-kind="users" class="${users ? 'primary' : ''}">Users</button>
        </div>
      </div>
      <form id="importForm" class="grid">
        <label>Source
          <select name="source" id="importSource">
            ${importSourceOptions(users)}
          </select>
        </label>
        <label>CSV or ZIP file <span class="hint">an Intune export ZIP works as is</span>
          <input name="file" type="file" accept=".csv,.zip,text/csv,application/zip" ${mapping ? '' : 'required'}>
        </label>
        <div class="actions span-all">
          <button class="primary" type="submit">Preview import</button>
        </div>
      </form>
      ${howTo ? `<p class="hint how-to-export">${escapeHtml(howTo)}</p>` : ''}
      <p id="importError" class="error" role="alert"></p>
    </section>
    ${mapping ? renderImportMapping(mapping, users) : ''}
    ${preview && !preview.needsMapping ? renderImportPreview(preview) : ''}
  `;

  document.querySelectorAll('[data-import-kind]').forEach((button) => {
    button.addEventListener('click', () => {
      state.importKind = button.dataset.importKind;
      state.importPreview = null;
      state.importMapping = null;
      state.importModelOverrides = {};
      state.importSource = 'auto';
      lastImportFile = null;
      renderApp();
    });
  });
  document.querySelector('#importSource')?.addEventListener('change', (event) => {
    state.importSource = event.target.value;
    const hint = document.querySelector('.how-to-export');
    const text = selectedPresetHowTo();
    if (text) {
      if (hint) {
        hint.textContent = text;
      } else {
        document.querySelector('#importForm')?.insertAdjacentHTML(
          'afterend',
          `<p class="hint how-to-export">${escapeHtml(text)}</p>`
        );
      }
    } else {
      hint?.remove();
    }
  });
  document.querySelector('#importForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get('file');
    if (file instanceof File && file.size) lastImportFile = file;
    else if (lastImportFile) form.set('file', lastImportFile);
    state.importSource = String(form.get('source') || 'auto');
    try {
      const result = await apiForm(
        users ? '/api/import/users/preview' : '/api/import/preview',
        form
      );
      if (result.needsMapping) {
        state.importMapping = result;
        state.importPreview = null;
      } else {
        state.importMapping = null;
        state.importPreview = result;
        state.importModelOverrides = {};
      }
      renderApp();
    } catch (error) {
      document.querySelector('#importError').textContent = error.message;
    }
  });

  document.querySelector('#mappingContinue')?.addEventListener('click', async () => {
    const errorEl = document.querySelector('#importError');
    if (!lastImportFile) {
      if (errorEl) errorEl.textContent = 'Choose the same CSV/ZIP again to continue with mapping.';
      return;
    }
    const mappingFields = {};
    document.querySelectorAll('[data-map-field]').forEach((select) => {
      if (select.value) mappingFields[select.dataset.mapField] = select.value;
    });
    const saveChecked = document.querySelector('#saveAsProfile')?.checked;
    const saveName = String(document.querySelector('#saveAsProfileName')?.value || '').trim();
    const form = new FormData();
    form.set('file', lastImportFile);
    form.set('source', state.importSource || mapping.source || 'mapped');
    form.set('mapping', JSON.stringify(mappingFields));
    form.set('saveAsProfile', saveChecked ? saveName : '');
    form.set('headerSignature', mapping.headerSignature || '');
    try {
      const result = await apiForm(
        users ? '/api/import/users/preview' : '/api/import/preview',
        form
      );
      if (result.needsMapping) {
        state.importMapping = result;
        state.importPreview = null;
      } else {
        state.importMapping = null;
        state.importPreview = result;
        state.importModelOverrides = {};
        await loadData();
      }
      renderApp();
    } catch (error) {
      if (errorEl) errorEl.textContent = error.message;
    }
  });

  document.querySelector('#selectImportAll')?.addEventListener('click', () => {
    document.querySelectorAll('[data-import-row]:not(:disabled)').forEach((input) => {
      input.checked = true;
    });
  });
  document.querySelectorAll('[data-review-model]').forEach((select) => {
    select.addEventListener('change', () => {
      const rowId = select.dataset.reviewModel;
      const row = preview?.rows?.find((item) => item.id === rowId);
      if (!row) return;
      const modelId = select.value;
      if (!modelId) {
        delete state.importModelOverrides[row.rowKey];
        const checkbox = document.querySelector(`[data-import-row="${rowId}"]`);
        if (checkbox) {
          checkbox.checked = false;
          checkbox.disabled = true;
        }
        return;
      }
      state.importModelOverrides[row.rowKey] = modelId;
      row.modelId = modelId;
      row.modelMatch = 'manual';
      if (row.action === 'needs_review') {
        row.action = row.matchedAssetId ? 'update' : 'create';
      }
      const checkbox = document.querySelector(`[data-import-row="${rowId}"]`);
      if (checkbox) {
        checkbox.disabled = false;
        checkbox.checked = true;
      }
      const badge = select.closest('tr')?.querySelector('.badge');
      if (badge) {
        badge.textContent = row.action;
        badge.className = 'badge assigned';
      }
    });
  });
  document.querySelector('#applyImport')?.addEventListener('click', async () => {
    const includeRowIds = [...document.querySelectorAll('[data-import-row]:checked')]
      .map((input) => input.dataset.importRow);
    const result = await api(
      preview.kind === 'users' ? '/api/import/users/apply' : '/api/import/apply',
      {
        method: 'POST',
        body: JSON.stringify({
          batchId: preview.batchId,
          includeRowIds,
          modelOverrides: state.importModelOverrides
        })
      }
    );
    alert(`Import complete: ${result.summary.created} created, ${result.summary.updated} updated.`);
    state.importPreview = null;
    state.importMapping = null;
    state.importModelOverrides = {};
    await loadData();
    state.tab = preview.kind === 'users' ? 'people' : 'assets';
    renderApp();
  });
}

function renderImportMapping(mapping, users) {
  const suggestion = mapping.suggestion?.mapping || mapping.suggestion || {};
  const fields = mapping.canonicalFields || (users
    ? ['email', 'firstName', 'lastName', 'department', 'role', 'status', 'phone', 'manager', 'location']
    : ['serialNumber', 'assetTag', 'model', 'manufacturer', 'personEmail', 'personName', 'os', 'ram', 'storage', 'cpu', 'imei', 'externalId']);
  const headers = mapping.headers || [];
  const sampleRows = mapping.sampleRows || [];
  return `
    <section class="panel">
      <h2>Map columns</h2>
      <p class="lede">
        This file needs a column map before preview.
        ${mapping.suggestion?.presetKey ? `Suggested preset: ${escapeHtml(mapping.suggestion.presetKey)}.` : ''}
      </p>
      <div class="mapping-grid">
        ${fields.map((field) => {
          const suggested = suggestion[field] || '';
          return `
            <label>${escapeHtml(field)}
              <select data-map-field="${escapeHtml(field)}">
                <option value="">— Skip —</option>
                ${headers.map((header) => `
                  <option value="${escapeHtml(header)}" ${header === suggested ? 'selected' : ''}>
                    ${escapeHtml(header)}
                  </option>
                `).join('')}
              </select>
            </label>
          `;
        }).join('')}
      </div>
      ${sampleRows.length ? `
        <h3>Sample rows</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr>
            </thead>
            <tbody>
              ${sampleRows.map((row) => `
                <tr>${headers.map((header) => `<td>${escapeHtml(row[header] ?? '')}</td>`).join('')}</tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : ''}
      <div class="grid" style="margin-top:1rem">
        <label class="check-inline">
          <input type="checkbox" id="saveAsProfile"> Save as profile
        </label>
        <label>Profile name <input id="saveAsProfileName" placeholder="Kandji export"></label>
        <div class="actions span-all">
          <button type="button" class="primary" id="mappingContinue">Continue with mapping</button>
        </div>
      </div>
    </section>
  `;
}

function renderImportPreview(preview) {
  return `
    <section class="panel">
      <h2>Preview ${escapeHtml(String(preview.source || '').toUpperCase())}</h2>
      <p class="lede">
        ${preview.summary.create} create · ${preview.summary.update} update ·
        ${preview.summary.reassign || 0} reassign · ${preview.summary.needsReview || 0} need review ·
        ${preview.summary.skip} skip · ${preview.summary.warnings} with warnings
      </p>
      <div class="actions">
        <button id="applyImport" class="primary" type="button">Apply selected rows</button>
        <button id="selectImportAll" type="button">Select all valid</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th></th><th>Line</th><th>Action</th>
              ${preview.kind === 'users'
                ? '<th>Email</th><th>Name</th><th>Department</th><th>Match</th>'
                : '<th>Serial</th><th>Asset</th><th>Model</th><th>Match</th><th>Person</th><th>Fix model</th>'}
              <th>Warnings</th>
            </tr>
          </thead>
          <tbody>
            ${preview.rows.map((row) => {
              const overridden = Boolean(state.importModelOverrides[row.rowKey] || (row.modelMatch === 'manual' && row.modelId));
              const selectable = row.action !== 'skip' && (row.action !== 'needs_review' || overridden);
              return `
                <tr>
                  <td><input type="checkbox" data-import-row="${row.id}" ${
                    selectable ? 'checked' : 'disabled'
                  }></td>
                  <td>${escapeHtml(row.line)}</td>
                  <td><span class="badge ${
                    row.action === 'skip' || row.action === 'needs_review' ? 'inactive' : 'assigned'
                  }">${escapeHtml(row.action)}</span></td>
                  ${preview.kind === 'users' ? `
                    <td>${escapeHtml(row.email || '—')}</td>
                    <td>${escapeHtml(row.displayName || `${row.firstName} ${row.lastName}`)}</td>
                    <td>${escapeHtml(row.department || '—')}</td>
                    <td>${escapeHtml(row.personMatch)}</td>
                  ` : `
                    <td>${escapeHtml(row.serialNumber || '—')}</td>
                    <td>${escapeHtml(row.assetTag || '—')}</td>
                    <td>${escapeHtml(row.modelName || '—')}</td>
                    <td>${escapeHtml(row.modelMatch || '—')}</td>
                    <td>${escapeHtml(row.person?.email || '—')}</td>
                    <td>
                      ${row.action === 'needs_review' || overridden ? `
                        <select data-review-model="${row.id}">
                          <option value="">— Pick model —</option>
                          ${catalogOptions(state.importModelOverrides[row.rowKey] || row.modelId || '')}
                        </select>
                      ` : '—'}
                    </td>
                  `}
                  <td>${escapeHtml((row.warnings || []).join('; '))}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

async function renderMembers() {
  const [members, audit] = await Promise.all([
    api('/api/members'),
    api('/api/audit')
  ]);
  state.members = members;
  state.audit = audit;
  const target = document.querySelector('#tabContent');
  if (!target || state.tab !== 'members') return;
  target.innerHTML = `
    ${state.me.role === 'admin' ? `
      <section class="panel">
        <h2>Invite member</h2>
        <p class="lede">Share a link that expires in seven days.</p>
        <form id="inviteForm" class="grid">
          <label>Email <input name="email" type="email" required></label>
          <label>Role
            <select name="role">
              <option value="it">IT</option>
              <option value="readonly">Read-only</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <div class="actions span-all"><button class="primary" type="submit">Create invitation</button></div>
        </form>
        <div id="inviteResult" class="invite-link"></div>
      </section>
    ` : ''}
    <section class="panel">
      <h2>Members</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
          <tbody>
            ${members.map((member) => `
              <tr>
                <td>${escapeHtml(member.name)}</td>
                <td>${escapeHtml(member.email)}</td>
                <td>
                  ${state.me.role === 'admin' ? `
                    <select data-member-role="${member.id}">
                      ${['admin', 'it', 'readonly'].map((role) =>
                        `<option value="${role}" ${role === member.role ? 'selected' : ''}>${role}</option>`
                      ).join('')}
                    </select>
                  ` : escapeHtml(member.role)}
                </td>
                <td class="row-actions">
                  ${state.me.role === 'admin' && member.id !== state.me.user.id
                    ? `<button type="button" class="danger" data-remove-member="${member.id}">Remove</button>`
                    : ''}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </section>
    <section class="panel">
      <h2>Recent audit</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>User</th><th>Action</th><th>Entity</th></tr></thead>
          <tbody>
            ${audit.slice(0, 50).map((item) => `
              <tr>
                <td>${escapeHtml(item.createdAt)}</td>
                <td>${escapeHtml(item.userEmail || 'system')}</td>
                <td>${escapeHtml(item.action)}</td>
                <td>${escapeHtml(item.entityType)} ${escapeHtml(item.entityId || '')}</td>
              </tr>
            `).join('') || '<tr><td colspan="4" class="empty">No audit events.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>
  `;

  document.querySelector('#inviteForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    const invitation = await api('/api/invitations', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    document.querySelector('#inviteResult').innerHTML = `
      <p class="lede" style="margin-top:1rem"><strong>Invitation link (valid 7 days)</strong></p>
      <input value="${escapeHtml(invitation.inviteUrl)}" readonly>
    `;
  });
  document.querySelectorAll('[data-member-role]').forEach((select) => {
    select.addEventListener('change', async () => {
      await api(`/api/members/${select.dataset.memberRole}/role`, {
        method: 'PUT',
        body: JSON.stringify({ role: select.value })
      });
      await renderMembers();
    });
  });
  document.querySelectorAll('[data-remove-member]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/api/members/${button.dataset.removeMember}`, { method: 'DELETE' });
      await renderMembers();
    });
  });
}

async function renderSettings() {
  const canEdit = canMutateSettings();
  const target = document.querySelector('#tabContent');
  if (!target || state.tab !== 'settings') return;

  if (state.settingsTab === 'rules' || state.settingsTab === 'connections') {
    return renderSettingsIntegrations(canEdit);
  }

  let settings = null;
  if (state.settingsTab === 'import-rules') {
    settings = await api('/api/settings');
    if (!target || state.tab !== 'settings') return;
  }

  const tabs = [
    ['catalog', 'Catalog'],
    ['options', 'Options'],
    ['custom-fields', 'Custom fields'],
    ['import-rules', 'Import rules'],
    ['import-profiles', 'Import profiles'],
    ['rules', 'Issue rules'],
    ['connections', 'Connections']
  ];

  target.innerHTML = `
    <section class="panel">
      <div class="page-head">
        <div>
          <h2>Settings</h2>
          <p class="lede">${canEdit ? 'Manage tenant catalog, options and import behaviour.' : 'View tenant catalog, options and import behaviour.'}</p>
        </div>
      </div>
      <div class="settings-tabs" role="tablist" aria-label="Settings sections">
        ${tabs.map(([id, label]) => `
          <button type="button" role="tab" data-settings-tab="${id}" class="${state.settingsTab === id ? 'active' : ''}"
            aria-selected="${state.settingsTab === id ? 'true' : 'false'}">${label}</button>
        `).join('')}
      </div>
    </section>
    ${state.settingsTab === 'catalog' ? renderSettingsCatalog(canEdit) : ''}
    ${state.settingsTab === 'options' ? renderSettingsOptions(canEdit) : ''}
    ${state.settingsTab === 'custom-fields' ? renderSettingsCustomFields(canEdit) : ''}
    ${state.settingsTab === 'import-rules' ? renderSettingsImportRules(settings, canEdit) : ''}
    ${state.settingsTab === 'import-profiles' ? renderSettingsImportProfiles(canEdit) : ''}
  `;

  document.querySelectorAll('[data-settings-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.settingsTab = button.dataset.settingsTab;
      renderApp();
    });
  });

  wireSettingsCatalog(canEdit);
  wireSettingsOptions(canEdit);
  wireSettingsCustomFields(canEdit);
  wireSettingsImportRules(canEdit);
  wireSettingsImportProfiles(canEdit);
}

async function renderSettingsIntegrations(canEdit) {
  const target = document.querySelector('#tabContent');
  const rules = state.settingsTab === 'rules';
  const data = rules ? await api('/api/exceptions/rules') : await api('/api/connections');
  if (state.tab !== 'settings') return;
  const tabs = [
    ['catalog', 'Catalog'], ['options', 'Options'], ['custom-fields', 'Custom fields'],
    ['import-rules', 'Import rules'], ['import-profiles', 'Import profiles'],
    ['rules', 'Issue rules'], ['connections', 'Connections']
  ];
  target.innerHTML = `
    <section class="panel">
      <div class="page-head"><div><h2>Settings</h2></div></div>
      <div class="settings-tabs" role="tablist" aria-label="Settings sections">
        ${tabs.map(([id, label]) => `
          <button type="button" role="tab" data-settings-tab="${id}" class="${state.settingsTab === id ? 'active' : ''}"
            aria-selected="${state.settingsTab === id ? 'true' : 'false'}">${label}</button>
        `).join('')}
      </div>
    </section>
    ${rules ? settingsRulesPanel(data, canEdit) : settingsConnectionsPanel(data, canEdit)}
  `;
  document.querySelectorAll('[data-settings-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.settingsTab = button.dataset.settingsTab;
      renderApp();
    });
  });
  const message = document.querySelector('#integrationMessage');
  document.querySelector('#rulesForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      staleDays: Number(form.get('staleDays')),
      duplicateSameCategoryThreshold: Number(form.get('duplicateSameCategoryThreshold')),
      enabled: Object.fromEntries(data.rules.map((rule) => [rule.key, form.get(`rule:${rule.key}`) === 'on']))
    };
    try {
      const result = await api('/api/exceptions/rules', { method: 'PUT', body: JSON.stringify(body) });
      await loadData();
      message.textContent = `Saved. ${result.scan.open} open issue(s) after re-check.`;
    } catch (error) {
      message.textContent = error.message;
    }
  });
  document.querySelectorAll('[data-connect]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api(`/api/connections/${button.dataset.connect}`, { method: 'PUT', body: '{}' });
        renderSettingsIntegrations(canEdit);
      } catch (error) {
        message.textContent = error.message;
      }
    });
  });
  document.querySelectorAll('[data-credentials-form]').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const providerKey = form.dataset.credentialsForm;
      const body = Object.fromEntries(new FormData(form).entries());
      const credentials = {};
      for (const [key, value] of Object.entries(body)) {
        const trimmed = String(value || '').trim();
        if (trimmed) credentials[key] = trimmed;
      }
      if (!Object.keys(credentials).length) {
        message.textContent = 'Enter at least one credential field.';
        return;
      }
      try {
        await api(`/api/connections/${providerKey}`, {
          method: 'PUT',
          body: JSON.stringify({ credentials })
        });
        message.textContent = 'Credentials saved.';
        await renderSettingsIntegrations(canEdit);
      } catch (error) {
        message.textContent = error.message;
      }
    });
  });
  document.querySelectorAll('[data-disconnect]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!confirm('Disconnect this source? Imported data stays.')) return;
      await api(`/api/connections/${button.dataset.disconnect}`, { method: 'DELETE' });
      renderSettingsIntegrations(canEdit);
    });
  });
  document.querySelectorAll('[data-sync]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await api(`/api/connections/${button.dataset.sync}/sync`, { method: 'POST', body: '{}' });
        await loadData();
        await renderSettingsIntegrations(canEdit);
        const note = document.querySelector('#integrationMessage');
        if (note) {
          note.textContent = `Synced. Users ${result.users?.created || 0} new / ${result.users?.updated || 0} updated; devices ${result.devices?.created || 0} new / ${result.devices?.updated || 0} updated; ${result.exceptions?.open ?? 0} open issue(s).`;
        }
      } catch (error) {
        message.textContent = error.message;
        button.disabled = false;
      }
    });
  });
}

function settingsRulesPanel(data, canEdit) {
  const { rules, settings } = data;
  return `
    <section class="panel">
      <h2>Issue rules</h2>
      <p class="lede">Which checks run after every import or sync. Changing them re-checks immediately.</p>
      <form id="rulesForm" class="grid">
        <label>Stale after (days)
          <input name="staleDays" type="number" min="1" value="${escapeHtml(settings.staleDays)}" ${canEdit ? '' : 'disabled'}>
        </label>
        <label>Flag a person with this many devices of one category
          <input name="duplicateSameCategoryThreshold" type="number" min="2" value="${escapeHtml(settings.duplicateSameCategoryThreshold)}" ${canEdit ? '' : 'disabled'}>
        </label>
        <div class="span-all rule-list">
          ${rules.map((rule) => `
            <label class="checkbox">
              <input type="checkbox" name="rule:${escapeHtml(rule.key)}" ${settings.enabled[rule.key] ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
              <span><strong>${escapeHtml(rule.label)}</strong> <span class="badge severity-${escapeHtml(rule.severity)}">${escapeHtml(rule.severity)}</span><br>
              <span class="muted">${escapeHtml(rule.suggestion)}</span></span>
            </label>
          `).join('')}
        </div>
        ${canEdit ? '<div class="actions span-all"><button class="primary" type="submit">Save rules</button></div>' : ''}
      </form>
      <p id="integrationMessage" class="muted" role="status"></p>
    </section>
  `;
}

function settingsConnectionsPanel(data, canEdit) {
  const canSync = canWrite();
  const canStore = Boolean(data.canStoreCredentials);
  return `
    <section class="panel">
      <h2>Connections</h2>
      <p class="lede">Read-only connections to your directory and MDM. The app never asks for admin passwords and never changes Entra or Jamf.</p>
      ${!canStore && canEdit ? '<p class="muted">Set <code>SAAS_CONNECTOR_KEY</code> on the server before saving live connector credentials.</p>' : ''}
      <p id="integrationMessage" class="muted" role="status"></p>
      <ul class="issue-list">
        ${data.providers.map((provider) => {
          const connection = provider.connection;
          const hasCredentials = Boolean(connection?.hasCredentials);
          const canLiveSync = provider.live && hasCredentials && canSync;
          const showCredentialForm = provider.live && canEdit && canStore && provider.credentialFields?.length;
          return `
            <li class="issue connection-card">
              <div>
                <strong>${escapeHtml(provider.label)}</strong>
                <span class="muted">${escapeHtml(provider.datasets.join(' + '))}</span>
                ${provider.live
                  ? `<p class="muted">Permissions: ${escapeHtml(provider.requiredScopes.join(', '))}. ${escapeHtml(provider.auth)}</p>`
                  : '<p class="muted">Fills this organization with sample Entra users and Jamf Macs so every issue type shows up.</p>'}
                ${connection ? `<p class="muted">Status: ${escapeHtml(connection.status)}${hasCredentials ? ' · credentials saved' : ''}${connection.lastSyncAt ? ` · last sync ${escapeHtml(relativeTime(connection.lastSyncAt))}` : ''}${connection.lastError ? ` · ${escapeHtml(connection.lastError)}` : ''}</p>` : ''}
                ${showCredentialForm ? connectionCredentialsForm(provider, hasCredentials) : ''}
              </div>
              <div class="row-actions">
                ${!provider.live && canEdit && !connection ? `<button type="button" data-connect="${escapeHtml(provider.key)}">Connect</button>` : ''}
                ${(!provider.live && connection && canSync) || canLiveSync
                  ? `<button type="button" class="primary" data-sync="${escapeHtml(provider.key)}">Sync now</button>`
                  : ''}
                ${connection && canEdit ? `<button type="button" class="ghost" data-disconnect="${escapeHtml(provider.key)}">Disconnect</button>` : ''}
              </div>
            </li>
          `;
        }).join('')}
      </ul>
    </section>
  `;
}

function connectionCredentialsForm(provider, hasCredentials) {
  const fields = provider.credentialFields || [];
  const optional = new Set(provider.optionalCredentialFields || []);
  const labels = {
    tenantId: 'Directory (tenant) ID',
    clientId: 'Application (client) ID',
    clientSecret: 'Client secret',
    baseUrl: 'API base URL',
    apiKey: 'API key',
    apiToken: 'API token',
    accessToken: 'Access token',
    tenantCode: 'Tenant code (aw-tenant-code)',
    customerId: 'Google customer ID',
    clientEmail: 'Service account email',
    privateKey: 'Service account private key',
    subject: 'Impersonate admin email (domain-wide delegation)'
  };
  return `
    <form class="connection-credentials grid" data-credentials-form="${escapeHtml(provider.key)}">
      ${fields.map((field) => {
        const isSecret = field === 'clientSecret' || field === 'apiKey' || field === 'apiToken'
          || field === 'accessToken' || field === 'privateKey';
        const isOptional = optional.has(field) || (isSecret && hasCredentials);
        const isWide = isSecret || field === 'baseUrl' || field === 'privateKey' || field === 'subject';
        return `
        <label class="${isWide ? 'span-all' : ''}">${escapeHtml(labels[field] || field)}${optional.has(field) ? ' <span class="hint">optional</span>' : ''}
          <${field === 'privateKey' ? 'textarea' : 'input'} name="${escapeHtml(field)}" ${
            field === 'privateKey'
              ? `rows="4" autocomplete="off"${isOptional ? '' : ' required'}`
              : `${isSecret ? 'type="password" autocomplete="off"' : 'type="text" autocomplete="off"'} ${
                isOptional ? '' : 'required'
              } placeholder="${hasCredentials && isSecret ? 'Leave blank to keep current value' : ''}"`
          }>${field === 'privateKey' ? '</textarea>' : ''}
        </label>`;
      }).join('')}
      <div class="actions span-all">
        <button class="primary" type="submit">${hasCredentials ? 'Update credentials' : 'Save credentials'}</button>
      </div>
    </form>
  `;
}

function renderSettingsCatalog(canEdit) {
  const categories = state.catalog.categories || [];
  const brands = state.catalog.brands || [];
  const models = state.catalog.models || [];
  return `
    <section class="panel">
      <h2>Catalog</h2>
      <p class="lede">${models.length} models across ${brands.length} brands in ${categories.length} categories.</p>
      <div class="catalog-tree">
        ${categories.map((category) => {
          const categoryBrands = brands.filter((brand) => brand.categoryId === category.id);
          return `
            <div class="catalog-node catalog-category">
              <div class="catalog-row">
                <strong>${escapeHtml(category.name)}</strong>
                ${canEdit ? `
                  <span class="row-actions">
                    <button type="button" data-rename-category="${category.id}" data-name="${escapeHtml(category.name)}">Rename</button>
                    <button type="button" class="danger" data-archive-category="${category.id}">Archive</button>
                  </span>
                ` : ''}
              </div>
              ${categoryBrands.map((brand) => {
                const brandModels = models.filter((model) => model.brandId === brand.id);
                return `
                  <div class="catalog-node catalog-brand">
                    <div class="catalog-row">
                      <span>${escapeHtml(brand.name)}</span>
                      ${canEdit ? `
                        <span class="row-actions">
                          <button type="button" data-rename-brand="${brand.id}" data-name="${escapeHtml(brand.name)}">Rename</button>
                          <button type="button" class="danger" data-archive-brand="${brand.id}">Archive</button>
                        </span>
                      ` : ''}
                    </div>
                    <ul class="catalog-models">
                      ${brandModels.map((model) => `
                        <li class="catalog-row">
                          <span>${escapeHtml(model.name)}${model.generation && model.generation !== 'Standard' ? ` <span class="muted">(${escapeHtml(model.generation)})</span>` : ''}</span>
                          ${canEdit ? `
                            <span class="row-actions">
                              <button type="button" data-edit-model="${model.id}">Edit</button>
                              <button type="button" class="danger" data-archive-model="${model.id}">Archive</button>
                            </span>
                          ` : ''}
                        </li>
                      `).join('') || '<li class="muted">No models</li>'}
                    </ul>
                  </div>
                `;
              }).join('') || '<p class="muted">No brands in this category.</p>'}
            </div>
          `;
        }).join('') || '<p class="muted">Catalog is empty.</p>'}
      </div>
      ${canEdit ? `
        <h3>Add category</h3>
        <form id="catalogCategoryForm" class="grid">
          <label>Name <input name="name" required placeholder="Laptop"></label>
          <div class="actions span-all"><button class="primary" type="submit">Add category</button></div>
        </form>
        <h3>Add brand</h3>
        <form id="catalogBrandForm" class="grid">
          <label>Category
            <select name="categoryId" required>
              <option value="">— Select —</option>
              ${categories.map((category) => `
                <option value="${category.id}">${escapeHtml(category.name)}</option>
              `).join('')}
            </select>
          </label>
          <label>Name <input name="name" required placeholder="Lenovo"></label>
          <div class="actions span-all"><button class="primary" type="submit">Add brand</button></div>
        </form>
        <h3>Add model</h3>
        <form id="catalogModelForm" class="grid">
          <label>Model name <input name="name" required placeholder="ThinkPad T14 Gen 6"></label>
          <label>Brand
            <select name="brandId">
              <option value="">— Or type brand below —</option>
              ${brands.map((brand) => `
                <option value="${brand.id}">${escapeHtml(brand.name)}</option>
              `).join('')}
            </select>
          </label>
          <label>Brand name <input name="brand" placeholder="Lenovo"></label>
          <label>Category <input name="category" placeholder="Laptop"></label>
          <label>Generation <input name="generation" placeholder="Standard"></label>
          <label>Aliases <span class="hint">comma separated</span> <input name="aliases"></label>
          <div class="actions span-all"><button class="primary" type="submit">Add model</button></div>
        </form>
        <div class="actions" style="margin-top:1rem">
          <button type="button" id="catalogResetDefaults">Reset missing defaults</button>
        </div>
        <p id="catalogResult" class="muted"></p>
      ` : ''}
    </section>
  `;
}

function renderSettingsOptions(canEdit) {
  const kinds = [
    ['status', 'Statuses'],
    ['department', 'Departments'],
    ['location', 'Locations']
  ];
  return `
    <section class="panel">
      <h2>Options</h2>
      <p class="lede">Statuses, departments and locations used across devices and people.</p>
      ${kinds.map(([kind, title]) => `
        <h3>${title}</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Label</th>
                ${kind === 'status' ? '<th>Counts as</th>' : '<th>Key</th>'}
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${(state.options[kind] || []).map((opt) => `
                <tr>
                  <td>${escapeHtml(opt.label)}</td>
                  <td>${kind === 'status'
                    ? escapeHtml(opt.meta?.countsAs || 'other')
                    : escapeHtml(opt.key)}</td>
                  <td class="row-actions">
                    ${canEdit ? `
                      <button type="button" data-rename-option="${kind}:${opt.id}" data-label="${escapeHtml(opt.label)}" data-counts="${escapeHtml(opt.meta?.countsAs || 'other')}">Edit</button>
                      <button type="button" class="danger" data-delete-option="${kind}:${opt.id}">Archive</button>
                    ` : ''}
                  </td>
                </tr>
              `).join('') || `<tr><td colspan="3" class="empty">No ${title.toLowerCase()} yet.</td></tr>`}
            </tbody>
          </table>
        </div>
        ${canEdit ? `
          <form class="grid option-add-form" data-option-kind="${kind}">
            <label>Label <input name="label" required></label>
            ${kind === 'status' ? `
              <label>Counts as
                <select name="countsAs">
                  ${['in_stock', 'assigned', 'retired', 'other'].map((value) =>
                    `<option value="${value}">${value}</option>`
                  ).join('')}
                </select>
              </label>
            ` : ''}
            <div class="actions span-all"><button class="primary" type="submit">Add ${title.slice(0, -1).toLowerCase()}</button></div>
          </form>
        ` : ''}
      `).join('')}
      <p id="optionsResult" class="muted"></p>
    </section>
  `;
}

function renderSettingsCustomFields(canEdit) {
  const entity = state.customFieldsEntity || 'asset';
  const fields = state.customFields[entity] || [];
  return `
    <section class="panel">
      <h2>Custom fields</h2>
      <p class="lede">Extra fields collected on ${entity === 'asset' ? 'devices' : 'people'}.</p>
      <label>Entity
        <select id="customFieldsEntity">
          <option value="asset" ${entity === 'asset' ? 'selected' : ''}>Devices</option>
          <option value="person" ${entity === 'person' ? 'selected' : ''}>People</option>
        </select>
      </label>
      <div class="table-wrap" style="margin-top:1rem">
        <table>
          <thead><tr><th>Label</th><th>Key</th><th>Type</th><th>Required</th><th></th></tr></thead>
          <tbody>
            ${fields.map((field) => `
              <tr>
                <td>${escapeHtml(field.label)}</td>
                <td>${escapeHtml(field.key)}</td>
                <td>${escapeHtml(field.type)}</td>
                <td>${field.required ? 'yes' : 'no'}</td>
                <td class="row-actions">
                  ${canEdit ? `
                    <button type="button" data-edit-custom-field="${field.id}">Edit</button>
                    <button type="button" class="danger" data-delete-custom-field="${field.id}">Archive</button>
                  ` : ''}
                </td>
              </tr>
            `).join('') || '<tr><td colspan="5" class="empty">No custom fields.</td></tr>'}
          </tbody>
        </table>
      </div>
      ${canEdit ? `
        <h3>Add field</h3>
        <form id="customFieldForm" class="grid">
          <label>Label <input name="label" required></label>
          <label>Key <span class="hint">optional</span> <input name="key" placeholder="auto from label"></label>
          <label>Type
            <select name="type">
              ${['text', 'number', 'date', 'select', 'boolean'].map((type) =>
                `<option value="${type}">${type}</option>`
              ).join('')}
            </select>
          </label>
          <label>Options <span class="hint">comma separated, for select</span> <input name="options"></label>
          <label class="check-inline"><input type="checkbox" name="required" value="true"> Required</label>
          <div class="actions span-all"><button class="primary" type="submit">Add field</button></div>
        </form>
        <p id="customFieldsResult" class="muted"></p>
      ` : ''}
    </section>
  `;
}

function renderSettingsImportRules(settings, canEdit) {
  const readonlyAttr = canEdit ? '' : 'readonly';
  return `
    <section class="panel">
      <h2>Import rules</h2>
      <p class="lede">
        These rules decide who an Intune, Jamf or Entra import may create, which
        addresses belong to the same colleague, and which model a stubborn serial
        should map to. Each organization has its own set.
      </p>
      <form id="settingsForm" class="grid">
        <label class="span-all">Excluded emails <span class="hint">one per line</span>
          <textarea name="excludedEmails" rows="5" ${readonlyAttr}>${escapeHtml((settings.excludedEmails || []).join('\n'))}</textarea>
        </label>
        <label class="span-all">Excluded name rules <span class="hint">one rule per line, tokens separated by commas; a person is skipped when every token appears in their name</span>
          <textarea name="excludedNameRules" rows="4" ${readonlyAttr}>${escapeHtml(
            (settings.excludedNameRules || []).map((rule) => (rule.tokens || []).join(', ')).join('\n')
          )}</textarea>
        </label>
        <label class="span-all">Identity groups <span class="hint">one per line: email1, email2 = First Last</span>
          <textarea name="identityGroups" rows="4" ${readonlyAttr}>${escapeHtml(
            (settings.identityGroups || []).map((group) => {
              const name = [group.firstName, group.lastName].filter(Boolean).join(' ');
              return `${(group.emails || []).join(', ')}${name ? ` = ${name}` : ''}`;
            }).join('\n')
          )}</textarea>
        </label>
        <label class="span-all">Model overrides <span class="hint">one per line: serial = catalog model id</span>
          <textarea name="modelOverrides" rows="4" ${readonlyAttr}>${escapeHtml(
            Object.entries(settings.modelOverrides || {}).map(([serial, modelId]) => `${serial} = ${modelId}`).join('\n')
          )}</textarea>
        </label>
        ${canEdit ? '<div class="actions span-all"><button class="primary" type="submit">Save settings</button></div>' : ''}
      </form>
      <p id="settingsResult" class="muted"></p>
    </section>
  `;
}

function renderSettingsImportProfiles(canEdit) {
  const profiles = state.importProfiles || [];
  return `
    <section class="panel">
      <h2>Import profiles</h2>
      <p class="lede">Saved column maps for recurring MDM exports.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Preset</th><th>Updated</th><th></th></tr></thead>
          <tbody>
            ${profiles.map((profile) => `
              <tr>
                <td>${escapeHtml(profile.name)}</td>
                <td>${escapeHtml(profile.presetKey || 'mapped')}</td>
                <td>${escapeHtml(String(profile.updatedAt || '').slice(0, 10))}</td>
                <td class="row-actions">
                  ${canEdit ? `
                    <button type="button" data-rename-profile="${profile.id}" data-name="${escapeHtml(profile.name)}">Rename</button>
                    <button type="button" class="danger" data-delete-profile="${profile.id}">Delete</button>
                  ` : ''}
                </td>
              </tr>
            `).join('') || '<tr><td colspan="4" class="empty">No saved profiles yet.</td></tr>'}
          </tbody>
        </table>
      </div>
      <p id="profilesResult" class="muted"></p>
    </section>
  `;
}

function wireSettingsCatalog(canEdit) {
  if (!canEdit) return;
  const result = () => document.querySelector('#catalogResult');
  const reload = async (message) => {
    await loadData();
    renderApp();
    const el = document.querySelector('#catalogResult');
    if (el && message) {
      el.textContent = message;
      el.className = 'ok-text';
    }
  };

  document.querySelector('#catalogCategoryForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await api('/api/catalog/categories', { method: 'POST', body: JSON.stringify(body) });
      await reload('Category added.');
    } catch (error) {
      const el = result();
      if (el) { el.textContent = error.message; el.className = 'error'; }
    }
  });

  document.querySelector('#catalogBrandForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await api('/api/catalog/brands', { method: 'POST', body: JSON.stringify(body) });
      await reload('Brand added.');
    } catch (error) {
      const el = result();
      if (el) { el.textContent = error.message; el.className = 'error'; }
    }
  });

  document.querySelector('#catalogModelForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget).entries());
    const body = {
      name: fields.name,
      aliases: splitList(fields.aliases),
      generation: fields.generation || undefined
    };
    if (fields.brandId) body.brandId = fields.brandId;
    else {
      body.brand = fields.brand;
      body.category = fields.category;
    }
    try {
      const model = await api('/api/catalog/models', { method: 'POST', body: JSON.stringify(body) });
      await reload(`Added ${model.name}.`);
    } catch (error) {
      const el = result();
      if (el) { el.textContent = error.message; el.className = 'error'; }
    }
  });

  document.querySelector('#catalogResetDefaults')?.addEventListener('click', async () => {
    try {
      await api('/api/catalog/reset-defaults', { method: 'POST', body: '{}' });
      await reload('Defaults restored where missing.');
    } catch (error) {
      const el = result();
      if (el) { el.textContent = error.message; el.className = 'error'; }
    }
  });

  document.querySelectorAll('[data-rename-category]').forEach((button) => {
    button.addEventListener('click', async () => {
      const name = window.prompt('Category name', button.dataset.name);
      if (!name) return;
      await api(`/api/catalog/categories/${button.dataset.renameCategory}`, {
        method: 'PATCH',
        body: JSON.stringify({ name })
      });
      await reload('Category updated.');
    });
  });
  document.querySelectorAll('[data-archive-category]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.confirm('Archive this category?')) return;
      await api(`/api/catalog/categories/${button.dataset.archiveCategory}`, { method: 'DELETE' });
      await reload('Category archived.');
    });
  });
  document.querySelectorAll('[data-rename-brand]').forEach((button) => {
    button.addEventListener('click', async () => {
      const name = window.prompt('Brand name', button.dataset.name);
      if (!name) return;
      await api(`/api/catalog/brands/${button.dataset.renameBrand}`, {
        method: 'PATCH',
        body: JSON.stringify({ name })
      });
      await reload('Brand updated.');
    });
  });
  document.querySelectorAll('[data-archive-brand]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.confirm('Archive this brand?')) return;
      await api(`/api/catalog/brands/${button.dataset.archiveBrand}`, { method: 'DELETE' });
      await reload('Brand archived.');
    });
  });
  document.querySelectorAll('[data-edit-model]').forEach((button) => {
    button.addEventListener('click', async () => {
      const model = (state.catalog.models || []).find((item) => item.id === button.dataset.editModel);
      if (!model) return;
      const name = window.prompt('Model name', model.name);
      if (!name) return;
      const generation = window.prompt('Generation', model.generation || 'Standard') || 'Standard';
      const aliases = splitList(window.prompt('Aliases (comma separated)', (model.aliases || []).join(', ')) || '');
      await api(`/api/catalog/models/${model.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name, generation, aliases })
      });
      await reload('Model updated.');
    });
  });
  document.querySelectorAll('[data-archive-model]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.confirm('Archive this model?')) return;
      await api(`/api/catalog/models/${button.dataset.archiveModel}`, { method: 'DELETE' });
      await reload('Model archived.');
    });
  });
}

function wireSettingsOptions(canEdit) {
  if (state.settingsTab !== 'options') return;
  const result = () => document.querySelector('#optionsResult');
  const reload = async (message) => {
    await loadData();
    renderApp();
    const el = document.querySelector('#optionsResult');
    if (el && message) {
      el.textContent = message;
      el.className = 'ok-text';
    }
  };

  document.querySelectorAll('.option-add-form').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!canEdit) return;
      const kind = form.dataset.optionKind;
      const fields = Object.fromEntries(new FormData(form).entries());
      const body = { label: fields.label };
      if (kind === 'status') body.meta = { countsAs: fields.countsAs || 'other' };
      try {
        await api(`/api/options/${kind}`, { method: 'POST', body: JSON.stringify(body) });
        await reload('Option added.');
      } catch (error) {
        const el = result();
        if (el) { el.textContent = error.message; el.className = 'error'; }
      }
    });
  });

  if (!canEdit) return;

  document.querySelectorAll('[data-rename-option]').forEach((button) => {
    button.addEventListener('click', async () => {
      const [kind, id] = button.dataset.renameOption.split(':');
      const label = window.prompt('Label', button.dataset.label);
      if (!label) return;
      const body = { label };
      if (kind === 'status') {
        const countsAs = window.prompt('Counts as (in_stock|assigned|retired|other)', button.dataset.counts || 'other');
        body.meta = { countsAs: countsAs || 'other' };
      }
      await api(`/api/options/${kind}/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      await reload('Option updated.');
    });
  });
  document.querySelectorAll('[data-delete-option]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.confirm('Archive this option?')) return;
      const [kind, id] = button.dataset.deleteOption.split(':');
      await api(`/api/options/${kind}/${id}`, { method: 'DELETE' });
      await reload('Option archived.');
    });
  });
}

function wireSettingsCustomFields(canEdit) {
  if (state.settingsTab !== 'custom-fields') return;
  document.querySelector('#customFieldsEntity')?.addEventListener('change', (event) => {
    state.customFieldsEntity = event.target.value;
    renderApp();
  });
  if (!canEdit) return;

  const reload = async (message) => {
    await loadData();
    renderApp();
    const el = document.querySelector('#customFieldsResult');
    if (el && message) {
      el.textContent = message;
      el.className = 'ok-text';
    }
  };

  document.querySelector('#customFieldForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await api('/api/custom-fields', {
        method: 'POST',
        body: JSON.stringify({
          entity: state.customFieldsEntity || 'asset',
          label: fields.label,
          key: fields.key || undefined,
          type: fields.type,
          options: splitList(fields.options),
          required: fields.required === 'true'
        })
      });
      await reload('Field added.');
    } catch (error) {
      const el = document.querySelector('#customFieldsResult');
      if (el) { el.textContent = error.message; el.className = 'error'; }
    }
  });

  document.querySelectorAll('[data-edit-custom-field]').forEach((button) => {
    button.addEventListener('click', async () => {
      const entity = state.customFieldsEntity || 'asset';
      const field = (state.customFields[entity] || []).find((item) => item.id === button.dataset.editCustomField);
      if (!field) return;
      const label = window.prompt('Label', field.label);
      if (!label) return;
      const type = window.prompt('Type (text|number|date|select|boolean)', field.type) || field.type;
      const options = type === 'select'
        ? splitList(window.prompt('Options (comma separated)', (field.options || []).join(', ')) || '')
        : field.options || [];
      const required = window.confirm('Required field? OK = yes, Cancel = no');
      await api(`/api/custom-fields/${field.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ label, type, options, required })
      });
      await reload('Field updated.');
    });
  });
  document.querySelectorAll('[data-delete-custom-field]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.confirm('Archive this custom field?')) return;
      await api(`/api/custom-fields/${button.dataset.deleteCustomField}`, { method: 'DELETE' });
      await reload('Field archived.');
    });
  });
}

function wireSettingsImportRules(canEdit) {
  if (state.settingsTab !== 'import-rules') return;
  document.querySelector('#settingsForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!canEdit) return;
    const form = new FormData(event.currentTarget);
    const result = document.querySelector('#settingsResult');
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          excludedEmails: splitList(form.get('excludedEmails'), /[\n,;]+/),
          excludedNameRules: splitLines(form.get('excludedNameRules')).map((line, index) => ({
            id: `rule-${index + 1}`,
            tokens: splitList(line)
          })),
          identityGroups: splitLines(form.get('identityGroups')).map((line) => {
            const [emails, name = ''] = line.split('=');
            const [firstName = '', ...rest] = name.trim().split(/\s+/);
            return { emails: splitList(emails), firstName, lastName: rest.join(' ') };
          }),
          modelOverrides: Object.fromEntries(
            splitLines(form.get('modelOverrides'))
              .map((line) => line.split('=').map((part) => part.trim()))
              .filter(([serial, modelId]) => serial && modelId)
              .map(([serial, modelId]) => [serial.toLowerCase(), modelId])
          )
        })
      });
      result.textContent = 'Saved.';
      result.className = 'ok-text';
    } catch (error) {
      result.textContent = error.message;
      result.className = 'error';
    }
  });
}

function wireSettingsImportProfiles(canEdit) {
  if (state.settingsTab !== 'import-profiles' || !canEdit) return;
  const reload = async (message) => {
    await loadData();
    renderApp();
    const el = document.querySelector('#profilesResult');
    if (el && message) {
      el.textContent = message;
      el.className = 'ok-text';
    }
  };
  document.querySelectorAll('[data-rename-profile]').forEach((button) => {
    button.addEventListener('click', async () => {
      const name = window.prompt('Profile name', button.dataset.name);
      if (!name) return;
      await api(`/api/import/profiles/${button.dataset.renameProfile}`, {
        method: 'PATCH',
        body: JSON.stringify({ name })
      });
      await reload('Profile renamed.');
    });
  });
  document.querySelectorAll('[data-delete-profile]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!window.confirm('Delete this import profile?')) return;
      await api(`/api/import/profiles/${button.dataset.deleteProfile}`, { method: 'DELETE' });
      await reload('Profile deleted.');
    });
  });
}

function splitLines(value) {
  return String(value || '').split('\n').map((line) => line.trim()).filter(Boolean);
}

function splitList(value, separator = /[,;]+/) {
  return String(value || '').split(separator).map((item) => item.trim()).filter(Boolean);
}

function renderAccount() {
  const organizationName = state.me.organization?.name || '';
  document.querySelector('#tabContent').innerHTML = `
    <section class="panel">
      <h2>Change password</h2>
      <p class="lede">Changing it signs out every other device immediately.</p>
      <form id="passwordForm" class="grid">
        <label>Current password <input name="currentPassword" type="password" required autocomplete="current-password"></label>
        <label>New password <input name="newPassword" type="password" minlength="8" required autocomplete="new-password"></label>
        <div class="actions span-all"><button class="primary" type="submit">Change password</button></div>
      </form>
      <p id="passwordResult" class="muted"></p>
    </section>
    ${state.me.role === 'admin' ? `
      <section class="panel">
        <h2>Delete organization</h2>
        <p class="lede">
          Permanently removes ${escapeHtml(organizationName)} with its people, devices,
          imports and audit log. Members who belong to no other organization are deleted
          with it. Type the name to confirm.
        </p>
        <form id="deleteOrgForm" class="grid">
          <label>Organization name <input name="confirm" required></label>
          <div class="actions span-all"><button type="submit" class="danger">Delete organization</button></div>
        </form>
        <p id="deleteOrgResult" class="muted"></p>
      </section>
    ` : ''}
  `;

  document.querySelector('#passwordForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = document.querySelector('#passwordResult');
    try {
      const body = Object.fromEntries(new FormData(form).entries());
      await api('/api/me/password', { method: 'PUT', body: JSON.stringify(body) });
      form.reset();
      result.textContent = 'Password changed. Other sessions were signed out.';
      result.className = 'ok-text';
    } catch (error) {
      result.textContent = error.message;
      result.className = 'error';
    }
  });

  document.querySelector('#deleteOrgForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = document.querySelector('#deleteOrgResult');
    try {
      const body = Object.fromEntries(new FormData(event.currentTarget).entries());
      await api('/api/organizations/current', { method: 'DELETE', body: JSON.stringify(body) });
      state.signedIn = false;
      state.me = null;
      renderAuth();
    } catch (error) {
      result.textContent = error.message;
      result.className = 'error';
    }
  });
}

function canWrite() {
  return state.me?.role === 'admin' || state.me?.role === 'it';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload.error || `Error ${response.status}`);
  return payload;
}

async function apiForm(path, formData) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    body: formData
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Error ${response.status}`);
  return payload;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
