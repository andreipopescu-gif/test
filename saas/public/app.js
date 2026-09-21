const app = document.querySelector('#app');
const sessionLabel = document.querySelector('#sessionLabel');

const state = {
  token: localStorage.getItem('saas.token') || '',
  me: null,
  tab: 'people',
  people: [],
  assets: [],
  importPreview: null,
  members: [],
  audit: []
};

boot();

async function boot() {
  const inviteToken = new URLSearchParams(location.search).get('invite');
  if (inviteToken) return renderInvitation(inviteToken);
  if (!state.token) return renderAuth();
  try {
    state.me = await api('/api/me');
    await loadData();
    renderApp();
  } catch {
    state.token = '';
    localStorage.removeItem('saas.token');
    renderAuth();
  }
}

function renderAuth() {
  sessionLabel.textContent = '';
  app.innerHTML = `
    <section class="panel">
      <h1>Create organization</h1>
      <p class="muted">Multi-client MVP — each company gets its own isolated data.</p>
      <form id="registerForm" class="grid">
        <label>Organization <input name="orgName" required placeholder="Acme IT"></label>
        <label>Your name <input name="name" required placeholder="Alex Pop"></label>
        <label>Email <input name="email" type="email" required></label>
        <label>Password <input name="password" type="password" minlength="8" required></label>
        <div class="actions" style="grid-column:1/-1">
          <button class="primary">Register</button>
        </div>
      </form>
      <p id="authError" class="error"></p>
    </section>
    <section class="panel">
      <h2>Already have an account?</h2>
      <form id="loginForm" class="grid">
        <label>Email <input name="email" type="email" required></label>
        <label>Password <input name="password" type="password" required></label>
        <div class="actions" style="grid-column:1/-1">
          <button class="primary">Log in</button>
        </div>
      </form>
    </section>
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
  state.token = result.token;
  localStorage.setItem('saas.token', result.token);
  state.me = await api('/api/me');
  history.replaceState({}, '', '/');
  await loadData();
  renderApp();
}

function renderOrganizationChoice(result, credentials) {
  app.innerHTML = `
    <section class="panel">
      <h1>Select organization</h1>
      <p class="muted">${escapeHtml(result.user.email)} belongs to multiple organizations.</p>
      <div class="actions">
        ${result.organizations.map((org) => `
          <button type="button" data-login-org="${org.id}">
            ${escapeHtml(org.name)} · ${escapeHtml(org.role)}
          </button>
        `).join('')}
      </div>
    </section>
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
  sessionLabel.textContent = '';
  app.innerHTML = `
    <section class="panel">
      <h1>Accept invitation</h1>
      <p class="muted">If you already have an account, enter its password. Otherwise choose a new password.</p>
      <form id="acceptInviteForm" class="grid">
        <label>Your name <input name="name"></label>
        <label>Password <input name="password" type="password" minlength="8" required></label>
        <div class="actions" style="grid-column:1/-1">
          <button class="primary">Accept invitation</button>
        </div>
      </form>
      <p id="inviteError" class="error"></p>
    </section>
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
  const [people, assets] = await Promise.all([
    api('/api/people'),
    api('/api/assets')
  ]);
  state.people = people;
  state.assets = assets;
}

function renderApp() {
  const org = state.me.organization?.name || '';
  const user = state.me.user?.email || '';
  sessionLabel.textContent = `${org} · ${user} · ${state.me.role}`;
  app.innerHTML = `
    <div class="actions" style="justify-content:space-between;margin-bottom:1rem">
      <div class="tabs">
        <button type="button" data-tab="people" class="${state.tab === 'people' ? 'active' : ''}">People</button>
        <button type="button" data-tab="assets" class="${state.tab === 'assets' ? 'active' : ''}">Devices</button>
        ${canWrite() ? `<button type="button" data-tab="import" class="${state.tab === 'import' ? 'active' : ''}">Import</button>` : ''}
        ${state.me.role !== 'readonly' ? `<button type="button" data-tab="members" class="${state.tab === 'members' ? 'active' : ''}">Members</button>` : ''}
      </div>
      <div class="actions" style="margin-top:0">
        ${state.me.organizations?.length > 1 ? `
          <select id="organizationSwitch" aria-label="Organization">
            ${state.me.organizations.map((item) => `
              <option value="${item.id}" ${item.id === state.me.organization.id ? 'selected' : ''}>
                ${escapeHtml(item.name)}
              </option>
            `).join('')}
          </select>
        ` : ''}
        <button type="button" id="logout">Log out</button>
      </div>
    </div>
    <div id="tabContent"></div>
  `;
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.tab = button.dataset.tab;
      renderApp();
    });
  });
  document.querySelector('#logout').addEventListener('click', () => {
    state.token = '';
    localStorage.removeItem('saas.token');
    renderAuth();
  });
  document.querySelector('#organizationSwitch')?.addEventListener('change', async (event) => {
    const result = await api('/api/auth/switch-organization', {
      method: 'POST',
      body: JSON.stringify({ organizationId: event.target.value })
    });
    await acceptSession(result);
  });
  if (state.tab === 'people') renderPeople();
  else if (state.tab === 'assets') renderAssets();
  else if (state.tab === 'import') renderImport();
  else renderMembers();
}

function renderPeople() {
  document.querySelector('#tabContent').innerHTML = `
    ${canWrite() ? `<section class="panel">
      <h2>People</h2>
      <form id="personForm" class="grid">
        <label>First name <input name="firstName" required></label>
        <label>Last name <input name="lastName" required></label>
        <label>Email <input name="email" type="email"></label>
        <label>Department <input name="department"></label>
        <div class="actions" style="grid-column:1/-1"><button class="primary">Add person</button></div>
      </form>
    </section>` : ''}
    <section class="panel">
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Department</th><th></th></tr></thead>
        <tbody>
          ${state.people.map((person) => `
            <tr>
              <td>${escapeHtml(person.firstName)} ${escapeHtml(person.lastName)}</td>
              <td>${escapeHtml(person.email || '')}</td>
              <td>${escapeHtml(person.department || '')}</td>
              <td>${canWrite() ? `<button data-del-person="${person.id}">Delete</button>` : ''}</td>
            </tr>
          `).join('') || '<tr><td colspan="4" class="muted">No people yet.</td></tr>'}
        </tbody>
      </table>
    </section>
  `;
  document.querySelector('#personForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    await api('/api/people', { method: 'POST', body: JSON.stringify(body) });
    await loadData();
    renderApp();
  });
  document.querySelectorAll('[data-del-person]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/api/people/${button.dataset.delPerson}`, { method: 'DELETE' });
      await loadData();
      renderApp();
    });
  });
}

