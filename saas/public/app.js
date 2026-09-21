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
  audit: [],
  editingPerson: '',
  editingAsset: ''
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
  state.token = result.token;
  localStorage.setItem('saas.token', result.token);
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
  const [people, assets] = await Promise.all([
    api('/api/people'),
    api('/api/assets')
  ]);
  state.people = people;
  state.assets = assets;
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
          <button type="button" data-tab="people" class="${state.tab === 'people' ? 'active' : ''}">People</button>
          <button type="button" data-tab="assets" class="${state.tab === 'assets' ? 'active' : ''}">Devices</button>
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
  else if (state.tab === 'settings') renderSettings();
  else if (state.tab === 'account') renderAccount();
  else renderMembers();
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
        <label>Department <input name="department"></label>
        <div class="actions span-all"><button class="primary" type="submit">Add person</button></div>
      </form>
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
            ${state.people.map((person) => (
              person.id === state.editingPerson ? personEditRow(person) : personRow(person)
            )).join('') || '<tr><td colspan="5" class="empty">No people yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>
  `;
  document.querySelector('#personForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    await api('/api/people', { method: 'POST', body: JSON.stringify(body) });
    await loadData();
    renderApp();
  });
  document.querySelectorAll('[data-edit-person]').forEach((button) => {
    button.addEventListener('click', () => {
      state.editingPerson = button.dataset.editPerson;
      renderApp();
    });
  });
  document.querySelector('#personEditForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    await api(`/api/people/${state.editingPerson}`, { method: 'PUT', body: JSON.stringify(body) });
    state.editingPerson = '';
    await loadData();
    renderApp();
  });
  document.querySelector('#personEditCancel')?.addEventListener('click', () => {
    state.editingPerson = '';
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

function personRow(person) {
  return `
    <tr>
      <td>${escapeHtml(person.firstName)} ${escapeHtml(person.lastName)}</td>
      <td>${escapeHtml(person.email || '')}</td>
      <td>${escapeHtml(person.department || '')}</td>
      <td><span class="badge ${escapeHtml(person.status)}">${escapeHtml(person.status)}</span></td>
      <td class="row-actions">${canWrite() ? `
        <button type="button" data-edit-person="${person.id}">Edit</button>
        <button type="button" class="danger" data-del-person="${person.id}">Delete</button>
      ` : ''}</td>
    </tr>
  `;
}

function personEditRow(person) {
  return `
    <tr>
      <td colspan="5">
        <form id="personEditForm" class="grid">
          <label>First name <input name="firstName" value="${escapeHtml(person.firstName)}" required></label>
          <label>Last name <input name="lastName" value="${escapeHtml(person.lastName)}" required></label>
          <label>Email <input name="email" type="email" value="${escapeHtml(person.email || '')}"></label>
          <label>Department <input name="department" value="${escapeHtml(person.department || '')}"></label>
          <label>Status
            <select name="status">
              ${['active', 'inactive'].map((status) =>
                `<option value="${status}" ${status === person.status ? 'selected' : ''}>${status}</option>`
              ).join('')}
            </select>
          </label>
          <div class="actions span-all">
            <button class="primary" type="submit">Save</button>
            <button type="button" id="personEditCancel">Cancel</button>
          </div>
        </form>
      </td>
    </tr>
  `;
}

function renderAssets() {
  const peopleOptions = state.people.map((person) =>
    `<option value="${person.id}">${escapeHtml(person.firstName)} ${escapeHtml(person.lastName)}</option>`
  ).join('');
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
        <label>Model <input name="modelName"></label>
        <label>Assign to
          <select name="personId">
            <option value="">— Unassigned —</option>
            ${peopleOptions}
          </select>
        </label>
        <div class="actions span-all"><button class="primary" type="submit">Add device</button></div>
      </form>
    </section>` : ''}
    <section class="panel">
      ${!canWrite() ? `
        <div class="page-head">
          <h2>Devices</h2>
          <p class="stat"><strong>${state.assets.length}</strong> devices</p>
        </div>` : ''}
      <div class="table-wrap">
        <table>
          <thead><tr><th>Tag</th><th>Serial</th><th>Model</th><th>Assigned to</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${state.assets.map((asset) => (
              asset.id === state.editingAsset ? assetEditRow(asset) : assetRow(asset)
            )).join('') || '<tr><td colspan="6" class="empty">No devices yet.</td></tr>'}
          </tbody>
        </table>
      </div>
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
      state.editingAsset = button.dataset.editAsset;
      renderApp();
    });
  });
  document.querySelector('#assetEditForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    await api(`/api/assets/${state.editingAsset}`, { method: 'PUT', body: JSON.stringify(body) });
    state.editingAsset = '';
    await loadData();
    renderApp();
  });
  document.querySelector('#assetEditCancel')?.addEventListener('click', () => {
    state.editingAsset = '';
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
      <td><span class="badge ${escapeHtml(asset.status)}">${escapeHtml(asset.status)}</span></td>
      <td class="row-actions">${canWrite() ? `
        <button type="button" data-edit-asset="${asset.id}">Edit</button>
        <button type="button" class="danger" data-del-asset="${asset.id}">Delete</button>
      ` : ''}</td>
    </tr>
  `;
}

function assetEditRow(asset) {
  const statuses = ['in_stock', 'assigned', 'deployed', 'service', 'retired'];
  return `
    <tr>
      <td colspan="6">
        <form id="assetEditForm" class="grid">
          <label>Asset tag <input name="assetTag" value="${escapeHtml(asset.assetTag)}" required></label>
          <label>Serial <input name="serialNumber" value="${escapeHtml(asset.serialNumber)}" required></label>
          <label>Model <input name="modelName" value="${escapeHtml(asset.modelName || '')}"></label>
          <label>Status
            <select name="status">
              ${statuses.map((status) =>
                `<option value="${status}" ${status === asset.status ? 'selected' : ''}>${status}</option>`
              ).join('')}
            </select>
          </label>
          <div class="actions span-all">
            <button class="primary" type="submit">Save</button>
            <button type="button" id="assetEditCancel">Cancel</button>
          </div>
        </form>
      </td>
    </tr>
  `;
}

function renderImport() {
  const preview = state.importPreview;
  document.querySelector('#tabContent').innerHTML = `
    <section class="panel">
      <h2>Import Intune / Jamf CSV</h2>
      <p class="lede">Preview stays inside ${escapeHtml(state.me.organization.name)} until you apply it.</p>
      <form id="importForm" class="grid">
        <label>Source
          <select name="source">
            <option value="auto">Auto detect</option>
            <option value="intune">Intune</option>
            <option value="jamf">Jamf</option>
          </select>
        </label>
        <label>CSV file <input name="file" type="file" accept=".csv,text/csv" required></label>
        <div class="actions span-all">
          <button class="primary" type="submit">Preview import</button>
        </div>
      </form>
    </section>
    ${preview ? `
      <section class="panel">
        <h2>Preview ${escapeHtml(preview.source.toUpperCase())}</h2>
        <p class="lede">
          ${preview.summary.create} create · ${preview.summary.update} update ·
          ${preview.summary.skip} skip · ${preview.summary.warnings} with warnings
        </p>
        <div class="actions">
          <button id="applyImport" class="primary" type="button">Apply selected rows</button>
          <button id="selectImportAll" type="button">Select all valid</button>
        </div>
        <div class="table-wrap">
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
        </div>
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
  const settings = await api('/api/settings');
  const canEdit = state.me.role === 'admin';
  const target = document.querySelector('#tabContent');
  if (!target || state.tab !== 'settings') return;
  target.innerHTML = `
    <section class="panel">
      <h2>Import exclusions</h2>
      <p class="lede">
        People matching these addresses are never created from an Intune or Jamf
        import. Each organization has its own list.
      </p>
      <form id="settingsForm" class="grid">
        <label class="span-all">Excluded emails
          <textarea name="excludedEmails" rows="6" ${canEdit ? '' : 'readonly'}>${escapeHtml((settings.excludedEmails || []).join('\n'))}</textarea>
        </label>
        ${canEdit ? `<div class="actions span-all"><button class="primary" type="submit">Save settings</button></div>` : ''}
      </form>
      <p id="settingsResult" class="muted"></p>
    </section>
  `;
  document.querySelector('#settingsForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = new FormData(event.currentTarget).get('excludedEmails');
    const excludedEmails = String(raw || '').split(/[\n,;]+/).map((value) => value.trim()).filter(Boolean);
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ excludedEmails }) });
      document.querySelector('#settingsResult').textContent = 'Saved.';
      document.querySelector('#settingsResult').className = 'ok-text';
    } catch (error) {
      document.querySelector('#settingsResult').textContent = error.message;
      document.querySelector('#settingsResult').className = 'error';
    }
  });
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
      const changed = await api('/api/me/password', { method: 'PUT', body: JSON.stringify(body) });
      state.token = changed.token;
      localStorage.setItem('saas.token', changed.token);
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
      state.token = '';
      localStorage.removeItem('saas.token');
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
