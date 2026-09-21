const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const dialogBody = document.querySelector('#dialogBody');
const actorInput = document.querySelector('#actorName');

const state = {
  route: 'dashboard',
  catalog: null,
  assets: [],
  people: [],
  handoverDocuments: [],
  selectedAsset: null,
  importPreview: null,
  userImportPreview: null,
  invoicePreview: null,
  importTab: 'csv',
  peopleFilters: { department: '', role: '', status: 'active' },
  assetFilters: { status: '', model: '', category: '' },
  settings: null,
  selectedPeopleIds: []
};

const knownGivenNames = [
  'adina', 'adrian', 'adriana', 'alin', 'alexandra', 'alexandru', 'andra', 'andrei',
  'angela', 'bogdan', 'constantin', 'cosmin', 'cristian', 'cristina', 'cristinel',
  'daniel', 'daniela', 'david', 'diana', 'elena', 'florin', 'florentin', 'gabriel',
  'george', 'gheorghe', 'ioan', 'ioana', 'ionela', 'ionut', 'laurentiu', 'lorena',
  'lucretia', 'maria', 'marian', 'mihaela', 'mihai', 'nicolae', 'nicoleta', 'paul',
  'radu', 'razvan', 'rodica', 'stefan', 'teodor', 'valentin', 'vlad'
];

actorInput.value = localStorage.getItem('itinv.actor') || 'IT';
actorInput.addEventListener('input', () => localStorage.setItem('itinv.actor', actorInput.value));

document.querySelectorAll('.nav button[data-route]').forEach((button) => {
  button.addEventListener('click', () => navigate(button.dataset.route));
});

document.querySelector('#devicesNavToggle')?.addEventListener('click', () => {
  document.querySelector('#devicesNavGroup')?.classList.toggle('open');
});

await loadBaseData();
updateNavState();
await render();

async function navigate(route) {
  state.route = route;
  if (route.startsWith('assets:')) {
    document.querySelector('#devicesNavGroup')?.classList.add('open');
  }
  updateNavState();
  await render();
}

function updateNavState() {
  const route = state.route;
  document.querySelectorAll('.nav button[data-route]').forEach((button) => {
    button.classList.toggle('active', button.dataset.route === route);
  });
  const devicesOpen = document.querySelector('#devicesNavGroup')?.classList.contains('open');
  const onDevicesRoute = route.startsWith('assets:');
  document.querySelector('#devicesNavGroup')?.classList.toggle('open', devicesOpen || onDevicesRoute);
  document.querySelector('#devicesNavToggle')?.classList.toggle('active', onDevicesRoute);
  document.querySelector('#devicesNavToggle')?.setAttribute('aria-expanded', String(devicesOpen || onDevicesRoute));
}

async function loadBaseData() {
  const [catalog, assets, people, settings] = await Promise.all([
    api('/api/catalog'),
    api('/api/assets'),
    api('/api/people'),
    api('/api/settings').catch(() => null)
  ]);
  state.catalog = catalog;
  state.assets = assets;
  state.people = people;
  state.settings = settings;
}

async function render() {
  try {
    if (state.route === 'dashboard') return renderDashboard();
    if (state.route.startsWith('assets:')) return renderAssets();
    if (state.route === 'people') return renderPeople();
    if (state.route.startsWith('person:')) return renderPersonDetail(state.route.split(':')[1]);
    if (state.route === 'handover') return renderHandoverDocuments();
    if (state.route === 'import') return renderImport();
    if (state.route === 'reports') return renderReports();
    if (state.route === 'settings') return renderSettings();
  } catch (error) {
    app.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
  }
}

async function renderDashboard() {
  const data = await api('/api/dashboard');
  const people = data.people || { total: 0, active: 0, inactive: 0, byDepartment: [], byRole: [] };
  const devices = data.devices || { byStatus: [], byCategory: [], byModel: [] };
  const docs = data.personDocuments || { total: 0, byType: [] };
  app.innerHTML = `
    <div class="toolbar">
      <div>
        <h1>Dashboard</h1>
        <p class="muted">Quick overview of IT inventory.</p>
      </div>
      <button onclick="location.href='/api/export/assets'">Export CSV</button>
    </div>
    <div class="cards">
      ${metricNavButton('Total devices', data.total, 'assets:all')}
      ${metricNavButton('Assigned', data.assigned, 'assets:all', { status: 'assigned' })}
      ${metricNavButton('In stock', data.inStock, 'assets:all', { status: 'in_stock' })}
      ${(data.deployed || 0) > 0 ? metricNavButton('Deployed (MTR)', data.deployed, 'assets:all', { status: 'deployed' }) : ''}
      ${metricNavButton('In service', data.service, 'assets:all', { status: 'service' })}
      ${(data.retired || 0) > 0 ? metricNavButton('Retired', data.retired, 'assets:all', { status: 'retired' }) : ''}
    </div>
    <div class="cards" style="margin-top:1rem">
      ${metricNavButton('Users', people.total, 'people')}
      ${metricNavButton('Active users', people.active, 'people', { status: 'active' })}
      ${metricNavButton('Inactive users', people.inactive, 'people', { status: 'inactive' })}
      ${card('IT / PV PDFs', docs.total || 0)}
    </div>
    <div class="grid" style="margin-top:1rem">
      <section class="panel">
        <h2>Users by department</h2>
        <div class="filters">
          ${(people.byDepartment || []).map((item) => metricNavButton(item.label, item.count, 'people', { department: item.label })).join('') || '<p class="muted">No data.</p>'}
        </div>
      </section>
      <section class="panel">
        <h2>Users by role</h2>
        <div class="filters">
          ${(people.byRole || []).slice(0, 12).map((item) => metricNavButton(item.label, item.count, 'people', { role: item.label })).join('') || '<p class="muted">No data.</p>'}
        </div>
      </section>
    </div>
    <div class="grid" style="margin-top:1rem">
      <section class="panel">
        <h2>Devices by category</h2>
        <div class="filters">
          ${(devices.byCategory || []).map((item) => metricNavButton(item.label, item.count, 'assets:all', { category: item.label })).join('') || '<p class="muted">No data.</p>'}
        </div>
      </section>
      <section class="panel">
        <h2>Devices by status</h2>
        <div class="filters">
          ${(devices.byStatus || []).map((item) => metricNavButton(statusLabel(item.label), item.count, 'assets:all', { status: item.label })).join('') || '<p class="muted">No data.</p>'}
        </div>
      </section>
    </div>
    <section class="panel" style="margin-top:1rem">
      <h2>Devices by model</h2>
      <div class="filters">
        ${(devices.byModel || []).slice(0, 16).map((item) => metricNavButton(item.label, item.count, 'assets:all', { model: item.label })).join('') || '<p class="muted">No data.</p>'}
      </div>
    </section>
    ${docs.byType?.length ? `
      <section class="panel" style="margin-top:1rem">
        <h2>IT / PV documents by type</h2>
        <div class="filters">
          ${docs.byType.map((item) => card(personDocTypeLabel(item.label), item.count)).join('')}
        </div>
      </section>` : ''}
    <div class="grid" style="margin-top:1rem">
      <section class="panel">
        <h2>Warranties expiring in 30 days</h2>
        ${simpleList(data.warrantyExpiring, (asset) => `${asset.assetTag} - ${assetModelName(asset)} (${asset.warrantyUntil})`)}
      </section>
      <section class="panel">
        <h2>Recent assignments</h2>
        ${simpleList(data.recentAssignments, (item) => `${item.asset?.assetTag || '-'} to ${personName(item.person)} on ${item.assignedAt}`)}
      </section>
    </div>
  `;
  document.querySelectorAll('[data-nav-route]').forEach((button) => {
    button.addEventListener('click', () => {
      let route = button.dataset.navRoute;
      const filters = button.dataset.navFilters
        ? JSON.parse(decodeURIComponent(button.dataset.navFilters))
        : {};
      if (route === 'people') {
        state.peopleFilters = {
          department: filters.department
            ? (filters.department === 'Fara departament' ? 'Fara departament' : (normalizeDepartmentLabel(filters.department) || filters.department))
            : '',
          role: filters.role
            ? (filters.role === 'Fara rol' ? 'Fara rol' : (normalizeRoleLabel(filters.role) || filters.role))
            : '',
          status: filters.status || ''
        };
      } else if (route.startsWith('assets:')) {
        state.assetFilters = {
          status: filters.status || '',
          model: filters.model || '',
          category: filters.category || ''
        };
        if (filters.category === 'Telefon' || /iPhone|Samsung|Pixel|Xiaomi/i.test(filters.model || '')) {
          route = 'assets:phones';
        } else if (filters.category === 'MTR RO' || /MTR RO/i.test(filters.model || '')) {
          route = 'assets:mtr-ro';
        } else if (filters.category === 'MTR BG' || /MTR BG/i.test(filters.model || '')) {
          route = 'assets:mtr-bg';
        } else if (/MacBook/i.test(filters.model || '') || /Apple MacBook/i.test(filters.model || '')) {
          route = 'assets:macbooks';
        } else if (filters.category === 'Laptop' || /ThinkPad|Lenovo/i.test(filters.model || '')) {
          route = 'assets:wims';
        } else if (filters.category) {
          route = 'assets:all';
        } else if (filters.status || filters.model) {
          // Dashboard status/model totals are global — don't trap in WIMS-only view
          route = 'assets:all';
        }
      }
      navigate(route);
    });
  });
}

function metricNavButton(label, count, route, filters = {}) {
  return `<button type="button" class="card metric-btn" data-nav-route="${attr(route)}" data-nav-filters="${attr(encodeURIComponent(JSON.stringify(filters)))}">
    <span class="muted">${escapeHtml(label)}</span>
    <strong>${count}</strong>
  </button>`;
}

function personDocTypeLabel(type) {
  return {
    pv_primire: 'PV primire',
    pv_predare: 'PV predare',
    alocare: 'Alocare',
    altul: 'Alt document IT'
  }[type] || type;
}

function normalizeRoleLabel(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const compact = text.toLocaleLowerCase('ro-RO').replace(/[\s_-]+/g, '');
  if (compact.includes('fullstack')) return 'Fullstack Engineer';
  return text;
}

function normalizeDepartmentLabel(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const compact = text
    .toLocaleLowerCase('ro-RO')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
  if (compact.includes('esolution')) return 'eSolutions';
  if (compact.includes('tchibo')) return 'Tchibo Brands';
  return text;
}

function personRoleBucket(person) {
  return normalizeRoleLabel(person?.role) || 'Fara rol';
}

function personDepartmentBucket(person) {
  return normalizeDepartmentLabel(person?.department) || 'Fara departament';
}

function renderAssets() {
  const section = currentAssetSection();
  const filters = state.assetFilters || { status: '', model: '', category: '' };
  let sectionAssets = state.assets.filter((asset) => section.matches(asset));
  if (filters.category) {
    sectionAssets = state.assets.filter((asset) => (asset.category?.name || 'Fara categorie') === filters.category);
  }
  const modelOptions = uniqueModelOptions(sectionAssets)
    .map((model) => `<option value="${attr(model)}" ${filters.model === model ? 'selected' : ''}>${escapeHtml(model)}</option>`)
    .join('');
  app.innerHTML = `
    <div class="toolbar">
      <div>
        <h1>${section.title}</h1>
        <p class="muted">${section.description}</p>
      </div>
      <div class="actions">
        <button onclick="location.href='/api/export/assets'">Export CSV</button>
        <button class="primary" id="newAsset">Add device</button>
      </div>
    </div>
    <div class="filters">
      <input id="assetSearch" placeholder="Search by asset tag, serial, model, person">
      <select id="assetStatus">
        <option value="">All statuses</option>
        <option value="in_stock" ${filters.status === 'in_stock' ? 'selected' : ''}>In stock</option>
        <option value="assigned" ${filters.status === 'assigned' ? 'selected' : ''}>Assigned</option>
        <option value="deployed" ${filters.status === 'deployed' ? 'selected' : ''}>Deployed (MTR)</option>
        <option value="service" ${filters.status === 'service' ? 'selected' : ''}>Service</option>
        <option value="retired" ${filters.status === 'retired' ? 'selected' : ''}>Retired</option>
      </select>
      <select id="assetModel">
        <option value="">All models</option>
        ${modelOptions}
      </select>
      ${filters.category ? `<button type="button" id="clearAssetCategory">Category: ${escapeHtml(filters.category)} ✕</button>` : ''}
    </div>
    <div id="assetCounters" style="margin-top:1rem"></div>
    <div id="assetsTable" style="margin-top:1rem"></div>
  `;
  document.querySelector('#newAsset').addEventListener('click', () => showAssetForm());
  document.querySelector('#assetSearch').addEventListener('input', drawAssetsTable);
  document.querySelector('#assetStatus').addEventListener('change', () => {
    state.assetFilters.status = document.querySelector('#assetStatus').value;
    drawAssetsTable();
  });
  document.querySelector('#assetModel').addEventListener('change', () => {
    state.assetFilters.model = document.querySelector('#assetModel').value;
    drawAssetsTable();
  });
  document.querySelector('#clearAssetCategory')?.addEventListener('click', () => {
    state.assetFilters.category = '';
    renderAssets();
  });
  drawAssetsTable();
}