function renderAssets() {
  const peopleOptions = state.people.map((person) =>
    `<option value="${person.id}">${escapeHtml(person.firstName)} ${escapeHtml(person.lastName)}</option>`
  ).join('');
  document.querySelector('#tabContent').innerHTML = `
    ${canWrite() ? `<section class="panel">
      <h2>Devices</h2>
      <form id="assetForm" class="grid">
        <label>Asset tag <input name="assetTag" required></label>
        <label>Serial <input name="serialNumber" required></label>
        <label>Model <input name="modelName"></label>
        <label>Assign to
          <select name="personId">
            <option value="">— Unassigned —</option>
            ${peopleOptions}
          </select>
        </label>
        <div class="actions" style="grid-column:1/-1"><button class="primary">Add device</button></div>
      </form>
    </section>` : ''}
    <section class="panel">
      <table>
        <thead><tr><th>Tag</th><th>Serial</th><th>Model</th><th>Person</th><th></th></tr></thead>
        <tbody>
          ${state.assets.map((asset) => `
            <tr>
              <td>${escapeHtml(asset.assetTag)}</td>
              <td>${escapeHtml(asset.serialNumber)}</td>
              <td>${escapeHtml(asset.modelName || '')}</td>
              <td>${escapeHtml([asset.personFirstName, asset.personLastName].filter(Boolean).join(' ') || '—')}</td>
              <td>${canWrite() ? `<button data-del-asset="${asset.id}">Delete</button>` : ''}</td>
            </tr>
          `).join('') || '<tr><td colspan="5" class="muted">No devices yet.</td></tr>'}
        </tbody>
      </table>
    </section>
  `;
  document.querySelector('#assetForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    if (body.personId) body.status = 'assigned';
    await api('/api/assets', { method: 'POST', body: JSON.stringify(body) });
    await loadData();
    renderApp();
  });
  document.querySelectorAll('[data-del-asset]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/api/assets/${button.dataset.delAsset}`, { method: 'DELETE' });
      await loadData();
      renderApp();
    });
  });
}

