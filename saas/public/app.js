const app = document.querySelector('#app');
const sessionLabel = document.querySelector('#sessionLabel');

const state = {
  token: localStorage.getItem('saas.token') || '',
  me: null,
  tab: 'people',
  people: [],
  assets: []
};

boot();

async function boot() {
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
    await acceptSession(result);
  } catch (error) {
    document.querySelector('#authError').textContent = error.message;
  }
}

async function acceptSession(result) {
  state.token = result.token;
  localStorage.setItem('saas.token', result.token);
  state.me = { user: result.user, organization: result.organization, role: 'admin' };
  await loadData();
  renderApp();
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
  sessionLabel.textContent = `${org} · ${user}`;
  app.innerHTML = `
    <div class="actions" style="justify-content:space-between;margin-bottom:1rem">
      <div class="tabs">
        <button type="button" data-tab="people" class="${state.tab === 'people' ? 'active' : ''}">People</button>
        <button type="button" data-tab="assets" class="${state.tab === 'assets' ? 'active' : ''}">Devices</button>
      </div>
      <button type="button" id="logout">Log out</button>
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
  if (state.tab === 'people') renderPeople();
  else renderAssets();
}

function renderPeople() {
  document.querySelector('#tabContent').innerHTML = `
    <section class="panel">
      <h2>People</h2>
      <form id="personForm" class="grid">
        <label>First name <input name="firstName" required></label>
        <label>Last name <input name="lastName" required></label>
        <label>Email <input name="email" type="email"></label>
        <label>Department <input name="department"></label>
        <div class="actions" style="grid-column:1/-1"><button class="primary">Add person</button></div>
      </form>
    </section>
    <section class="panel">
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Department</th><th></th></tr></thead>
        <tbody>
          ${state.people.map((person) => `
            <tr>
              <td>${escapeHtml(person.firstName)} ${escapeHtml(person.lastName)}</td>
              <td>${escapeHtml(person.email || '')}</td>
              <td>${escapeHtml(person.department || '')}</td>
              <td><button data-del-person="${person.id}">Delete</button></td>
            </tr>
          `).join('') || '<tr><td colspan="4" class="muted">No people yet.</td></tr>'}
        </tbody>
      </table>
    </section>
  `;
  document.querySelector('#personForm').addEventListener('submit', async (event) => {
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
    <section class="panel">
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
    </section>
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
              <td><button data-del-asset="${asset.id}">Delete</button></td>
            </tr>
          `).join('') || '<tr><td colspan="5" class="muted">No devices yet.</td></tr>'}
        </tbody>
      </table>
    </section>
  `;
  document.querySelector('#assetForm').addEventListener('submit', async (event) => {
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

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