function drawAssetsTable() {
  const section = currentAssetSection();
  const query = document.querySelector('#assetSearch').value.toLowerCase();
  const status = document.querySelector('#assetStatus').value;
  const modelFilter = document.querySelector('#assetModel').value;
  const categoryFilter = state.assetFilters?.category || '';
  const sectionAssets = categoryFilter
    ? state.assets.filter((asset) => (asset.category?.name || 'Fara categorie') === categoryFilter)
    : state.assets.filter((asset) => section.matches(asset));
  drawAssetCounters(sectionAssets);
  const rows = sectionAssets.filter((asset) => {
    const haystack = [
      asset.assetTag,
      asset.serialNumber,
      asset.brand?.name,
      asset.model?.name,
      asset.model?.generation,
      personName(asset.currentAssignment?.person)
    ].join(' ').toLowerCase();
    return (!status || asset.status === status) &&
      (!modelFilter || assetModelName(asset) === modelFilter) &&
      haystack.includes(query);
  });
  document.querySelector('#assetsTable').innerHTML = table(
    ['Asset', 'Model', 'Serial', 'Status', 'Assigned to', 'Actions'],
    rows.map((asset) => [
      asset.assetTag,
      assetModelName(asset),
      asset.serialNumber,
      badge(
        statusLabel(asset.status) + (asset.importMeta?.missingFromLastImport ? ' · missing MDM' : ''),
        asset.importMeta?.missingFromLastImport
          ? 'warn'
          : (asset.status === 'assigned' || asset.status === 'deployed' ? 'ok' : asset.status === 'service' ? 'warn' : '')
      ),
      personName(asset.currentAssignment?.person) || '<span class="muted">Unassigned</span>',
      `<button data-view="${asset.id}">Details</button>`
    ])
  );
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => showAssetDetail(button.dataset.view)));
}

function drawAssetCounters(assets) {
  const statusCounts = countBy(assets, (asset) => asset.status || 'unknown');
  const modelCounts = countBy(assets, assetModelName);
  const statuses = ['in_stock', 'assigned', 'deployed', 'service', 'retired'];
  const topModels = Object.entries(modelCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ro'))
    .slice(0, 8);

  document.querySelector('#assetCounters').innerHTML = `
    <div class="cards">
      ${statuses.map((item) => metricButton(statusLabel(item), statusCounts[item] || 0, 'status', item)).join('')}
    </div>
    <div class="panel" style="margin-top:1rem">
      <h3>Modele (${Object.keys(modelCounts).length})</h3>
      <div class="filters">
        ${topModels.map(([model, count]) => metricButton(model, count, 'model', model)).join('')}
      </div>
    </div>
  `;
  document.querySelectorAll('[data-filter-status]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelector('#assetStatus').value = button.dataset.filterStatus;
      drawAssetsTable();
    });
  });
  document.querySelectorAll('[data-filter-model]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelector('#assetModel').value = button.dataset.filterModel;
      drawAssetsTable();
    });
  });
}

function metricButton(label, count, type, value) {
  const attrName = type === 'status' ? 'data-filter-status' : 'data-filter-model';
  return `<button type="button" class="card metric-btn" ${attrName}="${attr(value)}">
    <span class="muted">${escapeHtml(label)}</span>
    <strong>${count}</strong>
  </button>`;
}