function renderImport() {
  const preview = state.importPreview;
  document.querySelector('#tabContent').innerHTML = `
    <section class="panel">
      <h2>Import Intune / Jamf CSV</h2>
      <p class="muted">Preview is stored only inside ${escapeHtml(state.me.organization.name)}.</p>
      <form id="importForm" class="grid">
        <label>Source
          <select name="source">
            <option value="auto">Auto detect</option>
            <option value="intune">Intune</option>
            <option value="jamf">Jamf</option>
          </select>
        </label>
        <label>CSV file <input name="file" type="file" accept=".csv,text/csv" required></label>
        <div class="actions" style="grid-column:1/-1">
          <button class="primary">Preview import</button>
        </div>
      </form>
    </section>
    ${preview ? `
      <section class="panel">
        <h2>Preview ${escapeHtml(preview.source.toUpperCase())}</h2>
        <p class="muted">
          ${preview.summary.create} create · ${preview.summary.update} update ·
          ${preview.summary.skip} skip · ${preview.summary.warnings} with warnings
        </p>
        <div class="actions">
          <button id="applyImport" class="primary">Apply selected rows</button>
          <button id="selectImportAll" type="button">Select all valid</button>
        </div>
        <table>
          <thead>
            <tr><th></th><th>Line</th><th>Action</th><th>Serial</th><th>Asset</th><th>Model</th><th>Person</th><th>Warnings</th></tr>
          </thead>
          <tbody>
            ${preview.rows.map((row) => `
              <tr>
                <td><input type="checkbox" data-import-row="${row.id}" ${row.action !== 'skip' ? 'checked' : 'disabled'}></td>
                <td>${escapeHtml(row.line)}</td>
                <td>${escapeHtml(row.action)}</td>
                <td>${escapeHtml(row.serialNumber || '—')}</td>
                <td>${escapeHtml(row.assetTag || '—')}</td>
                <td>${escapeHtml(row.modelName || '—')}</td>
                <td>${escapeHtml(row.person?.email || '—')}</td>
                <td>${escapeHtml((row.warnings || []).join('; '))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </section>
    ` : ''}
  `;

  document.querySelector('#importForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    state.importPreview = await apiForm('/api/import/preview', form);
    renderApp();
  });
  document.querySelector('#selectImportAll')?.addEventListener('click', () => {
    document.querySelectorAll('[data-import-row]:not(:disabled)').forEach((input) => {
      input.checked = true;
    });
  });
  document.querySelector('#applyImport')?.addEventListener('click', async () => {
    const includeRowIds = [...document.querySelectorAll('[data-import-row]:checked')]
      .map((input) => input.dataset.importRow);
    const result = await api('/api/import/apply', {
      method: 'POST',
      body: JSON.stringify({ batchId: preview.batchId, includeRowIds })
    });
    alert(`Import complete: ${result.summary.created} created, ${result.summary.updated} updated.`);
    state.importPreview = null;
    await loadData();
    state.tab = 'assets';
    renderApp();
  });
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
        <form id="inviteForm" class="grid">
          <label>Email <input name="email" type="email" required></label>
          <label>Role
            <select name="role">
              <option value="it">IT</option>
              <option value="readonly">Read-only</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <div class="actions" style="grid-column:1/-1"><button class="primary">Create invitation</button></div>
        </form>
        <div id="inviteResult"></div>
      </section>
    ` : ''}
    <section class="panel">
      <h2>Members</h2>
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
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
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>
    <section class="panel">
      <h2>Recent audit</h2>
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
          `).join('') || '<tr><td colspan="4" class="muted">No audit events.</td></tr>'}
        </tbody>
      </table>
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
      <p><strong>Invitation link (valid 7 days):</strong></p>
      <input value="${escapeHtml(invitation.inviteUrl)}" readonly style="width:100%">
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
}

function canWrite() {
  return state.me?.role === 'admin' || state.me?.role === 'it';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
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
    headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
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
