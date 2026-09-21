import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InventoryStore } from '../src/store.js';
import { renderHandoverDocx } from '../src/documents/docx-template.js';

test('seed catalog and reassign asset between people', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();

    assert.ok(store.listCatalog().models.length > 0);

    const [model] = store.listCatalog().models;
    const firstPerson = await store.createPerson({ firstName: 'Ana', lastName: 'Popescu', department: 'IT' }, 'test');
    const secondPerson = await store.createPerson({ firstName: 'Mihai', lastName: 'Ionescu', department: 'IT' }, 'test');
    const asset = await store.createAsset({
      assetTag: 'IT-001',
      serialNumber: 'SN001',
      modelId: model.id,
      status: 'in_stock'
    }, 'test');

    await store.reassignAsset(asset.id, { personId: firstPerson.id, assignedAt: '2026-01-01', reason: 'Initial' }, 'test');
    const reassigned = await store.reassignAsset(asset.id, { personId: secondPerson.id, assignedAt: '2026-02-01', reason: 'Transfer' }, 'test');

    assert.equal(reassigned.currentAssignment.person.id, secondPerson.id);
    assert.equal(reassigned.assignments.length, 2);
    assert.equal(reassigned.assignments[0].endedAt, '2026-02-01');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reject duplicate asset tag or serial number', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const [model] = store.listCatalog().models;

    await store.createAsset({ assetTag: 'IT-001', serialNumber: 'SN001', modelId: model.id }, 'test');
    await assert.rejects(
      () => store.createAsset({ assetTag: 'IT-001', serialNumber: 'SN002', modelId: model.id }, 'test'),
      /exista deja/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('hard delete asset removes related records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const [model] = store.listCatalog().models;
    const person = await store.createPerson({ firstName: 'Ana', lastName: 'Popescu' }, 'test');
    const asset = await store.createAsset({ assetTag: 'IT-DEL', serialNumber: 'SN-DEL', modelId: model.id }, 'test');
    await store.reassignAsset(asset.id, { personId: person.id, assignedAt: '2026-01-01' }, 'test');

    const deleted = await store.deleteAsset(asset.id, 'test');

    assert.equal(deleted.asset.id, asset.id);
    assert.equal(store.getAsset(asset.id), null);
    assert.equal(store.listAssets().some((item) => item.id === asset.id), false);
    assert.equal(store.db.assignments.some((assignment) => assignment.assetId === asset.id), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('handover document uses existing assignments without changing asset status', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const [model] = store.listCatalog().models;
    const person = await store.createPerson({ firstName: 'Ana', lastName: 'Popescu', department: 'IT' }, 'test');
    const asset = await store.createAsset({ assetTag: 'IT-PV', serialNumber: 'SN-PV', modelId: model.id }, 'test');
    await store.reassignAsset(asset.id, { personId: person.id, assignedAt: '2026-06-01' }, 'test');

    const preview = store.previewHandoverDocument({
      type: 'primire',
      personId: person.id,
      date: '2026-06-18',
      itOperator: 'Andrei Popescu'
    });
    assert.equal(preview.assets.length, 1);
    assert.equal(store.getAsset(asset.id).status, 'assigned');

    const document = await store.createHandoverDocument({
      type: 'predare',
      personId: person.id,
      date: '2026-06-18',
      itOperator: 'Dan Istrate',
      assetIds: [asset.id]
    }, 'test');
    assert.equal(document.assetCount, 1);
    assert.equal(store.listHandoverDocuments().length, 1);
    assert.equal(store.getAsset(asset.id).currentAssignment.person.id, person.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('render handover DOCX returns a Word document buffer', async () => {
  const buffer = await renderHandoverDocx({
    type: 'primire',
    date: '2026-06-18',
    itOperator: 'Dan Istrate',
    notes: 'Card Securitate',
    person: { firstName: 'adinamihaela', lastName: 'panduru', role: 'Merchandiser' },
    assets: [{
      assetTag: 'ROW-PC2EX12J',
      serialNumber: 'PC2EX12J',
      status: 'assigned',
      brand: { name: 'Lenovo' },
      model: { name: 'ThinkPad X13', generation: 'Gen 3', deviceType: 'Laptop' },
      category: { name: 'Laptop' }
    }, {
      assetTag: 'RO-LJ2LXG7JTX',
      serialNumber: 'LJ2LXG7JTX',
      imei: 'RO-LJ2LXG7JTX',
      status: 'assigned',
      brand: { name: 'Apple' },
      model: { name: 'iPhone 15', deviceType: 'Telefon' },
      category: { name: 'Telefon' }
    }]
  });
  const xml = buffer.toString('utf8');
  assert.equal(buffer.readUInt32LE(0), 0x04034b50);
  assert.ok(xml.includes('Tchibo Brands Romania'));
  assert.ok(xml.includes('PROCES VERBAL'));
  assert.ok(xml.includes('de predare'));
  assert.ok(xml.includes('Istrate Dan'));
  assert.ok(xml.includes('Adina Mihaela Panduru'));
  assert.ok(xml.includes('Laptop + Incarcator + mouse'));
  assert.ok(xml.includes('Card Securitate'));
  assert.ok(xml.includes('Avizat Departament HR'));
});

test('person documents can be uploaded listed and deleted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-docs-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const person = await store.createPerson({ firstName: 'Ana', lastName: 'Popescu', department: 'IT', role: 'Engineer' }, 'test');
    const [model] = store.listCatalog().models;
    const asset = await store.createAsset({ assetTag: 'IT-DOC', serialNumber: 'SN-DOC', modelId: model.id }, 'test');
    await store.reassignAsset(asset.id, { personId: person.id, assignedAt: '2026-06-01' }, 'test');
    const handover = await store.createHandoverDocument({
      type: 'primire',
      personId: person.id,
      date: '2026-06-18',
      itOperator: 'Andrei Popescu',
      assetIds: [asset.id]
    }, 'test');

    const document = await store.addPersonDocument(person.id, {
      title: 'PV semnat',
      docType: 'pv_primire',
      notes: 'Scan',
      handoverDocumentId: handover.id
    }, {
      fileName: 'pv.pdf',
      originalName: 'pv-semnat.pdf',
      relativePath: `people/${person.id}/pv.pdf`,
      size: 12,
      mimeType: 'application/pdf'
    }, 'test');

    assert.equal(document.docType, 'pv_primire');
    assert.equal(store.listPersonDocuments(person.id).length, 1);
    assert.equal(store.getPerson(person.id).documentCount, 1);
    assert.equal(store.getPerson(person.id).documents[0].title, 'PV semnat');

    const removed = await store.deletePersonDocument(document.id, 'test');
    assert.equal(removed.id, document.id);
    assert.equal(store.listPersonDocuments(person.id).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dashboard returns people devices and document counts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-dash-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    await store.createPerson({ firstName: 'Ana', lastName: 'Popescu', department: 'IT', role: 'Engineer', status: 'active' }, 'test');
    await store.createPerson({ firstName: 'Mihai', lastName: 'Ionescu', department: 'Sales', role: 'Merchandiser', status: 'inactive' }, 'test');
    const laptop = store.listCatalog().models.find((model) => model.deviceType !== 'Telefon') || store.listCatalog().models[0];
    const phone = store.listCatalog().models.find((model) => model.deviceType === 'Telefon') || laptop;
    await store.createAsset({ assetTag: 'IT-L1', serialNumber: 'SN-L1', modelId: laptop.id, status: 'in_stock' }, 'test');
    await store.createAsset({ assetTag: 'IT-P1', serialNumber: 'SN-P1', modelId: phone.id, status: 'service' }, 'test');

    const person = store.listPeople()[0];
    await store.addPersonDocument(person.id, { title: 'PV', docType: 'pv_primire' }, {
      fileName: 'a.pdf',
      originalName: 'a.pdf',
      relativePath: `people/${person.id}/a.pdf`,
      size: 1,
      mimeType: 'application/pdf'
    }, 'test');

    const data = store.dashboard();
    assert.equal(data.people.total, 2);
    assert.equal(data.people.active, 1);
    assert.equal(data.people.inactive, 1);
    assert.ok(data.people.byDepartment.some((item) => item.label === 'IT' && item.count === 1));
    assert.ok(data.people.byRole.some((item) => item.label === 'Merchandiser' && item.count === 1));
    assert.ok(data.devices.byStatus.some((item) => item.label === 'in_stock' && item.count === 1));
    assert.ok(data.devices.byStatus.some((item) => item.label === 'service' && item.count === 1));    assert.ok(data.devices.byCategory.length >= 1);
    assert.ok(data.devices.byModel.length >= 1);
    assert.equal(data.personDocuments.total, 1);
    assert.ok(data.personDocuments.byType.some((item) => item.label === 'pv_primire' && item.count === 1));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dashboard merges Fullstack role variants into one position', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-roles-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    await store.createPerson({ firstName: 'A', lastName: 'One', role: 'FullStack Engineer' }, 'test');
    await store.createPerson({ firstName: 'B', lastName: 'Two', role: 'Fullstack Engineer' }, 'test');
    await store.createPerson({ firstName: 'C', lastName: 'Three', role: 'Fullstack developer' }, 'test');
    await store.createPerson({ firstName: 'D', lastName: 'Four', role: 'Fullstack Developer' }, 'test');
    await store.createPerson({ firstName: 'E', lastName: 'Five', role: 'Technical Lead' }, 'test');

    const data = store.dashboard();
    const fullstack = data.people.byRole.find((item) => item.label === 'Fullstack Engineer');
    const lead = data.people.byRole.find((item) => item.label === 'Technical Lead');
    assert.equal(fullstack?.count, 4);
    assert.equal(lead?.count, 1);
    assert.equal(data.people.byRole.filter((item) => /full\s*stack/i.test(item.label)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dashboard model labels match list filters for Standard generation laptops', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-dash-models-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    const catalog = store.listCatalog();
    const brand = catalog.brands.find((item) => item.name === 'Lenovo') || catalog.brands[0];
    const model = await store.createCatalogModel({
      brandId: brand.id,
      name: 'ThinkPad T490',
      generation: 'Standard',
      deviceType: 'Laptop'
    }, 'test');
    await store.createAsset({
      assetTag: 'IT-T490',
      serialNumber: 'SN-T490',
      modelId: model.id,
      status: 'in_stock'
    }, 'test');

    const data = store.dashboard();
    const label = data.devices.byModel.find((item) => item.label.includes('T490'));
    assert.equal(label?.label, 'Lenovo ThinkPad T490 Standard');
    assert.equal(label?.count, 1);
    assert.equal(data.retired, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dashboard merges eSolutions and Tchibo department variants', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'itinv-depts-'));
  try {
    const store = new InventoryStore(join(dir, 'app.db.json'));
    await store.init();
    await store.createPerson({ firstName: 'A', lastName: 'One', department: 'eSolutions' }, 'test');
    await store.createPerson({ firstName: 'B', lastName: 'Two', department: 'eSolution' }, 'test');
    await store.createPerson({ firstName: 'C', lastName: 'Three', department: 'esolutions' }, 'test');
    await store.createPerson({ firstName: 'D', lastName: 'Four', department: 'Tchibo Brands SRL' }, 'test');
    await store.createPerson({ firstName: 'E', lastName: 'Five', department: 'Tchibo Brands' }, 'test');
    await store.createPerson({ firstName: 'F', lastName: 'Six', department: 'Tchibo Coffee Service Rumänien' }, 'test');
    await store.createPerson({ firstName: 'G', lastName: 'Seven', department: 'IT' }, 'test');
    await store.createPerson({ firstName: 'H', lastName: 'Eight', role: '' }, 'test');

    const data = store.dashboard();
    assert.equal(data.people.byDepartment.find((item) => item.label === 'eSolutions')?.count, 3);
    assert.equal(data.people.byDepartment.find((item) => item.label === 'Tchibo Brands')?.count, 3);
    assert.equal(data.people.byDepartment.find((item) => item.label === 'IT')?.count, 1);
    assert.equal(data.people.byRole.find((item) => item.label === 'Fara rol')?.count, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