function uniqueModelOptions(assets) {
  return [...new Set(assets.map(assetModelName).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ro'));
}

function countBy(items, fn) {
  return items.reduce((acc, item) => {
    const key = fn(item) || '-';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function currentAssetSection() {
  const route = state.route.split(':')[1] || 'wims';
  const sections = {
    all: {
      title: 'All devices',
      description: 'All inventory devices across categories.',
      matches: () => true
    },
    phones: {
      title: 'Phones',
      description: 'iPhone and Samsung phones.',
      matches: (asset) => asset.category?.name === 'Telefon'
    },
    macbooks: {
      title: 'MacBooks',
      description: 'Apple MacBook laptops managed via Jamf.',
      matches: (asset) => asset.brand?.name === 'Apple MacBook'
    },
    wims: {
      title: 'WIMS',
      description: 'Lenovo / Windows laptops imported from Intune.',
      matches: (asset) => asset.brand?.name === 'Lenovo' && asset.model?.deviceType !== 'MTR' && !String(asset.category?.name || '').startsWith('MTR')
    },
    'mtr-ro': {
      title: 'MTR RO',
      description: 'Microsoft Teams Rooms Romania (RO Room).',
      matches: (asset) => asset.category?.name === 'MTR RO' || asset.brand?.name === 'MTR RO'
    },
    'mtr-bg': {
      title: 'MTR BG',
      description: 'Microsoft Teams Rooms Bulgaria (BG Room / MTR-BG).',
      matches: (asset) => asset.category?.name === 'MTR BG' || asset.brand?.name === 'MTR BG'
    }
  };
  return sections[route] || sections.wims;
}

function renderPeople() {
  const departments = [...new Set(state.people.map((person) => personDepartmentBucket(person)))]
    .sort((a, b) => a.localeCompare(b, 'ro'));
  const roles = [...new Set(state.people.map((person) => personRoleBucket(person)))]
    .sort((a, b) => a.localeCompare(b, 'ro'));
  const filters = state.peopleFilters || { department: '', role: '', status: 'active' };
  const selectedRole = filters.role === 'Fara rol' ? 'Fara rol' : (normalizeRoleLabel(filters.role) || filters.role);
  const selectedDepartment = filters.department === 'Fara departament'
    ? 'Fara departament'
    : (normalizeDepartmentLabel(filters.department) || filters.department);
  app.innerHTML = `
    <div class="toolbar">
      <div>
        <h1>People</h1>
        <p class="muted">Company users who receive devices. Select 2 to merge.</p>
      </div>
      <div class="actions">
        <button type="button" id="mergePeople" disabled>Merge selected</button>
        <button class="primary" id="newPerson">Add person</button>
      </div>
    </div>
    <div class="filters">
      <input id="peopleSearch" placeholder="Search by name, department, email">
      <select id="peopleDepartment">
        <option value="">All departments</option>
        ${departments.map((item) => `<option value="${attr(item)}" ${selectedDepartment === item ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('')}
      </select>
      <select id="peopleRole">
        <option value="">All roles</option>
        ${roles.map((item) => `<option value="${attr(item)}" ${selectedRole === item ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('')}
      </select>
      <select id="peopleStatus">
        <option value="">All statuses</option>
        <option value="active" ${filters.status === 'active' ? 'selected' : ''}>Active</option>
        <option value="inactive" ${filters.status === 'inactive' ? 'selected' : ''}>Inactive</option>
      </select>
      <button type="button" id="clearPeopleFilters">Clear filters</button>
    </div>
    <div id="peopleTable" style="margin-top:1rem"></div>
  `;
  document.querySelector('#newPerson').addEventListener('click', () => showPersonForm());
  document.querySelector('#mergePeople').addEventListener('click', mergeSelectedPeople);
  document.querySelector('#peopleSearch').addEventListener('input', drawPeopleTable);
  document.querySelector('#peopleDepartment').addEventListener('change', () => {
    state.peopleFilters.department = document.querySelector('#peopleDepartment').value;
    drawPeopleTable();
  });
  document.querySelector('#peopleRole').addEventListener('change', () => {
    state.peopleFilters.role = document.querySelector('#peopleRole').value;
    drawPeopleTable();
  });
  document.querySelector('#peopleStatus').addEventListener('change', () => {
    state.peopleFilters.status = document.querySelector('#peopleStatus').value;
    drawPeopleTable();
  });
  document.querySelector('#clearPeopleFilters').addEventListener('click', () => {
    state.peopleFilters = { department: '', role: '', status: 'active' };
    document.querySelector('#peopleSearch').value = '';
    document.querySelector('#peopleDepartment').value = '';
    document.querySelector('#peopleRole').value = '';
    document.querySelector('#peopleStatus').value = 'active';
    drawPeopleTable();
  });
  drawPeopleTable();
}

function drawPeopleTable() {
  const query = document.querySelector('#peopleSearch').value.toLowerCase();
  const department = document.querySelector('#peopleDepartment')?.value || state.peopleFilters?.department || '';
  const role = document.querySelector('#peopleRole')?.value || state.peopleFilters?.role || '';
  const status = document.querySelector('#peopleStatus')?.value || state.peopleFilters?.status || '';
  const rows = state.people.filter((person) => {
    const haystack = [person.firstName, person.lastName, person.department, person.email, person.role]
      .join(' ')
      .toLowerCase();
    const personStatus = person.status === 'inactive' ? 'inactive' : 'active';
    return haystack.includes(query) &&
      (!department || personDepartmentBucket(person) === (normalizeDepartmentLabel(department) || department)) &&
      (!role || personRoleBucket(person) === (role === 'Fara rol' ? 'Fara rol' : (normalizeRoleLabel(role) || role))) &&
      (!status || personStatus === status);
  });
  document.querySelector('#peopleTable').innerHTML = table(
    ['', 'Name', 'Department', 'Role', 'Email', 'Status', 'Active devices', 'Docs', 'Actions'],
    rows.map((person) => [
      `<input type="checkbox" data-select-person="${person.id}" ${state.selectedPeopleIds.includes(person.id) ? 'checked' : ''}>`,
      `<button class="link-btn" data-person-detail="${person.id}">${escapeHtml(personName(person))}</button>`,
      person.department,
      person.role,
      person.email,
      person.status === 'inactive' ? 'inactive' : 'active',
      String(person.activeAssignments?.length || 0),
      String(person.documentCount || 0),
      `<button data-edit-person="${person.id}">Edit</button>
       <button data-delete-person="${person.id}">Delete</button>`
    ])
  );
  document.querySelectorAll('[data-select-person]').forEach((input) => {
    input.addEventListener('change', () => {
      const id = input.dataset.selectPerson;
      if (input.checked) {
        if (!state.selectedPeopleIds.includes(id)) state.selectedPeopleIds.push(id);
      } else {
        state.selectedPeopleIds = state.selectedPeopleIds.filter((item) => item !== id);
      }
      if (state.selectedPeopleIds.length > 2) {
        state.selectedPeopleIds = state.selectedPeopleIds.slice(-2);
        drawPeopleTable();
        return;
      }
      document.querySelector('#mergePeople').disabled = state.selectedPeopleIds.length !== 2;
    });
  });
  document.querySelector('#mergePeople').disabled = state.selectedPeopleIds.length !== 2;
  document.querySelectorAll('[data-edit-person]').forEach((button) => {
    button.addEventListener('click', () => showPersonForm(state.people.find((person) => person.id === button.dataset.editPerson)));
  });
  document.querySelectorAll('[data-delete-person]').forEach((button) => {
    button.addEventListener('click', () => deletePersonById(button.dataset.deletePerson));
  });
  document.querySelectorAll('[data-person-detail]').forEach((button) => {
    button.addEventListener('click', () => navigate(`person:${button.dataset.personDetail}`));
  });
}

async function mergeSelectedPeople() {
  if (state.selectedPeopleIds.length !== 2) return;
  const [primaryId, secondaryId] = state.selectedPeopleIds;
  const primary = state.people.find((person) => person.id === primaryId);
  const secondary = state.people.find((person) => person.id === secondaryId);
  const keepPrimary = confirm(
    `Merge into "${personName(primary)}" (${primary.email || 'no email'})?\n` +
    `Secondary "${personName(secondary)}" will be removed and devices/docs moved.\n\n` +
    `OK = keep first selected as primary\nCancel = abort`
  );
  if (!keepPrimary) return;
  await api('/api/people/merge', {
    method: 'POST',
    body: JSON.stringify({ primaryId, secondaryId })
  });
  state.selectedPeopleIds = [];
  await loadBaseData();
  await render();
}

async function deletePersonById(personId) {
  const person = state.people.find((item) => item.id === personId);
  if (!person) return;
  const active = person.activeAssignments?.length || 0;
  if (active) {
    const makeInactive = confirm(
      `${personName(person)} has ${active} active device(s).\n` +
      `Delete is blocked. Mark as inactive instead?`
    );
    if (!makeInactive) return;
    await api(`/api/people/${personId}`, {
      method: 'PUT',
      body: JSON.stringify({ ...person, status: 'inactive' })
    });
  } else if (!confirm(`Delete ${personName(person)}? This cannot be undone.`)) {
    return;
  } else {
    await api(`/api/people/${personId}`, { method: 'DELETE' });
  }
  await loadBaseData();
  await render();
}

async function renderPersonDetail(personId) {
  const person = await api(`/api/people/${personId}`);
  const assigned = state.assets.filter((a) => a.currentAssignment?.person?.id === personId);
  const documents = person.documents || await api(`/api/people/${personId}/documents`);
  if (!state.handoverDocuments.length) {
    state.handoverDocuments = await api('/api/handover-documents');
  }
  const personHandovers = state.handoverDocuments.filter((document) => document.personId === personId);

  app.innerHTML = `
    <div class="toolbar">
      <div style="display:flex;align-items:center;gap:0.75rem">
        <button id="backToPeople">← People</button>
        <div>
          <h1>${escapeHtml(personName(person))}</h1>
          <p class="muted">${escapeHtml(person.department || '')}${person.department && person.role ? ' · ' : ''}${escapeHtml(person.role || '')}</p>
        </div>
      </div>
      <button data-edit-person-detail="${person.id}">Edit</button>
    </div>
    <div class="grid" style="margin-top:0">
      <section class="panel">
        <h3>Contact</h3>
        <p><strong>Email:</strong> ${escapeHtml(person.email || '—')}</p>
        <p><strong>Phone:</strong> ${escapeHtml(person.phone || '—')}</p>
        <p><strong>Manager:</strong> ${escapeHtml(person.manager || '—')}</p>
        <p><strong>Location:</strong> ${escapeHtml(person.location || '—')}</p>
        <p><strong>Status:</strong> ${person.status === 'active' ? '<span class="badge ok">Active</span>' : '<span class="badge">Inactive</span>'}</p>
        ${person.notes ? `<p class="muted">${escapeHtml(person.notes)}</p>` : ''}
      </section>
      <section class="panel">
        <h3>Assigned devices (${assigned.length})</h3>
        ${assigned.length === 0
          ? '<p class="muted">No devices currently assigned.</p>'
          : `<table><thead><tr><th>Asset</th><th>Model</th><th>Serial</th><th title="Enrollment date from Intune/Jamf; Mac shows last enrollment when available">Enrolled</th><th></th></tr></thead><tbody>
              ${assigned.map((asset) => `<tr>
                <td>${escapeHtml(asset.assetTag)}</td>
                <td>${escapeHtml(assetModelName(asset))}</td>
                <td>${escapeHtml(asset.serialNumber)}</td>
                <td>${escapeHtml(enrolledDateLabel(asset))}</td>
                <td><button data-view="${asset.id}">Details</button></td>
              </tr>`).join('')}
            </tbody></table>`
        }
      </section>
    </div>
    <section class="panel" style="margin-top:1rem">
      <h3>Documente IT / PV (PDF)</h3>
      <p class="muted">Incarca PV-uri semnate sau alte documente IT legate de alocare.</p>
      <form id="personDocumentForm" class="grid">
        <label>Tip document
          <select name="docType" required>
            <option value="pv_primire">PV primire</option>
            <option value="pv_predare">PV predare</option>
            <option value="alocare">Alocare</option>
            <option value="altul">Alt document IT</option>
          </select>
        </label>
        <label>Titlu
          <input name="title" placeholder="Ex: PV primire semnat">
        </label>
        <label>Leaga de PV generat
          <select name="handoverDocumentId">
            <option value="">— Optional —</option>
            ${personHandovers.map((document) => `
              <option value="${attr(document.id)}">${escapeHtml(document.type)} · ${escapeHtml(document.date)} · ${document.assetCount || 0} device</option>
            `).join('')}
          </select>
        </label>
        <label>Observatii
          <input name="notes" placeholder="Optional">
        </label>
        <label>PDF
          <input name="file" type="file" accept="application/pdf,.pdf" required>
        </label>
        <div class="actions"><button class="primary">Upload PDF</button></div>
      </form>
      <div style="margin-top:1rem">
        ${documents.length
          ? table(['Tip', 'Titlu', 'Data', 'Fisier', ''], documents.map((document) => [
            escapeHtml(personDocTypeLabel(document.docType)),
            escapeHtml(document.title || '—'),
            escapeHtml((document.createdAt || '').slice(0, 10)),
            `<a href="/api/person-documents/${document.id}" target="_blank">${escapeHtml(document.originalName || 'PDF')}</a>`,
            `<button class="danger" data-delete-doc="${document.id}">Delete</button>`
          ]))
          : '<p class="muted">Niciun document incarcat.</p>'}
      </div>
    </section>
  `;
  document.querySelector('#backToPeople').addEventListener('click', () => navigate('people'));
  document.querySelector('[data-edit-person-detail]').addEventListener('click', () => showPersonForm(person));
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => showAssetDetail(button.dataset.view)));
  document.querySelector('#personDocumentForm').addEventListener('submit', (event) => uploadPersonDocument(event, personId));
  document.querySelectorAll('[data-delete-doc]').forEach((button) => {
    button.addEventListener('click', () => deletePersonDocument(button.dataset.deleteDoc, personId));
  });
}

async function uploadPersonDocument(event, personId) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  await fetch(`/api/people/${personId}/documents`, {
    method: 'POST',
    headers: { 'X-IT-Actor': actorInput.value || 'IT' },
    body: formData
  }).then(handleResponse);
  await loadBaseData();
  await renderPersonDetail(personId);
}

async function deletePersonDocument(documentId, personId) {
  if (!confirm('Stergi acest document PDF?')) return;
  await api(`/api/person-documents/${documentId}`, { method: 'DELETE' });
  await loadBaseData();
  await renderPersonDetail(personId);
}

async function renderHandoverDocuments() {
  state.handoverDocuments = await api('/api/handover-documents');
  const today = new Date().toISOString().slice(0, 10);
  const peopleOptions = state.people
    .slice()
    .sort((a, b) => personName(a).localeCompare(personName(b), 'ro'))
    .map((person) => `<option value="${attr(person.id)}">${escapeHtml(personName(person))} - ${escapeHtml(person.department || '')}</option>`)
    .join('');

  app.innerHTML = `
    <div class="toolbar">
      <div>
        <h1>PV-uri</h1>
        <p class="muted">Procese verbale de primire/predare generate din alocarile existente.</p>
      </div>
    </div>
    <section class="panel">
      <form id="handoverForm" class="grid">
        <label>Tip PV
          <select name="type">
            <option value="primire">Primire</option>
            <option value="predare">Predare</option>
          </select>
        </label>
        <label>Data
          <input name="date" type="date" value="${today}" required>
        </label>
        <label>Persoana
          <select name="personId" id="handoverPerson" required>
            <option value="">— Selecteaza persoana —</option>
            ${peopleOptions}
          </select>
        </label>
        <label>Intocmit de IT
          <select name="itOperator" required>
            ${(state.settings?.handoverOperators || ['Andrei Popescu', 'Dan Istrate'])
              .map((name) => `<option value="${attr(name)}">${escapeHtml(name)}</option>`)
              .join('')}
          </select>
        </label>
        <label style="grid-column:span 2">Observatii / randuri extra in tabel
          <textarea name="notes" placeholder="Ex: Card Securitate sau Tip|Model|IMEI|Serial"></textarea>
        </label>
        <div id="handoverAssets" style="grid-column:span 2"></div>
        <div class="actions" style="grid-column:span 2">
          <button type="button" id="previewHandover">Preview</button>
          <button class="primary">Create &amp; download DOCX</button>
        </div>
      </form>
    </section>
    <section id="handoverPreview" style="margin-top:1rem"></section>
    <section class="panel" style="margin-top:1rem">
      <h2>PV-uri generate</h2>
      ${table(['Data', 'Tip', 'Persoana', 'IT', 'Echipamente', 'Download'], state.handoverDocuments.map((document) => [
        escapeHtml(document.date),
        escapeHtml(handoverTypeLabel(document.type)),
        escapeHtml(personName(document.person)),
        escapeHtml(document.itOperator),
        String(document.assetCount || 0),
        `<a href="/api/handover-documents/${document.id}/download">DOCX</a>`
      ]))}
    </section>
  `;

  const form = document.querySelector('#handoverForm');
  const personSelect = document.querySelector('#handoverPerson');
  const renderAssets = () => drawHandoverAssetChoices(personSelect.value);
  personSelect.addEventListener('change', renderAssets);
  renderAssets();
  document.querySelector('#previewHandover').addEventListener('click', () => previewHandoverForm(form));
  form.addEventListener('submit', createHandoverDocument);
}

function drawHandoverAssetChoices(personId) {
  const container = document.querySelector('#handoverAssets');
  if (!container) return;
  const assets = state.assets.filter((asset) => asset.currentAssignment?.person?.id === personId);
  if (!personId) {
    container.innerHTML = '<p class="muted">Selecteaza o persoana pentru a vedea echipamentele alocate.</p>';
    return;
  }
  if (!assets.length) {
    container.innerHTML = '<p class="muted">Persoana nu are echipamente active in inventar.</p>';
    return;
  }
  container.innerHTML = `
    <fieldset class="panel" style="box-shadow:none">
      <legend>Echipamente incluse in PV</legend>
      ${assets.map((asset) => `
        <label style="display:block;margin-top:0.35rem">
          <input type="checkbox" name="assetIds" value="${attr(asset.id)}" checked>
          ${escapeHtml(asset.assetTag)} - ${escapeHtml(assetModelName(asset))} - SN ${escapeHtml(asset.serialNumber)}
        </label>
      `).join('')}
    </fieldset>
  `;
}

async function previewHandoverForm(form) {
  const payload = handoverPayload(form);
  const preview = await api('/api/handover-documents/preview', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  drawHandoverPreview(preview);
}

async function createHandoverDocument(event) {
  event.preventDefault();
  const payload = handoverPayload(event.currentTarget);
  const document = await api('/api/handover-documents', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  window.location.href = `/api/handover-documents/${document.id}/download`;
  await renderHandoverDocuments();
}

function handoverPayload(form) {
  const data = new FormData(form);
  return {
    type: data.get('type'),
    date: data.get('date'),
    personId: data.get('personId'),
    itOperator: data.get('itOperator'),
    notes: data.get('notes'),
    assetIds: data.getAll('assetIds')
  };
}

function drawHandoverPreview(handover) {
  const container = window.document.querySelector('#handoverPreview');
  if (!container) return;
  const rows = handoverTableRows(handover.assets || [], handover.notes);
  const intro = handover.type === 'predare'
    ? 's-au returnat urmatoarele'
    : 's-au predat urmatoarele';
  container.innerHTML = `
    <section class="panel">
      <h2>Preview ${escapeHtml(handoverTypeLabel(handover.type))}</h2>
      <p class="muted">Tchibo Brands Romania — PROCES VERBAL de predare – primire</p>
      <p><strong>Incheiat astazi:</strong> ${escapeHtml(formatRoDate(handover.date))}</p>
      <p><strong>Persoana:</strong> ${escapeHtml(personName(handover.person))} &nbsp; <strong>IT:</strong> ${escapeHtml(handover.itOperator)}</p>
      <p class="muted">${escapeHtml(intro)}</p>
      ${table(['Tip', 'Model', 'IMEI / UDID / Tel.', 'Serial No.'], rows.map((row) => [
        escapeHtml(row.tip),
        escapeHtml(row.model),
        escapeHtml(row.imei),
        escapeHtml(row.serial)
      ]))}
    </section>
  `;
}

function handoverTableRows(assets, notes = '') {
  const rows = assets.map(handoverAssetTableRow);
  for (const line of String(notes || '').split('\n').map((item) => item.trim()).filter(Boolean)) {
    if (line.includes('|')) {
      const [tip, model = '', imei = '', serial = ''] = line.split('|').map((part) => part.trim());
      rows.push({ tip, model, imei, serial });
    } else {
      rows.push({ tip: line, model: '', imei: '', serial: '' });
    }
  }
  return rows;
}

function handoverAssetTableRow(asset) {
  const isPhone = asset.category?.name === 'Telefon' || asset.model?.deviceType === 'Telefon';
  if (isPhone) {
    return {
      tip: 'Telefon',
      model: handoverModelLabel(asset),
      imei: asset.imei || asset.assetTag || '',
      serial: asset.serialNumber || ''
    };
  }
  return {
    tip: 'Laptop + Incarcator + mouse',
    model: handoverModelLabel(asset),
    imei: asset.assetTag || '',
    serial: asset.serialNumber || ''
  };
}

function handoverModelLabel(asset) {
  const brand = asset.brand?.name || '';
  const name = asset.model?.name || '';
  const generation = asset.model?.generation || '';
  if (brand.includes('MacBook')) return [name, generation].filter(Boolean).join(' ').trim();
  if (brand.includes('Lenovo') || name.includes('ThinkPad')) {
    const gen = generation.replace(/^Gen\s*/i, 'G');
    return [name.replace(/^ThinkPad\s*/i, ''), gen ? `G${gen.replace(/^G/, '')}` : '']
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim() || name;
  }
  if (name.startsWith('iPhone')) return name;
  return [brand, name, generation].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function formatRoDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

function handoverTypeLabel(type) {
  return type === 'predare' ? 'Predare' : 'Primire';
}

function renderImport() {
  const activeTab = state.importTab || 'csv';
  app.innerHTML = `
    <div class="toolbar">
      <div>
        <h1>Import</h1>
        <p class="muted">Import devices from Intune / Jamf exports, users from Entra / Intune, or supplier invoice PDFs.</p>
      </div>
    </div>
    <div class="tabs" style="margin-bottom:1rem">
      <button id="tabCsv" class="${activeTab === 'csv' ? 'primary' : ''}">Intune / Jamf (CSV)</button>
      <button id="tabUsers" class="${activeTab === 'users' ? 'primary' : ''}">Entra / Intune users</button>
      <button id="tabInvoice" class="${activeTab === 'invoice' ? 'primary' : ''}">New order invoice (PDF)</button>
    </div>
    <div id="importTabContent"></div>
  `;

  document.querySelector('#tabCsv').addEventListener('click', () => { state.importTab = 'csv'; renderImport(); });
  document.querySelector('#tabUsers').addEventListener('click', () => { state.importTab = 'users'; renderImport(); });
  document.querySelector('#tabInvoice').addEventListener('click', () => { state.importTab = 'invoice'; renderImport(); });

  if (activeTab === 'csv') {
    renderCsvImportTab();
  } else if (activeTab === 'users') {
    renderUserImportTab();
  } else {
    renderInvoiceImportTab();
  }
}

function renderCsvImportTab() {
  document.querySelector('#importTabContent').innerHTML = `
    <section class="panel">
      <form id="importForm" class="grid">
        <label>Source
          <select name="source">
            <option value="auto">Auto detect</option>
            <option value="intune">Intune</option>
            <option value="jamf">Jamf</option>
          </select>
        </label>
        <label>Device filter
          <select name="deviceFilter">
            <option value="all">All from file</option>
            <option value="laptops">Laptops</option>
            <option value="phones">Phones</option>
            <option value="macbooks">MacBooks</option>
            <option value="mtr">MTR (RO + BG)</option>
            <option value="mtr_ro">MTR RO</option>
            <option value="mtr_bg">MTR BG</option>
          </select>
        </label>
        <label>Import mode
          <select name="mode">
            <option value="upsert">Create and update</option>
            <option value="create_only">New devices only</option>
            <option value="update_only">Updates only</option>
          </select>
        </label>
        <label>CSV / ZIP file
          <input name="file" type="file" accept=".csv,.zip,text/csv,application/zip" required>
        </label>
        <div class="actions"><button class="primary">Preview import</button></div>
      </form>
    </section>
    <section id="importPreview" style="margin-top:1rem"></section>
  `;
  document.querySelector('#importForm').addEventListener('submit', previewImport);
  if (state.importPreview) drawImportPreview();
}

function renderUserImportTab() {
  document.querySelector('#importTabContent').innerHTML = `
    <section class="panel">
      <p class="muted" style="margin-bottom:1rem">
        Importa utilizatori din export Entra (Users CSV) sau extrage utilizatori unici din exportul Intune de dispozitive.
        Campurile populate: nume, email, departament, functie, telefon, manager, locatie, status.
      </p>
      <form id="userImportForm" class="grid">
        <label>Source
          <select name="source">
            <option value="auto">Auto detect</option>
            <option value="entra">Entra users (CSV)</option>
            <option value="intune_users">Intune devices (extract users)</option>
          </select>
        </label>
        <label>Import mode
          <select name="mode">
            <option value="upsert">Create and update</option>
            <option value="create_only">New users only</option>
            <option value="update_only">Updates only</option>
          </select>
        </label>
        <label>CSV / ZIP file
          <input name="file" type="file" accept=".csv,.zip,text/csv,application/zip" required>
        </label>
        <div class="actions"><button class="primary">Preview users</button></div>
      </form>
    </section>
    <section id="userImportPreview" style="margin-top:1rem"></section>
  `;
  document.querySelector('#userImportForm').addEventListener('submit', previewUserImport);
  if (state.userImportPreview) drawUserImportPreview();
}

async function previewUserImport(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const response = await fetch('/api/import/users/preview', {
    method: 'POST',
    headers: { 'X-IT-Actor': actorInput.value || 'IT' },
    body: formData
  }).then(handleResponse);
  state.userImportPreview = response;
  drawUserImportPreview();
}

function drawUserImportPreview() {
  const preview = state.userImportPreview;
  if (!preview) return;
  const rows = preview.rows.map((row) => [
    row.line,
    importActionBadge(row),
    escapeHtml(row.personName || '-'),
    escapeHtml(row.personEmail || '-'),
    escapeHtml(row.personDepartment || '-'),
    escapeHtml(row.personRole || '-'),
    escapeHtml(row.personPhone || '-'),
    badge(
      row.personMatch === 'existing' || row.personMatch === 'existing_mtr'
        ? (row.personMatch === 'existing_mtr' ? 'Existing MTR' : 'Existing')
        : (row.personMatch === 'new_mtr' ? 'New MTR' : 'New'),
      row.personMatch === 'existing' || row.personMatch === 'existing_mtr' ? '' : 'ok'
    ),
    escapeHtml(row.warnings.join('; '))
  ]);
  document.querySelector('#userImportPreview').innerHTML = `
    <div class="panel">
      <div class="toolbar">
        <div>
          <h2>Preview users — ${escapeHtml(preview.source === 'entra' ? 'Entra' : 'Intune extract')}</h2>
          <p class="muted">
            Rows in file: ${preview.summary.total},
            unique users: ${preview.summary.mapped},
            new: ${preview.summary.create},
            updates: ${preview.summary.update},
            MTR rooms: ${(preview.summary.create_mtr || 0) + (preview.summary.update_mtr || 0)},
            skipped: ${preview.summary.skip}
          </p>
        </div>
        <button class="primary" id="applyUserImport">Import users</button>
      </div>
      ${table(['Line', 'Action', 'Name', 'Email', 'Department', 'Role', 'Phone', 'Match', 'Warnings'], rows)}
    </div>
  `;
  document.querySelector('#applyUserImport')?.addEventListener('click', applyUserImportPreview);
}

async function applyUserImportPreview() {
  if (!state.userImportPreview) return;
  const result = await api('/api/import/users/apply', {
    method: 'POST',
    body: JSON.stringify(state.userImportPreview)
  });
  state.userImportPreview = null;
  await loadBaseData();
  app.innerHTML = `
    <section class="panel">
      <h1>User import complete</h1>
      <p>Users imported / updated: <strong>${result.summary.imported}</strong> (new: ${result.summary.created}, updated: ${result.summary.updated})</p>
      <p>Rows skipped: <strong>${result.summary.skipped}</strong></p>
      <button class="primary" id="goPeople">View people</button>
    </section>
  `;
  document.querySelector('#goPeople').addEventListener('click', () => navigate('people'));
}

function renderInvoiceImportTab() {
  document.querySelector('#importTabContent').innerHTML = `
    <section class="panel">
      <p class="muted" style="margin-bottom:1rem">
        Upload a supplier invoice PDF. The app will extract serial numbers and model names,
        then create new devices with status <strong>In stock</strong>. The invoice is attached to each created device.
      </p>
      <form id="invoiceImportForm" class="grid">
        <label>Invoice number
          <input name="invoiceNumber" placeholder="e.g. F-2026-1234">
        </label>
        <label>Invoice date
          <input name="invoiceDate" type="date">
        </label>
        <label>Vendor / Supplier
          <input name="vendor" placeholder="e.g. Altex, eMAG, Flanco">
        </label>
        <label>Total amount
          <input name="amount" placeholder="e.g. 12500 RON">
        </label>
        <label>Invoice template
          <select name="templateId" id="invoiceTemplateSelect">
            <option value="auto">Auto detect</option>
          </select>
        </label>
        <label>Invoice PDF *
          <input name="file" type="file" accept="application/pdf,.pdf" required>
        </label>
        <div class="actions"><button class="primary">Upload &amp; Preview</button></div>
      </form>
    </section>
    <section id="invoicePreviewSection" style="margin-top:1rem"></section>
  `;
  document.querySelector('#invoiceImportForm').addEventListener('submit', previewInvoiceImport);
  bindInvoicePdfAutofill(document.querySelector('#invoiceImportForm'));
  loadInvoiceTemplateOptions();
  if (state.invoicePreview) drawInvoicePreview();
}

async function loadInvoiceTemplateOptions() {
  const select = document.querySelector('#invoiceTemplateSelect');
  if (!select) return;
  const saved = state.invoiceTemplateId || 'auto';
  try {
    const templates = await api('/api/import/invoices/templates');
    select.innerHTML = '<option value="auto">Auto detect</option>' +
      templates.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}</option>`).join('');
  } catch {
    select.innerHTML = `
      <option value="auto">Auto detect</option>
      <option value="fks">FKS</option>
      <option value="cancom">Cancom Romania</option>
      <option value="chrome">Chrome Computers</option>
      <option value="altex">Altex / eMAG</option>
      <option value="flanco">Flanco / PC Garage</option>
      <option value="generic">Generic (broad detection)</option>`;
  }
  select.value = [...select.options].some((o) => o.value === saved) ? saved : 'auto';
  select.addEventListener('change', () => { state.invoiceTemplateId = select.value; });
}

async function previewImport(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const response = await fetch('/api/import/preview', {
    method: 'POST',
    headers: { 'X-IT-Actor': actorInput.value || 'IT' },
    body: formData
  }).then(handleResponse);
  state.importPreview = response;
  drawImportPreview();
}

function drawImportPreview() {
  const preview = state.importPreview;
  if (!preview) return;
  const filter = state.importPreviewFilter || 'all';
  const visibleRows = preview.rows.filter((row) => {
    if (filter === 'needsReview') return row.needsReview;
    if (filter === 'skip') return row.action === 'skip';
    if (filter === 'create') return row.action === 'create' || row.intendedAction === 'create';
    return true;
  });
  const rows = visibleRows.map((row) => [
    `<input type="checkbox" data-select-import-row="${attr(row.rowKey)}">`,
    row.line,
    importActionBadge(row),
    escapeHtml(row.serialNumber || '-'),
    escapeHtml(row.assetTag || '-'),
    escapeHtml(row.modelLabel || row.modelText || '-'),
    row.needsReview ? modelSelect(row) : escapeHtml(row.modelMatch),
    escapeHtml(row.personName || row.personEmail || '-'),
    escapeHtml(row.warnings.join('; '))
  ]);
  document.querySelector('#importPreview').innerHTML = `
    <div class="panel">
      <div class="toolbar">
        <div>
          <h2>Preview ${escapeHtml(preview.source.toUpperCase())}</h2>
          <p class="muted">
            Rows in file: ${preview.summary.total},
            after filter: ${preview.summary.mapped},
            new: ${preview.summary.create},
            updates: ${preview.summary.update},
            reassignments: ${preview.summary.reassign},
            review: ${preview.summary.needsReview},
            skipped: ${preview.summary.skip}
          </p>
          <p class="muted">
            Manual model choices are saved on serial for the next import.
            Use bulk Skip / Resolve on selected rows.
          </p>
        </div>
        <button class="primary" id="applyImport" ${preview.summary.needsReview ? 'disabled' : ''}>Import devices</button>
      </div>
      <div class="filters">
        <select id="importPreviewFilter">
          <option value="all" ${filter === 'all' ? 'selected' : ''}>All rows</option>
          <option value="needsReview" ${filter === 'needsReview' ? 'selected' : ''}>Needs review</option>
          <option value="create" ${filter === 'create' ? 'selected' : ''}>Create</option>
          <option value="skip" ${filter === 'skip' ? 'selected' : ''}>Skipped</option>
        </select>
        <button type="button" id="bulkSkipImport">Bulk skip selected</button>
        <button type="button" id="bulkResolveImport">Bulk resolve selected (same model…)</button>
      </div>
      ${table(['', 'Line', 'Action', 'Serial', 'Asset', 'Detected model', 'Model match', 'Person', 'Warnings'], rows)}
    </div>
  `;
  document.querySelector('#importPreviewFilter')?.addEventListener('change', (event) => {
    state.importPreviewFilter = event.target.value;
    drawImportPreview();
  });
  document.querySelector('#bulkSkipImport')?.addEventListener('click', () => {
    const keys = selectedImportRowKeys();
    for (const row of preview.rows) {
      if (!keys.includes(row.rowKey)) continue;
      row.action = 'skip';
      row.intendedAction = 'skip';
      row.needsReview = false;
    }
    preview.summary.needsReview = preview.rows.filter((item) => item.needsReview).length;
    preview.summary.skip = preview.rows.filter((item) => item.action === 'skip').length;
    drawImportPreview();
  });
  document.querySelector('#bulkResolveImport')?.addEventListener('click', () => {
    const keys = selectedImportRowKeys();
    if (!keys.length) return alert('Select at least one row.');
    const models = state.catalog.models.map((model) => {
      const brand = state.catalog.brands.find((item) => item.id === model.brandId);
      return `<option value="${model.id}">${escapeHtml(displayModelName(model, brand))}</option>`;
    }).join('');
    dialogBody.innerHTML = `
      <h2>Bulk resolve model</h2>
      <form id="bulkModelForm" class="grid">
        <label>Model <select name="modelId" required>${models}</select></label>
        <div class="actions"><button class="primary">Apply to ${keys.length} rows</button></div>
      </form>
    `;
    document.querySelector('#bulkModelForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const modelId = formObject(event.currentTarget).modelId;
      const model = state.catalog.models.find((item) => item.id === modelId);
      const brand = state.catalog.brands.find((item) => item.id === model?.brandId);
      for (const row of preview.rows) {
        if (!keys.includes(row.rowKey)) continue;
        row.modelId = modelId;
        row.modelLabel = displayModelName(model, brand);
        row.modelMatch = 'manual';
        row.needsReview = false;
        row.action = row.intendedAction === 'skip' ? 'create' : (row.intendedAction || 'create');
        row.warnings = row.warnings.filter((warning) => !warning.includes('Model') && !warning.includes('model'));
      }
      preview.summary.needsReview = preview.rows.filter((item) => item.needsReview).length;
      dialog.close();
      drawImportPreview();
    });
    dialog.showModal();
  });
  document.querySelector('#applyImport')?.addEventListener('click', applyImportPreview);
  document.querySelectorAll('[data-model-override]').forEach((select) => {
    select.addEventListener('change', () => {
      const row = preview.rows.find((item) => item.rowKey === select.dataset.modelOverride);
      if (!row) return;
      const val = select.value;
      if (val === '__new__') {
        showNewModelForm(row, () => drawImportPreview(), { source: 'import' });
        return;
      }
      if (val) {
        row.modelId = val;
        row.modelLabel = select.selectedOptions[0].textContent;
        row.modelMatch = 'manual';
        row.needsReview = false;
        row.action = row.intendedAction;
        row.warnings = row.warnings.filter((warning) => !warning.includes('Model') && !warning.includes('model'));
        preview.summary.needsReview = preview.rows.filter((item) => item.needsReview).length;
        drawImportPreview();
      }
    });
  });
}

function selectedImportRowKeys() {
  return [...document.querySelectorAll('[data-select-import-row]:checked')].map((input) => input.dataset.selectImportRow);
}

async function applyImportPreview() {
  if (!state.importPreview) return;
  const modelOverrides = {};
  for (const row of state.importPreview.rows) {
    if (row.modelId && row.modelMatch === 'manual') modelOverrides[row.rowKey] = row.modelId;
  }
  const result = await api('/api/import/apply', {
    method: 'POST',
    body: JSON.stringify({
      ...state.importPreview,
      modelOverrides,
      persistModelOverrides: true
    })
  });
  state.importPreview = null;
  await loadBaseData();
  app.innerHTML = `
    <section class="panel">
      <h1>Import complete</h1>
      <p>Devices imported / updated: <strong>${result.summary.imported}</strong></p>
      <p>Rows skipped: <strong>${result.summary.skipped}</strong></p>
      <p class="muted">Missing from this MDM source after import: <strong>${result.summary.missingFromImport ?? '—'}</strong></p>
      <button class="primary" id="goAssets">View devices</button>
    </section>
  `;
  document.querySelector('#goAssets').addEventListener('click', () => navigate('assets:all'));
}

// ---------------------------------------------------------------------------
// Invoice PDF import
// ---------------------------------------------------------------------------

async function previewInvoiceImport(event) {
  event.preventDefault();
  const btn = event.currentTarget.querySelector('button[type=submit], button.primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
  try {
    const formData = new FormData(event.currentTarget);
    const response = await fetch('/api/import/invoices/upload', {
      method: 'POST',
      headers: { 'X-IT-Actor': actorInput.value || 'IT' },
      body: formData
    }).then(handleResponse);
    state.invoicePreview = response;
    drawInvoicePreview();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Upload & Preview'; }
  }
}

function drawInvoicePreview() {
  const preview = state.invoicePreview;
  const container = document.querySelector('#invoicePreviewSection');
  if (!preview || !container) return;

  const catalogModels = state.catalog.models.map((m) => {
    const brand = state.catalog.brands.find((b) => b.id === m.brandId);
    return { id: m.id, label: displayModelName(m, brand) };
  });

  const hasUnresolved = preview.summary.needsReview > 0;

  const rows = preview.rows.map((row) => {
    const actionCell = invoiceActionBadge(row);
    const serialCell = escapeHtml(row.serial || '—');
    const artNrLine = row.artNr
      ? `<span style="font-size:0.85rem"><strong>MTM:</strong> ${escapeHtml(row.artNr)}</span><br>`
      : '';
    const modelTextCell = `${artNrLine}<span class="muted" style="font-size:0.85rem">${escapeHtml((row.modelText || '').slice(0, 60))}</span>`;
    const resolvedCell = row.needsReview
      ? invoiceModelSelect(row, catalogModels)
      : escapeHtml(row.modelLabel || row.modelMatch || '—');
    const warnCell = row.warnings.length
      ? `<span class="muted" style="font-size:0.85rem">${escapeHtml(row.warnings.join('; '))}</span>`
      : '';
    const detailsCell = `<button type="button" data-invoice-preview="${attr(row.rowKey)}">Details</button>`;
    return [actionCell, serialCell, modelTextCell, resolvedCell, warnCell, detailsCell];
  });

  container.innerHTML = `
    <div class="panel">
      <div class="toolbar">
        <div>
          <h2>Invoice preview — ${escapeHtml(preview.fileName)}</h2>
          <p class="muted">
            Rows detected: <strong>${preview.summary.total}</strong> &nbsp;|&nbsp;
            To create: <strong>${preview.summary.create}</strong> &nbsp;|&nbsp;
            Skipped: <strong>${preview.summary.skip}</strong> &nbsp;|&nbsp;
            Need review: <strong>${preview.summary.needsReview}</strong>
          </p>
          ${preview.invoiceMeta.invoiceNumber ? `<p class="muted">Invoice <strong>${escapeHtml(preview.invoiceMeta.invoiceNumber)}</strong> · ${escapeHtml(preview.invoiceMeta.invoiceDate)} · ${escapeHtml(preview.invoiceMeta.vendor)}</p>` : ''}
          ${preview.rows[0]?.purchaseDate ? `<p class="muted">On each new device: purchase <strong>${escapeHtml(preview.rows[0].purchaseDate)}</strong>${preview.rows[0].warrantyUntil ? `, warranty until <strong>${escapeHtml(preview.rows[0].warrantyUntil)}</strong>${preview.rows[0].warrantyMonths ? ` (${preview.rows[0].warrantyMonths} months from invoice)` : ''}` : preview.rows[0].warrantyMonths ? `, warranty <strong>${preview.rows[0].warrantyMonths} months</strong> (from invoice)` : ', warranty <span class="muted">not found in PDF — set manually after import</span>'}</p>` : ''}
          ${hasUnresolved ? '<p class="muted" style="color:var(--danger)">Select a model for each highlighted row before importing.</p>' : ''}
        </div>
        <div class="actions">
          <button id="cancelInvoicePreview">Cancel</button>
          <button class="primary" id="applyInvoiceImport" ${hasUnresolved ? 'disabled' : ''}>
            Create ${preview.summary.create} device${preview.summary.create !== 1 ? 's' : ''} in stock
          </button>
        </div>
      </div>
      ${table(['Action', 'Serial', 'Model text from invoice', 'Resolved model', 'Warnings', ''], rows)}
    </div>
  `;

  document.querySelector('#cancelInvoicePreview').addEventListener('click', () => {
    state.invoicePreview = null;
    renderImport();
  });
  document.querySelector('#applyInvoiceImport')?.addEventListener('click', applyInvoiceImportPreview);

  document.querySelectorAll('[data-invoice-model]').forEach((select) => {
    select.addEventListener('change', () => {
      const rowKey = select.dataset.invoiceModel;
      const row = preview.rows.find((r) => r.rowKey === rowKey);
      if (!row) return;
      const val = select.value;

      if (val === '__new__') {
        showNewModelForm(row, () => drawInvoicePreview(), { source: 'invoice' });
        return;
      }

      if (val) {
        row.modelId = val;
        row.modelLabel = select.selectedOptions[0].textContent;
        row.modelMatch = 'manual';
        row.needsReview = false;
        row.action = 'create';
        row.warnings = row.warnings.filter((w) => !w.includes('match'));
      }
      preview.summary.needsReview = preview.rows.filter((r) => r.needsReview).length;
      drawInvoicePreview();
    });
  });

  document.querySelectorAll('[data-invoice-preview]').forEach((button) => {
    button.addEventListener('click', () => showInvoicePreviewRowDetail(button.dataset.invoicePreview));
  });
}

function invoicePreviewModelLabel(row) {
  if (row.modelLabel) return row.modelLabel;
  if (!row.modelId || !state.catalog) return '';
  const model = state.catalog.models.find((m) => m.id === row.modelId);
  if (!model) return '';
  const brand = state.catalog.brands.find((b) => b.id === model.brandId);
  return displayModelName(model, brand);
}

function showInvoicePreviewRowDetail(rowKey) {
  const preview = state.invoicePreview;
  const row = preview?.rows.find((r) => r.rowKey === rowKey);
  if (!row) return;

  const meta = preview.invoiceMeta || {};
  const modelLabel = invoicePreviewModelLabel(row) || row.modelText || '—';
  const plannedStatus = row.action === 'create' ? 'in_stock' : row.action === 'skip' ? '—' : '—';
  const existing = state.assets.find(
    (a) => a.serialNumber && row.serial && a.serialNumber.toUpperCase() === row.serial.toUpperCase()
  );

  const importAction = row.needsReview
    ? badge('Select model before import', 'warn')
    : row.action === 'create'
      ? badge('Will be created · In stock', 'ok')
      : row.action === 'skip'
        ? badge(row.modelMatch === 'duplicate' ? 'Skipped · Duplicate serial' : 'Skipped', '')
        : badge(row.action || '—', '');

  dialogBody.innerHTML = `
    <div class="detail">
      <h2>${escapeHtml(row.serial || '—')} — ${escapeHtml(modelLabel)}</h2>
      <p class="muted">Invoice import preview — device not in inventory yet</p>
      <p style="margin-top:0.5rem">${importAction}</p>
      <section class="panel">
        <h3>From invoice</h3>
        <p><strong>Serial:</strong> ${escapeHtml(row.serial || '—')}</p>
        <p><strong>Asset tag:</strong> ${escapeHtml(row.assetTag || row.serial || '—')}</p>
        ${row.artNr ? `<p><strong>MTM / product code:</strong> ${escapeHtml(row.artNr)}</p>` : ''}
        <p><strong>Model text (PDF):</strong> ${escapeHtml(row.modelText || '—')}</p>
        <p><strong>Resolved model:</strong> ${escapeHtml(modelLabel)}${row.modelMatch ? ` <span class="muted">(${escapeHtml(row.modelMatch)})</span>` : ''}</p>
        <p><strong>Qty:</strong> ${escapeHtml(String(row.qty ?? 1))}</p>
      </section>
      <section class="panel">
        <h3>Will be saved on device</h3>
        <p><strong>Status:</strong> ${plannedStatus === 'in_stock' ? badge('In stock', 'ok') : '<span class="muted">Not created</span>'}</p>
        <p><strong>Purchase date:</strong> ${escapeHtml(row.purchaseDate || meta.invoiceDate || '—')}</p>
        <p><strong>Warranty until:</strong> ${escapeHtml(row.warrantyUntil || '—')}${row.warrantyMonths ? ` <span class="muted">(${row.warrantyMonths} months from invoice)</span>` : ''}</p>
        <p><strong>Vendor:</strong> ${escapeHtml(meta.vendor || '—')}</p>
        <p><strong>CPU / RAM / Storage:</strong> <span class="muted">—</span> <span class="muted">(set after import or via Intune/Jamf)</span></p>
      </section>
      <section class="panel">
        <h3>Invoice</h3>
        <p><strong>Number:</strong> ${escapeHtml(meta.invoiceNumber || '—')}</p>
        <p><strong>Date:</strong> ${escapeHtml(meta.invoiceDate || '—')}</p>
        <p><strong>Amount:</strong> ${escapeHtml(meta.amount || '—')}</p>
        <p><strong>PDF:</strong> ${escapeHtml(preview.fileName || '—')}</p>
      </section>
      ${row.warnings.length ? `<section class="panel"><h3>Warnings</h3><ul>${row.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></section>` : ''}
      ${existing ? `<section class="panel"><h3>Existing device</h3><p class="muted">This serial is already in inventory.</p><p><button type="button" class="primary" id="viewExistingFromInvoicePreview">Open device details</button></p></section>` : ''}
      <div class="actions" style="margin-top:1rem"><button type="button" id="closeInvoicePreviewDetail">Close</button></div>
    </div>
  `;

  document.querySelector('#closeInvoicePreviewDetail').addEventListener('click', () => dialog.close());
  document.querySelector('#viewExistingFromInvoicePreview')?.addEventListener('click', () => {
    dialog.close();
    showAssetDetail(existing.id);
  });
  dialog.showModal();
}

function invoiceModelSelect(row, models) {
  return `<select data-invoice-model="${attr(row.rowKey)}" style="min-width:160px">
    <option value="">— Select model —</option>
    ${models.map((m) => `<option value="${attr(m.id)}">${escapeHtml(m.label)}</option>`).join('')}
    <option value="__new__">+ Create new model…</option>
  </select>`;
}

function invoiceActionBadge(row) {
  if (row.action === 'skip') return badge(row.modelMatch === 'duplicate' ? 'Duplicate' : 'Skipped', '');
  if (row.needsReview) return badge('Select model', 'warn');
  return badge('New · In stock', 'ok');
}

function showNewModelForm(row, onDone, options = {}) {
  const source = options.source || 'invoice';
  const serial = row.serialNumber || row.serial || '-';
  const detectedText = row.modelText || '';
  const deviceType = guessImportDeviceType(row) || 'Laptop';
  const suggestedBrand = guessImportBrand(row);
  const suggestedName = suggestModelNameFromRow(row);
  const brands = state.catalog.brands.map((b) => {
    const selected = b.name === suggestedBrand ? ' selected' : '';
    return `<option value="${attr(b.id)}"${selected}>${escapeHtml(b.name)}</option>`;
  }).join('');
  const brandOptions = suggestedBrand && !state.catalog.brands.some((b) => b.name === suggestedBrand)
    ? `<option value="__newbrand__" data-new-brand="${attr(suggestedBrand)}" selected>${escapeHtml(suggestedBrand)} (new brand)</option>${brands}`
    : brands;
  dialogBody.innerHTML = `
    <h2>Create new model</h2>
    <p class="muted">Serial: <strong>${escapeHtml(serial)}</strong></p>
    <p class="muted">Detected: <em>${escapeHtml(detectedText.slice(0, 80))}</em></p>
    <form id="newModelForm" class="grid">
      <label>Brand *
        <select name="brandId" id="newModelBrand" required>
          <option value="">— Select brand —</option>
          ${brandOptions}
        </select>
      </label>
      <label>Model name * <input name="name" required placeholder="e.g. Galaxy S24 or 2409BRN2CY" value="${attr(suggestedName)}"></label>
      <label>Generation <input name="generation" placeholder="e.g. Gen 6 or Standard" value="Standard"></label>
      <label>Device type
        <select name="deviceType">
          <option value="Laptop" ${deviceType === 'Laptop' ? 'selected' : ''}>Laptop</option>
          <option value="Telefon" ${deviceType === 'Telefon' ? 'selected' : ''}>Phone</option>
        </select>
      </label>
      <div class="actions"><button class="primary">Save &amp; assign to row</button></div>
    </form>
  `;
  document.querySelector('#newModelForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = formObject(form);
    const brandSelect = form.querySelector('#newModelBrand');
    const newBrand = brandSelect.selectedOptions[0]?.dataset?.newBrand;
    if (payload.brandId === '__newbrand__' || newBrand) {
      delete payload.brandId;
      payload.brandName = newBrand || suggestedBrand;
      payload.categoryName = payload.deviceType === 'Telefon' ? 'Telefon' : 'Laptop';
    }
    const created = await api('/api/catalog/models', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    row.modelId = created.id;
    row.modelLabel = displayModelName(created, state.catalog.brands.find((b) => b.id === created.brandId));
    row.modelMatch = 'new';
    row.needsReview = false;
    row.action = source === 'import' ? (row.intendedAction || row.action) : 'create';
    row.newModelRef = null;
    row.warnings = (row.warnings || []).filter((w) => !/model/i.test(w));
    if (source === 'import' && state.importPreview) {
      state.importPreview.summary.needsReview = state.importPreview.rows.filter((r) => r.needsReview).length;
    }
    if (source === 'invoice' && state.invoicePreview) {
      state.invoicePreview.summary.needsReview = state.invoicePreview.rows.filter((r) => r.needsReview).length;
    }
    state.catalog = await api('/api/catalog');
    dialog.close();
    onDone();
  });
  dialog.showModal();
}

async function applyInvoiceImportPreview() {
  if (!state.invoicePreview) return;
  const btn = document.querySelector('#applyInvoiceImport');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating devices…'; }
  try {
    const result = await api('/api/import/invoices/apply', {
      method: 'POST',
      body: JSON.stringify({ preview: state.invoicePreview, savedFile: state.invoicePreview._savedFile })
    });
    state.invoicePreview = null;
    state.importTab = 'invoice';
    await loadBaseData();
    app.innerHTML = `
      <section class="panel">
        <h1>Invoice import complete</h1>
        <p>Devices created (in stock): <strong>${result.summary.created}</strong></p>
        <p>Rows skipped: <strong>${result.summary.skipped}</strong></p>
        <button class="primary" id="goStock">View in-stock devices</button>
      </section>
    `;
    document.querySelector('#goStock').addEventListener('click', () => {
      state.assetFilters = { status: 'in_stock', model: '', category: '' };
      navigate('assets:all');
    });
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = `Create devices in stock`; }
    throw err;
  }
}

async function showAssetDetail(id) {
  const asset = await api(`/api/assets/${id}`);
  state.selectedAsset = asset;
  const latestInvoice = [...(asset.invoices || [])].sort((a, b) =>
    String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  )[0];
  dialogBody.innerHTML = `
    <div class="detail">
      <h2>${escapeHtml(asset.assetTag)} - ${escapeHtml(assetModelName(asset))}</h2>
      <div class="tabs">
        <button id="editAsset">Edit</button>
        <button id="assignAsset">Reassign</button>
        ${asset.currentAssignment ? '<button class="danger" id="unassignAsset">Return to stock</button>' : ''}
        <button class="danger" id="deleteAsset">Hard delete</button>
      </div>
      <section class="panel">
        <h3>Details</h3>
        <p><strong>Serial:</strong> ${escapeHtml(asset.serialNumber)} | <strong>Status:</strong> ${statusLabel(asset.status)}</p>
        <p><strong>MDM:</strong> ${escapeHtml(asset.importMeta?.source || '—')}
          ${asset.importMeta?.missingFromLastImport ? ' · <span class="badge warn">missing from last import</span>' : ''}
          ${asset.importMeta?.lastImportedAt ? ` · last import ${escapeHtml(asset.importMeta.lastImportedAt.slice(0, 10))}` : ''}
        </p>
        <p><strong>CPU / RAM / Storage:</strong> ${escapeHtml(asset.cpu)} / ${escapeHtml(asset.ram)} / ${escapeHtml(asset.storage)}</p>
        <p><strong>IMEI:</strong> ${escapeHtml(asset.imei)} | <strong>OS:</strong> ${escapeHtml(asset.operatingSystem)}</p>
        <p><strong>Warranty until:</strong> ${escapeHtml(asset.warrantyUntil)} | <strong>Vendor:</strong> ${escapeHtml(asset.vendor)}</p>
        <p><strong>Currently assigned to:</strong> ${personName(asset.currentAssignment?.person) || 'Unassigned'}</p>
        <p>${escapeHtml(asset.notes)}</p>
      </section>
      <section class="panel">
        <h3>Invoices (PDF)</h3>
        <form id="invoiceForm" class="grid">
          <p class="muted" style="grid-column:1/-1;margin:0">Fields auto-fill when you select a PDF (invoice number, date, vendor, total).</p>
          <label>Invoice number <input name="invoiceNumber" value="${attr(latestInvoice?.invoiceNumber)}"></label>
          <label>Invoice date <input name="invoiceDate" type="date" value="${attr(latestInvoice?.invoiceDate)}"></label>
          <label>Vendor <input name="vendor" value="${attr(latestInvoice?.vendor)}"></label>
          <label>Amount <input name="amount" value="${attr(latestInvoice?.amount)}"></label>
          <label>PDF <input name="file" type="file" accept="application/pdf" required></label>
          <div class="actions"><button class="primary">Upload invoice</button></div>
        </form>
        ${simpleList(asset.invoices, (invoice) => `<a href="/api/invoices/${invoice.id}" target="_blank">${escapeHtml(invoice.originalName)}</a> - ${escapeHtml(invoice.invoiceNumber)} ${escapeHtml(invoice.invoiceDate)}`)}
      </section>
      <section class="panel">
        <h3>Assignment history</h3>
        ${simpleList(asset.assignments, (assignment) => `${personName(assignment.person)}: ${assignment.assignedAt} ${assignment.endedAt ? `- ${assignment.endedAt}` : '- present'} (${escapeHtml(assignment.reason)})`)}
      </section>
      <section class="panel">
        <h3>Audit log</h3>
        <div class="timeline">
          ${asset.auditLogs.map((log) => `<div class="timeline-item"><strong>${escapeHtml(actionLabel(log.action))}</strong><br><span class="muted">${escapeHtml(log.timestamp)} by ${escapeHtml(log.actor)}</span></div>`).join('') || '<p class="muted">No events.</p>'}
        </div>
      </section>
    </div>
  `;
  document.querySelector('#editAsset').addEventListener('click', () => showAssetForm(asset));
  document.querySelector('#assignAsset').addEventListener('click', () => showAssignForm(asset));
  document.querySelector('#unassignAsset')?.addEventListener('click', () => unassignAsset(asset));
  document.querySelector('#deleteAsset').addEventListener('click', () => deleteAsset(asset));
  document.querySelector('#invoiceForm').addEventListener('submit', (event) => uploadInvoice(event, asset.id));
  bindInvoicePdfAutofill(document.querySelector('#invoiceForm'));
  dialog.showModal();
}

function showAssetForm(asset = {}) {
  const models = state.catalog.models.map((model) => {
    const brand = state.catalog.brands.find((item) => item.id === model.brandId);
    return `<option value="${model.id}" ${asset.modelId === model.id ? 'selected' : ''}>${escapeHtml(displayModelName(model, brand))}</option>`;
  }).join('');
  dialogBody.innerHTML = `
    <h2>${asset.id ? 'Edit device' : 'Add device'}</h2>
    <form id="assetForm" class="grid">
      <label>Asset tag * <input name="assetTag" required value="${attr(asset.assetTag)}"></label>
      <label>Serial * <input name="serialNumber" required value="${attr(asset.serialNumber)}"></label>
      <label>Model * <select name="modelId" required>${models}</select></label>
      <label>Status <select name="status">
        ${option('in_stock', 'In stock', asset.status)}
        ${option('assigned', 'Assigned', asset.status)}
        ${option('deployed', 'Deployed (MTR)', asset.status)}
        ${option('service', 'Service', asset.status)}
        ${option('retired', 'Retired', asset.status)}
      </select></label>
      <label>RAM <input name="ram" value="${attr(asset.ram)}"></label>
      <label>Storage <input name="storage" value="${attr(asset.storage)}"></label>
      <label>CPU <input name="cpu" value="${attr(asset.cpu)}"></label>
      <label>IMEI <input name="imei" value="${attr(asset.imei)}"></label>
      <label>Operating system <input name="operatingSystem" value="${attr(asset.operatingSystem)}"></label>
      <label>Warranty until <input name="warrantyUntil" type="date" value="${attr(asset.warrantyUntil)}"></label>
      <label>Purchase date <input name="purchaseDate" type="date" value="${attr(asset.purchaseDate)}"></label>
      <label>Vendor <input name="vendor" value="${attr(asset.vendor)}"></label>
      <label>Notes <textarea name="notes">${escapeHtml(asset.notes)}</textarea></label>
      <div class="actions"><button class="primary">Save</button></div>
    </form>
  `;
  document.querySelector('#assetForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = formObject(event.currentTarget);
    await api(asset.id ? `/api/assets/${asset.id}` : '/api/assets', {
      method: asset.id ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
    await refreshAfterMutation();
  });
  dialog.showModal();
}

function showPersonForm(person = {}) {
  dialogBody.innerHTML = `
    <h2>${person.id ? 'Edit person' : 'Add person'}</h2>
    <form id="personForm" class="grid">
      <label>First name * <input name="firstName" required value="${attr(person.firstName)}"></label>
      <label>Last name * <input name="lastName" required value="${attr(person.lastName)}"></label>
      <label>Department <input name="department" value="${attr(person.department)}"></label>
      <label>Role <input name="role" value="${attr(person.role)}"></label>
      <label>Email <input name="email" type="email" value="${attr(person.email)}"></label>
      <label>Phone <input name="phone" value="${attr(person.phone)}"></label>
      <label>Manager <input name="manager" value="${attr(person.manager)}"></label>
      <label>Location <input name="location" value="${attr(person.location)}"></label>
      <label>Status <select name="status">${option('active', 'Active', person.status)}${option('inactive', 'Inactive', person.status)}</select></label>
      <label>UPN <input name="externalIds.upn" value="${attr(person.externalIds?.upn)}"></label>
      <label>Jamf username <input name="externalIds.jamfUsername" value="${attr(person.externalIds?.jamfUsername)}"></label>
      <label>Entra objectId <input name="externalIds.entraObjectId" value="${attr(person.externalIds?.entraObjectId)}"></label>
      <label style="grid-column:span 2">Alternate emails (comma-separated)
        <input name="alternateEmails" value="${attr((person.externalIds?.alternateEmails || []).join(', '))}">
      </label>
      <label style="grid-column:span 2">Notes <textarea name="notes">${escapeHtml(person.notes || '')}</textarea></label>
      <div class="actions"><button class="primary">Save</button></div>
    </form>
  `;
  document.querySelector('#personForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = formObject(event.currentTarget);
    const payload = {
      firstName: raw.firstName,
      lastName: raw.lastName,
      department: raw.department,
      role: raw.role,
      email: raw.email,
      phone: raw.phone,
      manager: raw.manager,
      location: raw.location,
      status: raw.status,
      notes: raw.notes,
      externalIds: {
        upn: raw['externalIds.upn'] || '',
        jamfUsername: raw['externalIds.jamfUsername'] || '',
        entraObjectId: raw['externalIds.entraObjectId'] || '',
        alternateEmails: String(raw.alternateEmails || '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      }
    };
    await api(person.id ? `/api/people/${person.id}` : '/api/people', {
      method: person.id ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
    await refreshAfterMutation();
  });
  dialog.showModal();
}

function showAssignForm(asset) {
  dialogBody.innerHTML = `
    <h2>Reassign device</h2>
    <p>${escapeHtml(asset.assetTag)} - ${escapeHtml(asset.serialNumber)}</p>
    <form id="assignForm" class="grid">
      <label>Person <select name="personId" required>${state.people.filter((person) => person.status !== 'inactive').map((person) => `<option value="${person.id}">${escapeHtml(personName(person))} - ${escapeHtml(person.department)}</option>`).join('')}</select></label>
      <label>Date <input name="assignedAt" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
      <label>Reason <input name="reason" value="Reassignment"></label>
      <label>Notes <textarea name="notes"></textarea></label>
      <div class="actions"><button class="primary">Reassign</button></div>
    </form>
  `;
  document.querySelector('#assignForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    await api(`/api/assets/${asset.id}/reassign`, {
      method: 'POST',
      body: JSON.stringify(formObject(event.currentTarget))
    });
    await refreshAfterMutation();
  });
}

async function unassignAsset(asset) {
  if (!confirm('Mark device as returned to stock?')) return;
  await api(`/api/assets/${asset.id}/unassign`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Returned to stock', status: 'in_stock' })
  });
  await refreshAfterMutation();
}

async function deleteAsset(asset) {
  const message = `Permanently delete device ${asset.assetTag} (${asset.serialNumber})?\n\nThis will also delete all assignments, invoices and history for this device. PDF files on disk are not deleted automatically.`;
  if (!confirm(message)) return;
  await api(`/api/assets/${asset.id}`, { method: 'DELETE' });
  await refreshAfterMutation();
}

async function uploadInvoice(event, assetId) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  await fetch(`/api/assets/${assetId}/invoices`, {
    method: 'POST',
    headers: { 'X-IT-Actor': actorInput.value || 'IT' },
    body: formData
  }).then(handleResponse);
  await refreshAfterMutation();
}

async function refreshAfterMutation() {
  dialog.close();
  await loadBaseData();
  await render();
}

async function renderReports() {
  const reports = await api('/api/reports');
  app.innerHTML = `
    <div class="toolbar">
      <div>
        <h1>Reports</h1>
        <p class="muted">CSV exports for daily inventory checks.</p>
      </div>
      <a class="button" href="/api/export/assets">Full assets CSV</a>
    </div>
    <section class="panel">
      <div class="grid">
        ${reports.map((report) => `
          <a class="card" href="/api/reports/${encodeURIComponent(report.id)}" download>
            <strong>${escapeHtml(report.label)}</strong>
            <span class="muted">Download CSV</span>
          </a>
        `).join('')}
      </div>
    </section>
  `;
}

async function renderSettings() {
  const settings = state.settings || await api('/api/settings');
  state.settings = settings;
  app.innerHTML = `
    <div class="toolbar">
      <div>
        <h1>Settings</h1>
        <p class="muted">Exclude lists, identity aliases, PV operators, backup — no redeploy needed.</p>
      </div>
    </div>
    <section class="panel">
      <h2>PV operators</h2>
      <label>One name per line
        <textarea id="settingsOperators" rows="4">${escapeHtml((settings.handoverOperators || []).join('\n'))}</textarea>
      </label>
    </section>
    <section class="panel" style="margin-top:1rem">
      <h2>Excluded emails (import skip)</h2>
      <label>One email per line
        <textarea id="settingsExcludedEmails" rows="6">${escapeHtml((settings.excludedEmails || []).join('\n'))}</textarea>
      </label>
    </section>
    <section class="panel" style="margin-top:1rem">
      <h2>Excluded name rules</h2>
      <p class="muted">One rule per line: <code>id: token1, token2</code></p>
      <textarea id="settingsNameRules" rows="8">${escapeHtml((settings.excludedNameRules || [])
        .map((rule) => `${rule.id}: ${(rule.tokens || []).join(', ')}`)
        .join('\n'))}</textarea>
    </section>
    <section class="panel" style="margin-top:1rem">
      <h2>Identity alias groups</h2>
      <p class="muted">One group per line: <code>email1, email2 | First Last</code> (first email is canonical)</p>
      <textarea id="settingsIdentityGroups" rows="8">${escapeHtml((settings.identityGroups || [])
        .map((group) => `${(group.emails || []).join(', ')} | ${[group.firstName, group.lastName].filter(Boolean).join(' ')}`.trim())
        .join('\n'))}</textarea>
    </section>
    <div class="actions" style="margin-top:1rem">
      <button class="primary" id="saveSettings">Save settings</button>
    </div>
    <section class="panel" style="margin-top:1.5rem">
      <h2>Backup / restore</h2>
      <p class="muted">Download <code>app.db.json</code>. Restore replaces the live database (confirm carefully).</p>
      <div class="actions">
        <a class="button" href="/api/backup/database">Download database</a>
        <label class="button">Restore database
          <input id="restoreDbFile" type="file" accept="application/json,.json" hidden>
        </label>
      </div>
      <p class="muted" style="margin-top:0.75rem">Uploads folder: copy <code>data/uploads</code> separately from the server (see update.ps1 / DEPLOY).</p>
    </section>
  `;
  document.querySelector('#saveSettings').addEventListener('click', async () => {
    const payload = {
      handoverOperators: lines(document.querySelector('#settingsOperators').value),
      excludedEmails: lines(document.querySelector('#settingsExcludedEmails').value),
      excludedNameRules: lines(document.querySelector('#settingsNameRules').value).map((line, index) => {
        const [idPart, tokensPart] = line.split(':');
        return {
          id: (idPart || `rule-${index + 1}`).trim(),
          tokens: String(tokensPart || '')
            .split(',')
            .map((token) => token.trim())
            .filter(Boolean)
        };
      }).filter((rule) => rule.tokens.length),
      identityGroups: lines(document.querySelector('#settingsIdentityGroups').value).map((line) => {
        const [emailsPart, namesPart = ''] = line.split('|');
        const emails = String(emailsPart || '')
          .split(',')
          .map((email) => email.trim())
          .filter(Boolean);
        const nameBits = String(namesPart || '').trim().split(/\s+/).filter(Boolean);
        return {
          emails,
          firstName: nameBits.slice(0, -1).join(' ') || nameBits[0] || '',
          lastName: nameBits.length > 1 ? nameBits[nameBits.length - 1] : ''
        };
      }).filter((group) => group.emails.length)
    };
    state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
    alert('Settings saved.');
  });
  document.querySelector('#restoreDbFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!confirm('Replace the live database with this backup? This cannot be undone easily.')) {
      event.target.value = '';
      return;
    }
    const text = await file.text();
    const payload = JSON.parse(text);
    await api('/api/backup/restore', { method: 'POST', body: JSON.stringify(payload) });
    await loadBaseData();
    alert('Database restored.');
    await render();
  });
}

function lines(value) {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-IT-Actor': actorInput.value || 'IT',
      ...(options.headers || {})
    }
  });
  return handleResponse(response);
}

async function handleResponse(response) {
  if (!response.ok) {
    let message = `Error ${response.status}`;
    try {
      message = (await response.json()).error || message;
    } catch {
      // Ignore non-JSON errors.
    }
    throw new Error(message);
  }
  const type = response.headers.get('content-type') || '';
  return type.includes('application/json') ? response.json() : response.text();
}

function formObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function card(label, value) {
  return `<div class="card"><span class="muted">${label}</span><strong>${value}</strong></div>`;
}

function simpleList(items, renderItem) {
  if (!items?.length) return '<p class="muted">No data.</p>';
  return `<ul>${items.map((item) => `<li>${renderItem(item)}</li>`).join('')}</ul>`;
}

function table(headers, rows) {
  if (!rows.length) return '<p class="muted">No data.</p>';
  return `<table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function personName(person) {
  return person ? titleCasePersonName(`${person.firstName || ''} ${person.lastName || ''}`.trim()) : '';
}

function titleCasePersonName(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/[A-ZĂÂÎȘȚ]/.test(text.slice(1)) && !text.split(/\s+/).some(canSplitKnownGivenName)) return text;
  return text
    .split(/\s+/)
    .flatMap(splitKnownGivenName)
    .map((part) => part.charAt(0).toLocaleUpperCase('ro-RO') + part.slice(1).toLocaleLowerCase('ro-RO'))
    .join(' ');
}

function splitKnownGivenName(value) {
  const normalized = String(value ?? '').toLocaleLowerCase('ro-RO');
  if (normalized.length < 8 || knownGivenNames.includes(normalized)) return [value];
  const firstMatch = knownGivenNames
    .slice()
    .sort((a, b) => b.length - a.length)
    .find((name) => normalized.startsWith(name));
  if (!firstMatch) return [value];
  const remainder = normalized.slice(firstMatch.length);
  if (!knownGivenNames.includes(remainder)) return [value];
  return [firstMatch, remainder];
}

function canSplitKnownGivenName(value) {
  return splitKnownGivenName(value).length > 1;
}

function badge(text, className = '') {
  return `<span class="badge ${className}">${escapeHtml(text)}</span>`;
}

function importActionBadge(row) {
  const labels = {
    create: 'New',
    update: 'Update',
    reassign: 'Reassign',
    skip: 'Skipped',
    needsReview: 'Review',
    create_mtr: 'MTR new',
    update_mtr: 'MTR update'
  };
  const classes = {
    create: 'ok',
    update: '',
    reassign: 'warn',
    skip: '',
    needsReview: 'warn',
    create_mtr: 'ok',
    update_mtr: ''
  };
  return badge(labels[row.action] || row.action, classes[row.action] || '');
}

function modelSelect(row) {
  const deviceType = guessImportDeviceType(row);
  const models = importModelsForRow(row);
  const optionHtml = (model) => `<option value="${attr(model.id)}">${escapeHtml(model.label)}</option>`;
  const groups = [];

  if (deviceType) {
    const typeLabel = deviceType === 'Telefon' ? 'Phones' : 'Laptops';
    const suggested = models.filter((model) => model.suggested);
    const others = models.filter((model) => !model.suggested);
    if (suggested.length) groups.push(`<optgroup label="${typeLabel} — suggested">${suggested.map(optionHtml).join('')}</optgroup>`);
    if (others.length) groups.push(`<optgroup label="${typeLabel} — other">${others.map(optionHtml).join('')}</optgroup>`);
  } else {
    for (const [type, label] of [['Laptop', 'Laptops'], ['Telefon', 'Phones']]) {
      const typeModels = models.filter((model) => model.deviceType === type);
      const suggested = typeModels.filter((model) => model.suggested);
      const others = typeModels.filter((model) => !model.suggested);
      if (suggested.length) groups.push(`<optgroup label="${label} — suggested">${suggested.map(optionHtml).join('')}</optgroup>`);
      if (others.length) groups.push(`<optgroup label="${label}">${others.map(optionHtml).join('')}</optgroup>`);
    }
  }

  return `<select data-model-override="${attr(row.rowKey)}" style="min-width:180px">
    <option value="">— Select model —</option>
    ${groups.join('')}
    <option value="__new__">+ Create new model…</option>
  </select>`;
}

function importModelsForRow(row) {
  const deviceType = guessImportDeviceType(row);
  const haystack = `${row.normalized?.manufacturer || ''} ${row.modelText || ''}`.toLowerCase();
  return state.catalog.models
    .map((model) => {
      const brand = state.catalog.brands.find((item) => item.id === model.brandId);
      const label = displayModelName(model, brand);
      const brandName = (brand?.name || '').toLowerCase();
      const modelName = (model.name || '').toLowerCase();
      let score = 0;
      if (brandName && haystack.includes(brandName)) score += 4;
      if (modelName && haystack.includes(modelName)) score += 4;
      if (deviceType && model.deviceType === deviceType) score += 2;
      if (haystack.includes('thinkpad') && modelName.includes('thinkpad')) score += 5;
      if (haystack.includes('galaxy') && modelName.includes('galaxy')) score += 5;
      if (haystack.includes('pixel') && modelName.includes('pixel')) score += 5;
      if (haystack.includes('iphone') && modelName.includes('iphone')) score += 3;
      if (haystack.includes('macbook') && modelName.includes('macbook')) score += 5;
      return { id: model.id, label, deviceType: model.deviceType, score, suggested: score >= 4 };
    })
    .filter((model) => !deviceType || model.deviceType === deviceType)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label, 'ro'));
}

function guessImportDeviceType(row) {
  const os = (row.normalized?.os || '').toLowerCase();
  const model = (row.modelText || '').toLowerCase();
  const manufacturer = (row.normalized?.manufacturer || '').toLowerCase();
  const compactModel = model.replace(/[^a-z0-9]/g, '');

  if (os.includes('ios') || os.includes('ipados')) return 'Telefon';
  if (model.includes('iphone') || model.includes('galaxy') || model.includes('pixel')) return 'Telefon';
  if (manufacturer.includes('samsung') || manufacturer.includes('xiaomi') || manufacturer.includes('google')) {
    return os.includes('android') || !os ? 'Telefon' : null;
  }
  if (os.includes('android')) return 'Telefon';

  if (os.includes('windows') || os.includes('macos')) return 'Laptop';
  if (model.includes('thinkpad') || model.includes('macbook')) return 'Laptop';
  if (manufacturer.includes('lenovo')) return 'Laptop';
  if (manufacturer.includes('apple') && (model.includes('macbook') || os.includes('mac'))) return 'Laptop';
  if (/^[0-9]{2}[a-z0-9]{5,}$/i.test(compactModel)) return 'Laptop';

  return null;
}

function guessImportBrand(row) {
  const manufacturer = (row.normalized?.manufacturer || '').toLowerCase();
  const model = (row.modelText || '').toLowerCase();
  if (manufacturer.includes('xiaomi') || model.includes('redmi') || model.includes('poco')) return 'Xiaomi';
  if (manufacturer.includes('samsung') || model.includes('galaxy')) return 'Samsung';
  if (manufacturer.includes('google') || model.includes('pixel')) return 'Google';
  if (manufacturer.includes('apple') || model.includes('iphone')) return 'Apple iPhone';
  if (manufacturer.includes('lenovo') || model.includes('thinkpad')) return 'Lenovo';
  return '';
}

function suggestModelNameFromRow(row) {
  const model = String(row.modelText || '').trim();
  if (!model) return '';
  if (/^iphone/i.test(model)) return model.replace(/\s*\(.+\)\s*$/, '').trim();
  if (/galaxy/i.test(model)) return model;
  if (/pixel/i.test(model)) return model;
  if (/^\d{4}[a-z0-9]+$/i.test(model)) return model;
  return model.slice(0, 40);
}

function isMacAsset(asset) {
  const brand = (asset.brand?.name || '').toLowerCase();
  const os = (asset.operatingSystem || '').toLowerCase();
  return brand.includes('macbook') || os.includes('macos') || os.includes('mac os') || !!asset.externalIds?.jamfComputerId;
}

/** Prefer MDM enrollment dates from import; fall back to assignment date in app. */
function enrolledDateLabel(asset) {
  if (isMacAsset(asset) && asset.lastEnrolledAt) return asset.lastEnrolledAt;
  if (asset.enrolledAt) return asset.enrolledAt;
  const assigned = asset.currentAssignment?.assignedAt;
  return assigned || '—';
}

function fillInvoiceMetaForm(form, meta, { onlyEmpty = true } = {}) {
  const set = (name, value) => {
    const el = form.querySelector(`[name="${name}"]`);
    if (!el || !value) return;
    if (onlyEmpty && String(el.value || '').trim()) return;
    el.value = value;
  };
  set('invoiceNumber', meta.invoiceNumber);
  set('invoiceDate', meta.invoiceDate);
  set('vendor', meta.vendor);
  set('amount', meta.amount);
}

async function autofillInvoiceMetaFromPdf(file, form) {
  const formData = new FormData();
  formData.append('file', file);
  const meta = await fetch('/api/import/invoices/parse-meta', {
    method: 'POST',
    headers: { 'X-IT-Actor': actorInput.value || 'IT' },
    body: formData
  }).then(handleResponse);
  fillInvoiceMetaForm(form, meta, { onlyEmpty: true });
}

function bindInvoicePdfAutofill(form) {
  if (!form) return;
  const fileInput = form.querySelector('input[name="file"]');
  if (!fileInput || fileInput.dataset.metaBound) return;
  fileInput.dataset.metaBound = '1';
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      await autofillInvoiceMetaFromPdf(file, form);
    } catch {
      // User can still fill fields manually
    }
  });
}

function displayModelName(model, brand = null, category = null) {
  if (model?.deviceType === 'Telefon' || category?.name === 'Telefon') {
    return model?.name || 'Telefon';
  }
  return [brand?.name, model?.name, model?.generation]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Necunoscut';
}

function assetModelName(asset) {
  return displayModelName(asset.model || {}, asset.brand || null, asset.category || null);
}

function option(value, label, current) {
  return `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`;
}

function statusLabel(status) {
  return {
    in_stock: 'In stock',
    assigned: 'Assigned',
    deployed: 'Deployed (MTR)',
    service: 'Service',
    retired: 'Retired'
  }[status] || status || '';
}

function actionLabel(action) {
  return {
    create: 'Created',
    update: 'Updated',
    assign: 'Assigned',
    reassign: 'Reassigned',
    unassign: 'Returned',
    upload_invoice: 'Invoice uploaded',
    import: 'Import',
    hard_delete: 'Permanently deleted'
  }[action] || action;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

function attr(value = '') {
  return escapeHtml(value);
}

window.addEventListener('unhandledrejection', (event) => {
  alert(event.reason?.message || 'An error occurred.');
});
