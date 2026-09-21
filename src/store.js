import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { detectMtrRegion, setRuntimeExcludedUsers, shouldSkipImportedUser } from './import/excluded-users.js';
import { setRuntimeIdentityGroups } from './import/known-person-aliases.js';
import { resolveMtrModel } from './import/model-resolver.js';
import { defaultSettings } from './settings/defaults.js';
import {
  absorbPersonEmails,
  applyPreferredIdentityNames,
  collectPersonEmails,
  emailsArePersonAliases,
  emailsLinkedForSamePerson,
  peopleNamesLikelySame,
  personMatchesEmailAlias,
  personProfileScore
} from './utils/person-email-alias.js';
import { formatAssetModelLabel, isWarrantyExpiringWithinDays } from './utils/asset-model-label.js';
import { preferPersonName, repairPersonNameFields } from './utils/person-name.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const defaultDbPath = join(rootDir, 'data', 'app.db.json');
const seedPath = join(rootDir, 'seed', 'models.json');

const emptyDatabase = () => ({
  version: 1,
  createdAt: new Date().toISOString(),
  catalog: {
    categories: [],
    brands: [],
    models: []
  },
  people: [],
  assets: [],
  assignments: [],
  invoices: [],
  handoverDocuments: [],
  personDocuments: [],
  auditLogs: [],
  settings: defaultSettings()
});

const personDocumentTypes = ['pv_primire', 'pv_predare', 'alocare', 'altul'];

export class InventoryStore {
  constructor(dbPath = process.env.ITINV_DB_PATH || defaultDbPath) {
    this.dbPath = dbPath;
    this.db = emptyDatabase();
    this.saveQueue = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.dbPath), { recursive: true });
    try {
      const content = await readFile(this.dbPath, 'utf8');
      this.db = JSON.parse(content);
      this.ensureShape();
      this.applyRuntimeSettings();
      await this.seedMissingCatalog();
      await this.repairMalformedPeople();
      await this.repairKnownPersonIdentities();
      await this.mergeDuplicatePeople();
      await this.repairMtrAssetStatuses();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.db = emptyDatabase();
      this.applyRuntimeSettings();
      await this.seedCatalog();
      await this.save();
    }
  }

  ensureShape() {
    this.db.catalog ??= { categories: [], brands: [], models: [] };
    this.db.catalog.categories ??= [];
    this.db.catalog.brands ??= [];
    this.db.catalog.models ??= [];
    this.db.people ??= [];
    this.db.assets ??= [];
    this.db.assignments ??= [];
    this.db.invoices ??= [];
    this.db.handoverDocuments ??= [];
    this.db.personDocuments ??= [];
    this.db.auditLogs ??= [];
    const defaults = defaultSettings();
    this.db.settings ??= defaults;
    this.db.settings.handoverOperators ??= [...defaults.handoverOperators];
    this.db.settings.excludedEmails ??= [...defaults.excludedEmails];
    this.db.settings.excludedNameRules ??= defaults.excludedNameRules.map((rule) => ({ ...rule, tokens: [...rule.tokens] }));
    this.db.settings.identityGroups ??= defaults.identityGroups.map((group) => ({
      emails: [...group.emails],
      firstName: group.firstName || '',
      lastName: group.lastName || ''
    }));
    this.db.settings.modelOverrides ??= {};
    this.db.settings.updatedAt ??= '';
    for (const person of this.db.people) {
      person.externalIds ??= { upn: '', jamfUsername: '', entraObjectId: '', alternateEmails: [] };
      person.externalIds.entraObjectId ??= '';
      person.externalIds.alternateEmails ??= [];
    }
    for (const asset of this.db.assets) {
      asset.externalIds ??= { intuneDeviceId: '', jamfComputerId: '' };
      asset.importMeta ??= { source: '', lastImportedAt: '', lastImportFile: '' };
      asset.importMeta.missingFromLastImport ??= false;
      asset.enrolledAt ??= '';
      asset.lastEnrolledAt ??= '';
    }
  }

  applyRuntimeSettings() {
    const settings = this.db.settings || defaultSettings();
    setRuntimeExcludedUsers({
      emails: settings.excludedEmails || [],
      nameRules: settings.excludedNameRules || []
    });
    setRuntimeIdentityGroups(settings.identityGroups || []);
  }

  getSettings() {
    return structuredClone(this.db.settings || defaultSettings());
  }

  async updateSettings(input, actor) {
    const before = structuredClone(this.db.settings);
    const next = this.db.settings || defaultSettings();
    if (Array.isArray(input.handoverOperators)) {
      next.handoverOperators = input.handoverOperators.map((value) => clean(value)).filter(Boolean);
      if (!next.handoverOperators.length) throw new Error('Adauga cel putin un operator PV.');
    }
    if (Array.isArray(input.excludedEmails)) {
      next.excludedEmails = [...new Set(input.excludedEmails.map((value) => clean(value).toLowerCase()).filter(Boolean))];
    }
    if (Array.isArray(input.excludedNameRules)) {
      next.excludedNameRules = input.excludedNameRules
        .map((rule, index) => ({
          id: clean(rule.id) || `custom-${index + 1}`,
          tokens: (rule.tokens || []).map((token) => clean(token).toLowerCase()).filter(Boolean)
        }))
        .filter((rule) => rule.tokens.length);
    }
    if (Array.isArray(input.identityGroups)) {
      next.identityGroups = input.identityGroups
        .map((group) => ({
          emails: [...new Set((group.emails || []).map((email) => clean(email).toLowerCase()).filter(Boolean))],
          firstName: clean(group.firstName),
          lastName: clean(group.lastName)
        }))
        .filter((group) => group.emails.length >= 1);
    }
    if (input.modelOverrides && typeof input.modelOverrides === 'object') {
      next.modelOverrides = { ...input.modelOverrides };
    }
    next.updatedAt = nowIso();
    this.db.settings = next;
    this.applyRuntimeSettings();
    this.addAudit('settings', 'app', 'update_settings', actor, before, next);
    await this.save();
    return this.getSettings();
  }

  async restoreDatabase(payload, actor) {
    const before = {
      people: this.db.people.length,
      assets: this.db.assets.length
    };
    this.db = {
      ...emptyDatabase(),
      ...payload,
      version: payload.version || 1
    };
    this.ensureShape();
    this.applyRuntimeSettings();
    this.addAudit('settings', 'backup', 'restore_database', actor, before, {
      people: this.db.people.length,
      assets: this.db.assets.length
    });
    await this.save();
    await this.repairMalformedPeople();
    await this.repairKnownPersonIdentities();
    await this.mergeDuplicatePeople(actor);
    await this.repairMtrAssetStatuses();
    return { ok: true };
  }

  getHandoverOperators() {
    const operators = this.db.settings?.handoverOperators;
    return Array.isArray(operators) && operators.length ? operators : defaultSettings().handoverOperators;
  }

  getModelOverride(serialNumber) {
    const key = clean(serialNumber).toLowerCase();
    if (!key) return '';
    return this.db.settings?.modelOverrides?.[key] || '';
  }

  async setModelOverride(serialNumber, modelId, actor) {
    const key = clean(serialNumber).toLowerCase();
    if (!key) throw new Error('Serial lipsa pentru model override.');
    this.db.settings ??= defaultSettings();
    this.db.settings.modelOverrides ??= {};
    if (modelId) this.db.settings.modelOverrides[key] = clean(modelId);
    else delete this.db.settings.modelOverrides[key];
    this.db.settings.updatedAt = nowIso();
    this.addAudit('settings', 'modelOverrides', 'set_model_override', actor, { serialNumber: key }, { modelId: modelId || null });
    await this.save();
    return this.getSettings();
  }

  async seedCatalog() {
    const seed = JSON.parse(await readFile(seedPath, 'utf8'));
    for (const category of seed.categories) {
      const categoryId = id();
      this.db.catalog.categories.push({ id: categoryId, name: category.name });
      for (const brand of category.brands) {
        const brandId = id();
        this.db.catalog.brands.push({ id: brandId, categoryId, name: brand.name });
        for (const model of brand.models) {
          this.db.catalog.models.push({
            id: id(),
            categoryId,
            brandId,
            name: model.name,
            generation: model.generation,
            deviceType: model.deviceType
          });
        }
      }
    }
  }

  async seedMissingCatalog() {
    const seed = JSON.parse(await readFile(seedPath, 'utf8'));
    let changed = false;
    for (const category of seed.categories) {
      let categoryRecord = this.db.catalog.categories.find((item) => item.name === category.name);
      if (!categoryRecord) {
        categoryRecord = { id: id(), name: category.name };
        this.db.catalog.categories.push(categoryRecord);
        changed = true;
      }
      for (const brand of category.brands) {
        let brandRecord = this.db.catalog.brands.find((item) => item.categoryId === categoryRecord.id && item.name === brand.name);
        if (!brandRecord) {
          brandRecord = { id: id(), categoryId: categoryRecord.id, name: brand.name };
          this.db.catalog.brands.push(brandRecord);
          changed = true;
        }
        for (const model of brand.models) {
          const exists = this.db.catalog.models.some((item) =>
            item.brandId === brandRecord.id &&
            item.name === model.name &&
            item.generation === model.generation
          );
          if (!exists) {
            this.db.catalog.models.push({
              id: id(),
              categoryId: categoryRecord.id,
              brandId: brandRecord.id,
              name: model.name,
              generation: model.generation,
              deviceType: model.deviceType
            });
            changed = true;
          }
        }
      }
    }
    if (changed) await this.save();
  }

  async repairMalformedPeople() {
    let changed = false;
    for (const person of this.db.people) {
      if (repairPersonNameFields(person)) changed = true;
    }
    if (changed) await this.save();
  }

  async repairKnownPersonIdentities() {
    let changed = false;
    for (const person of this.db.people) {
      const before = JSON.stringify({
        email: person.email,
        firstName: person.firstName,
        lastName: person.lastName,
        upn: person.externalIds?.upn,
        alternateEmails: person.externalIds?.alternateEmails ?? []
      });
      absorbPersonEmails(person, collectPersonEmails(person));
      applyPreferredIdentityNames(person);
      const after = JSON.stringify({
        email: person.email,
        firstName: person.firstName,
        lastName: person.lastName,
        upn: person.externalIds?.upn,
        alternateEmails: person.externalIds?.alternateEmails ?? []
      });
      if (before !== after) changed = true;
    }
    if (changed) await this.save();
  }

  /** MTR rooms are installed devices, not warehouse stock. */
  async repairMtrAssetStatuses() {
    let changed = false;
    for (const asset of this.db.assets) {
      if (!isMtrCatalogModel(this.db.catalog, asset.modelId)) continue;
      if (asset.status === 'in_stock' || !asset.status) {
        asset.status = 'deployed';
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  async mergeDuplicatePeople(actor = 'system') {
    let changed = false;
    const people = [...this.db.people];
    const removedIds = new Set();

    for (let i = 0; i < people.length; i += 1) {
      const primaryCandidate = people[i];
      if (!primaryCandidate || removedIds.has(primaryCandidate.id)) continue;

      for (let j = i + 1; j < people.length; j += 1) {
        const secondaryCandidate = people[j];
        if (!secondaryCandidate || removedIds.has(secondaryCandidate.id)) continue;
        if (!this.peopleAreImportDuplicates(primaryCandidate, secondaryCandidate)) continue;

        const primaryScore = personProfileScore(primaryCandidate);
        const secondaryScore = personProfileScore(secondaryCandidate);
        const primary = primaryScore >= secondaryScore ? primaryCandidate : secondaryCandidate;
        const secondary = primary === primaryCandidate ? secondaryCandidate : primaryCandidate;

        this.mergePersonInto(primary, secondary, actor);
        removedIds.add(secondary.id);
        changed = true;
        if (removedIds.has(primaryCandidate.id)) break;
      }
    }

    if (changed) await this.save();
    return removedIds.size;
  }

  peopleAreImportDuplicates(personA, personB) {
    if (!personA || !personB || personA.id === personB.id) return false;

    const emailsA = [
      personA.email,
      personA.externalIds?.upn,
      ...(personA.externalIds?.alternateEmails ?? [])
    ].map((value) => clean(value).toLowerCase()).filter(Boolean);
    const emailsB = [
      personB.email,
      personB.externalIds?.upn,
      ...(personB.externalIds?.alternateEmails ?? [])
    ].map((value) => clean(value).toLowerCase()).filter(Boolean);

    let linkedByEmail = false;
    for (const emailA of emailsA) {
      for (const emailB of emailsB) {
        if (emailsLinkedForSamePerson(emailA, emailB)) {
          linkedByEmail = true;
          break;
        }
      }
      if (linkedByEmail) break;
    }
    if (!linkedByEmail) return false;

    // Name-change links (known aliases) may have different surnames.
    const knownLink = emailsA.some((emailA) =>
      emailsB.some((emailB) => emailA !== emailB && emailsLinkedForSamePerson(emailA, emailB) && !emailsArePersonAliases(emailA, emailB))
    );
    if (knownLink) return true;
    return peopleNamesLikelySame(personA, personB);
  }

  mergePersonInto(primary, secondary, actor) {
    const before = structuredClone(primary);
    const preferredNames = preferPersonName(primary, secondary);
    mergeIfPresent(primary, {
      firstName: preferredNames.firstName,
      lastName: preferredNames.lastName,
      department: secondary.department,
      role: secondary.role,
      phone: secondary.phone,
      manager: secondary.manager,
      location: secondary.location,
      status: secondary.status,
      notes: secondary.notes,
      externalIds: {
        jamfUsername: secondary.externalIds?.jamfUsername,
        entraObjectId: secondary.externalIds?.entraObjectId
      }
    });
    absorbPersonEmails(primary, [
      secondary.email,
      secondary.externalIds?.upn,
      ...(secondary.externalIds?.alternateEmails ?? [])
    ]);
    applyPreferredIdentityNames(primary);
    repairPersonNameFields(primary);
    primary.updatedAt = nowIso();

    this.reassignPersonReferences(secondary.id, primary.id);
    this.db.people = this.db.people.filter((person) => person.id !== secondary.id);
    this.addAudit('person', primary.id, 'merge_duplicate', actor, before, {
      primary,
      mergedFrom: secondary
    });
  }

  reassignPersonReferences(fromPersonId, toPersonId) {
    for (const assignment of this.db.assignments) {
      if (assignment.personId === fromPersonId) assignment.personId = toPersonId;
    }
    for (const document of this.db.personDocuments) {
      if (document.personId === fromPersonId) document.personId = toPersonId;
    }
    for (const document of this.db.handoverDocuments) {
      if (document.personId === fromPersonId) document.personId = toPersonId;
    }
  }

  async save() {
    this.saveQueue = this.saveQueue.then(() => this.writeDatabase()).catch((error) => {
      throw error;
    });
    return this.saveQueue;
  }

  async writeDatabase() {
    const tmpPath = `${this.dbPath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.dbPath), { recursive: true });
    await writeFile(tmpPath, `${JSON.stringify(this.db, null, 2)}\n`, 'utf8');
    try {
      await rename(tmpPath, this.dbPath);
    } catch (error) {
      await unlink(tmpPath).catch(() => {});
      throw error;
    }
  }

  listCatalog() {
    return structuredClone(this.db.catalog);
  }

  listPeople() {
    return this.db.people.map((person) => this.withPersonStats(person));
  }

  getPerson(idValue) {
    const person = this.db.people.find((item) => item.id === idValue);
    return person ? this.withPersonStats(person, true) : null;
  }

  async createPerson(input, actor) {
    const now = nowIso();
    const person = {
      id: id(),
      firstName: clean(input.firstName),
      lastName: clean(input.lastName),
      department: clean(input.department),
      role: clean(input.role),
      email: clean(input.email),
      phone: clean(input.phone),
      manager: clean(input.manager),
      location: clean(input.location),
      status: input.status === 'inactive' ? 'inactive' : 'active',
      notes: clean(input.notes),
      externalIds: {
        upn: clean(input.externalIds?.upn),
        jamfUsername: clean(input.externalIds?.jamfUsername),
        entraObjectId: clean(input.externalIds?.entraObjectId),
        alternateEmails: Array.isArray(input.externalIds?.alternateEmails)
          ? input.externalIds.alternateEmails.map((email) => clean(email).toLowerCase()).filter(Boolean)
          : []
      },
      createdAt: now,
      updatedAt: now
    };
    requireFields(person, ['firstName', 'lastName']);
    this.db.people.push(person);
    this.addAudit('person', person.id, 'create', actor, null, person);
    await this.save();
    return this.withPersonStats(person);
  }

  async updatePerson(idValue, input, actor) {
    const person = this.db.people.find((item) => item.id === idValue);
    if (!person) return null;
    const before = structuredClone(person);
    Object.assign(person, {
      firstName: clean(input.firstName),
      lastName: clean(input.lastName),
      department: clean(input.department),
      role: clean(input.role),
      email: clean(input.email),
      phone: clean(input.phone),
      manager: clean(input.manager),
      location: clean(input.location),
      status: input.status === 'inactive' ? 'inactive' : 'active',
      notes: clean(input.notes),
      externalIds: {
        upn: clean(input.externalIds?.upn) || person.externalIds?.upn || '',
        jamfUsername: clean(input.externalIds?.jamfUsername) || person.externalIds?.jamfUsername || '',
        entraObjectId: clean(input.externalIds?.entraObjectId) || person.externalIds?.entraObjectId || '',
        alternateEmails: Array.isArray(input.externalIds?.alternateEmails)
          ? input.externalIds.alternateEmails.map((email) => clean(email).toLowerCase()).filter(Boolean)
          : (person.externalIds?.alternateEmails || [])
      },
      updatedAt: nowIso()
    });
    requireFields(person, ['firstName', 'lastName']);
    this.addAudit('person', person.id, 'update', actor, before, person);
    await this.save();
    return this.withPersonStats(person);
  }

  async deletePerson(idValue, actor) {
    const person = this.db.people.find((item) => item.id === idValue);
    if (!person) return null;
    const active = this.db.assignments.some((assignment) => assignment.personId === idValue && !assignment.endedAt);
    if (active) throw Object.assign(new Error('Persoana are device-uri active. Returneaza-le in stoc inainte de stergere.'), { status: 400 });
    const before = structuredClone(person);
    this.db.people = this.db.people.filter((item) => item.id !== idValue);
    for (const assignment of this.db.assignments) {
      if (assignment.personId === idValue) assignment.personId = '';
    }
    this.db.personDocuments = this.db.personDocuments.filter((document) => document.personId !== idValue);
    this.db.handoverDocuments = this.db.handoverDocuments.filter((document) => document.personId !== idValue);
    this.addAudit('person', idValue, 'delete', actor, before, null);
    await this.save();
    return { ok: true, id: idValue };
  }

  async mergePeopleByIds(primaryId, secondaryId, actor) {
    if (!primaryId || !secondaryId || primaryId === secondaryId) {
      throw Object.assign(new Error('Selecteaza doua persoane diferite pentru merge.'), { status: 400 });
    }
    const primary = this.db.people.find((item) => item.id === primaryId);
    const secondary = this.db.people.find((item) => item.id === secondaryId);
    if (!primary || !secondary) throw Object.assign(new Error('Persoana nu exista.'), { status: 404 });
    this.mergePersonInto(primary, secondary, actor);
    await this.save();
    return this.withPersonStats(primary, true);
  }

  listAssets() {
    return this.db.assets.map((asset) => this.hydrateAsset(asset));
  }

  getAsset(idValue) {
    const asset = this.db.assets.find((item) => item.id === idValue);
    return asset ? this.hydrateAsset(asset, true) : null;
  }

  async deleteAsset(idValue, actor) {
    const assetIndex = this.db.assets.findIndex((item) => item.id === idValue);
    if (assetIndex === -1) return null;

    const asset = this.db.assets[assetIndex];
    const deleted = {
      asset: structuredClone(asset),
      assignments: this.db.assignments.filter((assignment) => assignment.assetId === idValue),
      invoices: this.db.invoices.filter((invoice) => invoice.assetId === idValue),
      auditLogs: this.db.auditLogs.filter((log) => log.entityId === idValue)
    };

    this.db.assets.splice(assetIndex, 1);
    this.db.assignments = this.db.assignments.filter((assignment) => assignment.assetId !== idValue);
    this.db.invoices = this.db.invoices.filter((invoice) => invoice.assetId !== idValue);
    this.db.auditLogs = this.db.auditLogs.filter((log) => log.entityId !== idValue);
    this.addAudit('asset', idValue, 'hard_delete', actor, deleted, null);
    await this.save();
    return deleted;
  }

  async createAsset(input, actor) {
    const now = nowIso();
    const model = this.requireModel(input.modelId);
    const asset = {
      id: id(),
      assetTag: clean(input.assetTag),
      serialNumber: clean(input.serialNumber),
      modelId: model.id,
      status: normalizeAssetStatus(input.status),
      ram: clean(input.ram),
      storage: clean(input.storage),
      cpu: clean(input.cpu),
      imei: clean(input.imei),
      operatingSystem: clean(input.operatingSystem),
      warrantyUntil: clean(input.warrantyUntil),
      purchaseDate: clean(input.purchaseDate),
      vendor: clean(input.vendor),
      notes: clean(input.notes),
      enrolledAt: clean(input.enrolledAt),
      lastEnrolledAt: clean(input.lastEnrolledAt),
      externalIds: {
        intuneDeviceId: clean(input.externalIds?.intuneDeviceId),
        jamfComputerId: clean(input.externalIds?.jamfComputerId)
      },
      importMeta: {
        source: clean(input.importMeta?.source),
        lastImportedAt: clean(input.importMeta?.lastImportedAt),
        lastImportFile: clean(input.importMeta?.lastImportFile)
      },
      createdAt: now,
      updatedAt: now
    };
    requireFields(asset, ['assetTag', 'serialNumber', 'modelId']);
    this.assertStatusAssignmentConsistency(asset);
    this.ensureUniqueAsset(asset);
    this.db.assets.push(asset);
    this.addAudit('asset', asset.id, 'create', actor, null, asset);
    await this.save();
    return this.hydrateAsset(asset, true);
  }

  async updateAsset(idValue, input, actor) {
    const asset = this.db.assets.find((item) => item.id === idValue);
    if (!asset) return null;
    const model = this.requireModel(input.modelId);
    const before = structuredClone(asset);
    Object.assign(asset, {
      assetTag: clean(input.assetTag),
      serialNumber: clean(input.serialNumber),
      modelId: model.id,
      status: normalizeAssetStatus(input.status),
      ram: clean(input.ram),
      storage: clean(input.storage),
      cpu: clean(input.cpu),
      imei: clean(input.imei),
      operatingSystem: clean(input.operatingSystem),
      warrantyUntil: clean(input.warrantyUntil),
      purchaseDate: clean(input.purchaseDate),
      vendor: clean(input.vendor),
      notes: clean(input.notes),
      enrolledAt: clean(input.enrolledAt) || asset.enrolledAt || '',
      lastEnrolledAt: clean(input.lastEnrolledAt) || asset.lastEnrolledAt || '',
      externalIds: {
        intuneDeviceId: clean(input.externalIds?.intuneDeviceId) || asset.externalIds?.intuneDeviceId || '',
        jamfComputerId: clean(input.externalIds?.jamfComputerId) || asset.externalIds?.jamfComputerId || ''
      },
      importMeta: {
        source: clean(input.importMeta?.source) || asset.importMeta?.source || '',
        lastImportedAt: clean(input.importMeta?.lastImportedAt) || asset.importMeta?.lastImportedAt || '',
        lastImportFile: clean(input.importMeta?.lastImportFile) || asset.importMeta?.lastImportFile || '',
        missingFromLastImport: asset.importMeta?.missingFromLastImport === true,
        missingDetectedAt: asset.importMeta?.missingDetectedAt || ''
      },
      updatedAt: nowIso()
    });
    requireFields(asset, ['assetTag', 'serialNumber', 'modelId']);
    this.assertStatusAssignmentConsistency(asset);
    this.ensureUniqueAsset(asset);
    this.addAudit('asset', asset.id, 'update', actor, before, asset);
    await this.save();
    return this.hydrateAsset(asset, true);
  }

  assertStatusAssignmentConsistency(asset) {
    const hasActive = Boolean(this.getCurrentAssignment(asset.id));
    if (asset.status === 'assigned' && !hasActive) {
      asset.status = isMtrCatalogModel(this.db.catalog, asset.modelId) ? 'deployed' : 'in_stock';
    }
  }

  listReportTypes() {
    return [
      { id: 'in_stock', label: 'In stock' },
      { id: 'assigned_by_department', label: 'Assigned per departament' },
      { id: 'warranty_30', label: 'Garantii 30 zile' },
      { id: 'warranty_90', label: 'Garantii 90 zile' },
      { id: 'mtr_ro', label: 'MTR RO' },
      { id: 'mtr_bg', label: 'MTR BG' },
      { id: 'people_without_device', label: 'Useri fara device' },
      { id: 'missing_from_mdm', label: 'Lipsesc din ultimul import MDM' }
    ];
  }

  buildReportRows(reportId) {
    const assets = this.listAssets();
    if (reportId === 'in_stock') {
      return assets.filter((asset) => asset.status === 'in_stock').map(assetReportRow);
    }
    if (reportId === 'assigned_by_department') {
      return assets
        .filter((asset) => asset.status === 'assigned' && asset.currentAssignment?.person)
        .map((asset) => ({
          ...assetReportRow(asset),
          department: asset.currentAssignment.person.department || '',
          person: personDisplayName(asset.currentAssignment.person),
          email: asset.currentAssignment.person.email || ''
        }));
    }
    if (reportId === 'warranty_30') {
      return assets.filter((asset) => isWarrantyExpiringWithinDays(asset.warrantyUntil, 30)).map(assetReportRow);
    }
    if (reportId === 'warranty_90') {
      return assets.filter((asset) => isWarrantyExpiringWithinDays(asset.warrantyUntil, 90)).map(assetReportRow);
    }
    if (reportId === 'mtr_ro' || reportId === 'mtr_bg') {
      const categoryName = reportId === 'mtr_ro' ? 'MTR RO' : 'MTR BG';
      return assets.filter((asset) => asset.category?.name === categoryName).map(assetReportRow);
    }
    if (reportId === 'people_without_device') {
      return this.db.people
        .filter((person) => (person.status || 'active') !== 'inactive')
        .filter((person) => !this.db.assignments.some((assignment) => assignment.personId === person.id && !assignment.endedAt))
        .map((person) => ({
          firstName: person.firstName,
          lastName: person.lastName,
          email: person.email || '',
          department: person.department || '',
          role: person.role || '',
          status: person.status || 'active'
        }));
    }
    if (reportId === 'missing_from_mdm') {
      return assets.filter((asset) => asset.importMeta?.missingFromLastImport).map((asset) => ({
        ...assetReportRow(asset),
        source: asset.importMeta?.source || '',
        missingDetectedAt: asset.importMeta?.missingDetectedAt || ''
      }));
    }
    throw Object.assign(new Error('Raport necunoscut.'), { status: 404 });
  }

  findAssetForImport(row) {
    const serial = clean(row.serialNumber).toLowerCase();
    const assetTag = clean(row.assetTag).toLowerCase();
    const externalId = clean(row.externalId).toLowerCase();
    const roomUpn = clean(row.primaryUserUpn || row.person?.email || row.person?.externalIds?.upn).toLowerCase();
    const byIdentity = this.db.assets.find((asset) => {
      const ids = asset.externalIds ?? {};
      return (
        (serial && clean(asset.serialNumber).toLowerCase() === serial) ||
        (assetTag && clean(asset.assetTag).toLowerCase() === assetTag) ||
        (externalId && clean(ids.intuneDeviceId).toLowerCase() === externalId) ||
        (externalId && clean(ids.jamfComputerId).toLowerCase() === externalId)
      );
    });
    if (byIdentity) return byIdentity;
    if (row.mtrRegion && roomUpn) {
      return this.db.assets.find((asset) =>
        clean(asset.importMeta?.roomUpn).toLowerCase() === roomUpn
      ) ?? null;
    }
    return null;
  }

  findMtrRoomAsset(personOrNormalized = {}) {
    const upn = clean(
      personOrNormalized.externalIds?.upn ||
      personOrNormalized.email ||
      personOrNormalized.primaryUserUpn
    ).toLowerCase();
    const objectId = clean(personOrNormalized.externalIds?.entraObjectId).toLowerCase();
    const displayName = clean(personOrNormalized.displayName).toLowerCase();
    return this.db.assets.find((asset) => {
      const metaUpn = clean(asset.importMeta?.roomUpn).toLowerCase();
      const metaObjectId = clean(asset.importMeta?.entraObjectId).toLowerCase();
      if (upn && metaUpn === upn) return true;
      if (objectId && (metaObjectId === objectId || clean(asset.serialNumber).toLowerCase() === objectId)) return true;
      if (displayName && clean(asset.assetTag).toLowerCase() === displayName && metaUpn) return true;
      return false;
    }) ?? null;
  }

  findAssetConflict(assetTag, serialNumber, excludeId = '') {
    const tag = clean(assetTag).toLowerCase();
    const serial = clean(serialNumber).toLowerCase();
    return this.db.assets.find((item) => {
      if (excludeId && item.id === excludeId) return false;
      return (tag && clean(item.assetTag).toLowerCase() === tag) ||
        (serial && clean(item.serialNumber).toLowerCase() === serial);
    }) ?? null;
  }

  findPersonForImport(personInput) {
    if (!personInput) return null;
    const email = clean(personInput.email).toLowerCase();
    const upn = clean(personInput.externalIds?.upn).toLowerCase();
    const jamfUsername = clean(personInput.externalIds?.jamfUsername).toLowerCase();
    const entraObjectId = clean(personInput.externalIds?.entraObjectId).toLowerCase();
    return this.db.people.find((person) => {
      const ids = person.externalIds ?? {};
      if (entraObjectId && clean(ids.entraObjectId).toLowerCase() === entraObjectId) return true;
      if (jamfUsername && clean(ids.jamfUsername).toLowerCase() === jamfUsername) return true;

      const identity = email || upn;
      if (!identity) return false;
      if (personMatchesEmailAlias(person, identity)) {
        // Exact email/UPN match is always safe; alias match also requires similar names.
        // Known identity links (name changes) are allowed even when surnames differ.
        const exact =
          (email && clean(person.email).toLowerCase() === email) ||
          (upn && clean(ids.upn).toLowerCase() === upn) ||
          (email && clean(ids.upn).toLowerCase() === email) ||
          (upn && clean(person.email).toLowerCase() === upn) ||
          (Array.isArray(ids.alternateEmails) && ids.alternateEmails.some((item) => clean(item).toLowerCase() === identity));
        const knownLink = collectPersonEmails(person).some((candidate) =>
          emailsLinkedForSamePerson(candidate, identity) && !emailsArePersonAliases(candidate, identity)
        );
        return exact || knownLink || peopleNamesLikelySame(person, personInput);
      }
      return false;
    }) ?? null;
  }

  async applyUserImportRows(rows, options, actor) {
    const now = nowIso();
    const imported = [];
    const skipped = [];
    const mtrImported = [];

    for (const row of rows) {
      if (['create_mtr', 'update_mtr'].includes(row.action)) {
        const asset = this.upsertMtrRoomFromUser(row, options, actor, now);
        if (asset) {
          mtrImported.push({
            id: asset.id,
            action: row.action === 'update_mtr' ? 'update_mtr' : 'create_mtr',
            name: asset.assetTag,
            email: row.personEmail || row.normalized?.email || ''
          });
        } else {
          skipped.push(row);
        }
        continue;
      }

      if (!['create', 'update'].includes(row.action)) {
        skipped.push(row);
        continue;
      }

      const before = this.findPersonForImport(row.normalized);
      const person = this.upsertImportPerson(row.normalized, actor, now);
      if (!person) {
        skipped.push(row);
        continue;
      }
      imported.push({
        id: person.id,
        action: before ? 'update' : 'create',
        name: `${person.firstName} ${person.lastName}`.trim(),
        email: person.email
      });
    }

    await this.save();
    await this.mergeDuplicatePeople(actor);
    return {
      imported,
      mtrImported,
      skipped,
      summary: {
        imported: imported.length,
        mtrImported: mtrImported.length,
        skipped: skipped.length,
        created: imported.filter((item) => item.action === 'create').length,
        updated: imported.filter((item) => item.action === 'update').length,
        create_mtr: mtrImported.filter((item) => item.action === 'create_mtr').length,
        update_mtr: mtrImported.filter((item) => item.action === 'update_mtr').length
      },
      fileName: options.fileName || ''
    };
  }

  upsertMtrRoomFromUser(row, options, actor, now) {
    const normalized = row.normalized || {};
    const region = row.mtrRegion || detectMtrRegion({
      email: normalized.email,
      upn: normalized.externalIds?.upn,
      userName: normalized.displayName,
      deviceName: normalized.displayName
    });
    if (!region) return null;

    const resolved = resolveMtrModel(this.listCatalog(), region);
    if (!resolved.model) return null;

    const upn = clean(normalized.externalIds?.upn || normalized.email);
    const objectId = clean(normalized.externalIds?.entraObjectId);
    const displayName = clean(normalized.displayName) || upn;
    const existing = this.findMtrRoomAsset(normalized);
    const serialNumber = objectId || upn;
    const patch = {
      assetTag: displayName,
      serialNumber,
      modelId: resolved.model.id,
      status: 'deployed',
      notes: [
        `MTR room UPN: ${upn}`,
        objectId ? `Entra Object Id: ${objectId}` : ''
      ].filter(Boolean).join('\n'),
      importMeta: {
        source: normalized.source || 'entra',
        roomUpn: upn.toLowerCase(),
        entraObjectId: objectId,
        lastImportedAt: now,
        lastImportFile: options.fileName || ''
      }
    };

    if (existing) {
      const before = structuredClone(existing);
      // Keep hardware serial if Intune already enriched this room asset.
      const keepHardwareSerial = existing.importMeta?.source === 'intune' &&
        clean(existing.serialNumber) &&
        clean(existing.serialNumber).toLowerCase() !== clean(existing.importMeta?.entraObjectId).toLowerCase() &&
        clean(existing.serialNumber).toLowerCase() !== clean(existing.importMeta?.roomUpn).toLowerCase();
      mergeIfPresent(existing, {
        ...patch,
        serialNumber: keepHardwareSerial ? existing.serialNumber : patch.serialNumber,
        importMeta: {
          ...patch.importMeta,
          source: existing.importMeta?.source === 'intune' ? 'intune' : patch.importMeta.source
        }
      });
      existing.status = 'deployed';
      existing.importMeta.roomUpn = upn.toLowerCase();
      if (objectId) existing.importMeta.entraObjectId = objectId;
      existing.updatedAt = now;
      this.ensureUniqueAsset(existing);
      this.addAudit('asset', existing.id, 'import_mtr_room', actor, before, existing);
      return existing;
    }

    const created = {
      id: id(),
      assetTag: patch.assetTag,
      serialNumber: patch.serialNumber,
      modelId: patch.modelId,
      status: 'deployed',
      ram: '',
      storage: '',
      cpu: '',
      imei: '',
      operatingSystem: '',
      warrantyUntil: '',
      purchaseDate: '',
      vendor: '',
      notes: patch.notes,
      enrolledAt: '',
      lastEnrolledAt: '',
      externalIds: { intuneDeviceId: '', jamfComputerId: '' },
      importMeta: patch.importMeta,
      createdAt: now,
      updatedAt: now
    };
    const conflict = this.findAssetConflict(created.assetTag, created.serialNumber);
    if (conflict) {
      const before = structuredClone(conflict);
      mergeIfPresent(conflict, patch);
      conflict.importMeta = { ...(conflict.importMeta || {}), ...patch.importMeta };
      conflict.updatedAt = now;
      this.addAudit('asset', conflict.id, 'import_mtr_room', actor, before, conflict);
      return conflict;
    }
    this.db.assets.push(created);
    this.addAudit('asset', created.id, 'import_mtr_room', actor, null, created);
    return created;
  }

  async applyImportRows(rows, options, actor) {
    const now = nowIso();
    const imported = [];
    const skipped = [];
    const source = rows.find((row) => row.source)?.source || '';
    const touchedSerials = new Set();

    for (const row of rows) {
      if (!['create', 'update', 'reassign'].includes(row.action) || row.needsReview) {
        skipped.push(row);
        continue;
      }

      const importedPerson = this.upsertImportPerson(row.normalized.person, actor, now);
      const asset = this.upsertImportAsset(row, options, actor, now);
      if (asset?.importMeta) {
        asset.importMeta.missingFromLastImport = false;
      }
      if (asset?.serialNumber) touchedSerials.add(clean(asset.serialNumber).toLowerCase());

      if (importedPerson) {
        const current = this.getCurrentAssignment(asset.id);
        if (!current) {
          this.createImportAssignment(asset, importedPerson, row, actor, now, 'assign');
        } else if (current.personId !== importedPerson.id) {
          current.endedAt = now.slice(0, 10);
          current.endReason = `Import ${row.source}`;
          current.updatedAt = now;
          this.createImportAssignment(asset, importedPerson, row, actor, now, 'reassign');
        }
      }

      imported.push(this.hydrateAsset(asset, true));
    }

    if (source && touchedSerials.size) {
      this.markMissingFromLastImport(source, touchedSerials, now, actor);
    }

    await this.save();
    await this.mergeDuplicatePeople(actor);
    return {
      imported,
      skipped,
      summary: {
        imported: imported.length,
        skipped: skipped.length,
        missingFromImport: this.db.assets.filter((asset) => asset.importMeta?.missingFromLastImport).length
      }
    };
  }

  markMissingFromLastImport(source, touchedSerials, now, actor) {
    for (const asset of this.db.assets) {
      const assetSource = clean(asset.importMeta?.source).toLowerCase();
      if (!assetSource || assetSource !== clean(source).toLowerCase()) continue;
      if (['retired', 'lost', 'stolen'].includes(asset.status)) continue;
      const serial = clean(asset.serialNumber).toLowerCase();
      if (!serial || touchedSerials.has(serial)) continue;
      if (asset.importMeta.missingFromLastImport) continue;
      const before = structuredClone(asset);
      asset.importMeta.missingFromLastImport = true;
      asset.importMeta.missingDetectedAt = now;
      asset.updatedAt = now;
      this.addAudit('asset', asset.id, 'missing_from_import', actor, before, asset);
    }
  }

  upsertImportPerson(personInput, actor, now) {
    if (!personInput) return null;
    if (shouldSkipImportedUser(personInput)) return null;
    if (detectMtrRegion({
      email: personInput.email,
      upn: personInput.externalIds?.upn,
      userName: personInput.displayName || `${personInput.firstName || ''} ${personInput.lastName || ''}`
    })) return null;
    const person = this.findPersonForImport(personInput);
    if (person) {
      const before = structuredClone(person);
      const preferredNames = preferPersonName(person, personInput);
      mergeIfPresent(person, {
        firstName: preferredNames.firstName,
        lastName: preferredNames.lastName,
        department: personInput.department,
        role: personInput.role,
        phone: personInput.phone,
        manager: personInput.manager,
        location: personInput.location,
        status: personInput.status,
        externalIds: {
          jamfUsername: personInput.externalIds?.jamfUsername,
          entraObjectId: personInput.externalIds?.entraObjectId
        }
      });
      absorbPersonEmails(person, [
        personInput.email,
        personInput.externalIds?.upn
      ]);
      applyPreferredIdentityNames(person);
      repairPersonNameFields(person);
      person.updatedAt = now;
      this.addAudit('person', person.id, 'import', actor, before, person);
      return person;
    }

    const created = {
      id: id(),
      firstName: clean(personInput.firstName) || 'Necunoscut',
      lastName: clean(personInput.lastName) || '-',
      department: clean(personInput.department),
      role: clean(personInput.role),
      email: clean(personInput.email),
      phone: clean(personInput.phone),
      manager: clean(personInput.manager),
      location: clean(personInput.location),
      status: personInput.status === 'inactive' ? 'inactive' : 'active',
      notes: '',
      externalIds: {
        upn: clean(personInput.externalIds?.upn),
        jamfUsername: clean(personInput.externalIds?.jamfUsername),
        entraObjectId: clean(personInput.externalIds?.entraObjectId),
        alternateEmails: []
      },
      createdAt: now,
      updatedAt: now
    };
    absorbPersonEmails(created, [personInput.email, personInput.externalIds?.upn]);
    this.db.people.push(created);
    this.addAudit('person', created.id, 'import', actor, null, created);
    return created;
  }

  upsertImportAsset(row, options, actor, now) {
    const existing = this.findAssetForImport(row.normalized);
    const sourceExternalIds = row.source === 'intune'
      ? { intuneDeviceId: row.normalized.externalId, jamfComputerId: '' }
      : { intuneDeviceId: '', jamfComputerId: row.normalized.externalId };
    const roomUpn = clean(
      row.normalized.primaryUserUpn ||
      row.normalized.person?.email ||
      row.normalized.person?.externalIds?.upn ||
      existing?.importMeta?.roomUpn
    ).toLowerCase();
    const patch = {
      assetTag: row.normalized.assetTag,
      serialNumber: row.normalized.serialNumber,
      modelId: row.modelId,
      status: row.normalized.mtrRegion
        ? 'deployed'
        : (row.normalized.person ? 'assigned' : ''),
      ram: row.normalized.ram,
      storage: row.normalized.storage,
      cpu: row.normalized.cpu,
      imei: row.normalized.imei,
      operatingSystem: [row.normalized.os, row.normalized.osVersion].filter(Boolean).join(' '),
      notes: buildImportNotes(row.normalized),
      enrolledAt: row.normalized.enrolledAt,
      lastEnrolledAt: row.normalized.lastEnrolledAt,
      externalIds: sourceExternalIds,
      importMeta: {
        source: row.source,
        lastImportedAt: now,
        lastImportFile: options.fileName,
        missingFromLastImport: false,
        roomUpn: row.normalized.mtrRegion ? roomUpn : (existing?.importMeta?.roomUpn || ''),
        entraObjectId: existing?.importMeta?.entraObjectId || ''
      }
    };

    if (existing) {
      const before = structuredClone(existing);
      mergeIfPresent(existing, patch);
      if (row.normalized.mtrRegion && roomUpn) existing.importMeta.roomUpn = roomUpn;
      if (before.importMeta?.entraObjectId) existing.importMeta.entraObjectId = before.importMeta.entraObjectId;
      if (row.normalized.mtrRegion) existing.status = 'deployed';
      existing.updatedAt = now;
      this.ensureUniqueAsset(existing);
      this.addAudit('asset', existing.id, 'import', actor, before, existing);
      return existing;
    }

    const created = {
      id: id(),
      assetTag: clean(patch.assetTag) || clean(patch.serialNumber),
      serialNumber: clean(patch.serialNumber),
      modelId: patch.modelId,
      status: normalizeAssetStatus(patch.status),
      ram: clean(patch.ram),
      storage: clean(patch.storage),
      cpu: clean(patch.cpu),
      imei: clean(patch.imei),
      operatingSystem: clean(patch.operatingSystem),
      warrantyUntil: '',
      purchaseDate: '',
      vendor: '',
      notes: clean(patch.notes),
      enrolledAt: clean(patch.enrolledAt),
      lastEnrolledAt: clean(patch.lastEnrolledAt),
      externalIds: {
        intuneDeviceId: clean(patch.externalIds.intuneDeviceId),
        jamfComputerId: clean(patch.externalIds.jamfComputerId)
      },
      importMeta: patch.importMeta,
      createdAt: now,
      updatedAt: now
    };
    requireFields(created, ['assetTag', 'serialNumber', 'modelId']);
    const conflict = this.findAssetConflict(created.assetTag, created.serialNumber);
    if (conflict) {
      const before = structuredClone(conflict);
      mergeIfPresent(conflict, patch);
      conflict.updatedAt = now;
      this.ensureUniqueAsset(conflict);
      this.addAudit('asset', conflict.id, 'import', actor, before, conflict);
      return conflict;
    }
    this.db.assets.push(created);
    this.addAudit('asset', created.id, 'import', actor, null, created);
    return created;
  }

  createImportAssignment(asset, person, row, actor, now, action) {
    const assignment = {
      id: id(),
      assetId: asset.id,
      personId: person.id,
      assignedAt: now.slice(0, 10),
      endedAt: '',
      reason: `Import ${row.source}`,
      notes: row.normalized.lastSeen ? `Last seen: ${row.normalized.lastSeen}` : '',
      createdAt: now,
      updatedAt: now
    };
    this.db.assignments.push(assignment);
    asset.status = 'assigned';
    asset.updatedAt = now;
    this.addAudit('asset', asset.id, action, actor, null, assignment);
  }

  async reassignAsset(assetId, input, actor) {
    const asset = this.db.assets.find((item) => item.id === assetId);
    if (!asset) throw notFound('Dispozitivul nu exista.');
    const person = this.db.people.find((item) => item.id === input.personId);
    if (!person) throw notFound('Persoana nu exista.');
    const now = nowIso();
    const assignedAt = clean(input.assignedAt) || now.slice(0, 10);
    const previous = this.getCurrentAssignment(assetId);
    if (previous) {
      previous.endedAt = assignedAt;
      previous.endReason = clean(input.reason) || 'Reasignare';
      previous.updatedAt = now;
    }
    const assignment = {
      id: id(),
      assetId,
      personId: person.id,
      assignedAt,
      endedAt: '',
      reason: clean(input.reason) || 'Alocare',
      notes: clean(input.notes),
      createdAt: now,
      updatedAt: now
    };
    this.db.assignments.push(assignment);
    const before = previous ? { previousAssignment: previous } : null;
    this.addAudit('asset', asset.id, previous ? 'reassign' : 'assign', actor, before, assignment);
    asset.status = 'assigned';
    asset.updatedAt = now;
    await this.save();
    return this.getAsset(assetId);
  }

  async unassignAsset(assetId, input, actor) {
    const asset = this.db.assets.find((item) => item.id === assetId);
    if (!asset) throw notFound('Dispozitivul nu exista.');
    const current = this.getCurrentAssignment(assetId);
    if (!current) throw new Error('Dispozitivul nu are alocare activa.');
    const before = structuredClone(current);
    current.endedAt = clean(input.endedAt) || nowIso().slice(0, 10);
    current.endReason = clean(input.reason) || 'Returnare in stoc';
    current.notes = clean(input.notes) || current.notes;
    current.updatedAt = nowIso();
    asset.status = normalizeAssetStatus(input.status || 'in_stock');
    asset.updatedAt = nowIso();
    this.addAudit('asset', asset.id, 'unassign', actor, before, current);
    await this.save();
    return this.getAsset(assetId);
  }

  async addInvoice(assetId, metadata, fileInfo, actor) {
    const asset = this.db.assets.find((item) => item.id === assetId);
    if (!asset) throw notFound('Dispozitivul nu exista.');
    const invoice = {
      id: id(),
      assetId,
      invoiceNumber: clean(metadata.invoiceNumber),
      invoiceDate: clean(metadata.invoiceDate),
      vendor: clean(metadata.vendor),
      amount: clean(metadata.amount),
      fileName: fileInfo.fileName,
      originalName: fileInfo.originalName,
      relativePath: fileInfo.relativePath,
      size: fileInfo.size,
      mimeType: fileInfo.mimeType,
      createdAt: nowIso()
    };
    this.db.invoices.push(invoice);
    this.addAudit('asset', asset.id, 'upload_invoice', actor, null, invoice);
    await this.save();
    return invoice;
  }

  getInvoice(idValue) {
    return this.db.invoices.find((item) => item.id === idValue) ?? null;
  }

  listPersonDocuments(personId) {
    return this.db.personDocuments
      .filter((document) => document.personId === personId)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((document) => structuredClone(document));
  }

  getPersonDocument(idValue) {
    return this.db.personDocuments.find((item) => item.id === idValue) ?? null;
  }

  async addPersonDocument(personId, metadata, fileInfo, actor) {
    const person = this.db.people.find((item) => item.id === personId);
    if (!person) throw notFound('Persoana nu exista.');
    const docType = clean(metadata.docType) || 'altul';
    if (!personDocumentTypes.includes(docType)) throw new Error('Tip document invalid.');
    const handoverDocumentId = clean(metadata.handoverDocumentId);
    if (handoverDocumentId) {
      const handover = this.db.handoverDocuments.find((item) => item.id === handoverDocumentId);
      if (!handover || handover.personId !== personId) throw new Error('PV-ul selectat nu apartine persoanei.');
    }
    const document = {
      id: id(),
      personId,
      title: clean(metadata.title) || clean(fileInfo.originalName) || 'Document IT',
      docType,
      notes: clean(metadata.notes),
      handoverDocumentId,
      fileName: fileInfo.fileName,
      originalName: fileInfo.originalName,
      relativePath: fileInfo.relativePath,
      size: fileInfo.size,
      mimeType: fileInfo.mimeType,
      createdBy: clean(actor) || 'IT',
      createdAt: nowIso()
    };
    this.db.personDocuments.push(document);
    this.addAudit('person', person.id, 'upload_document', actor, null, document);
    await this.save();
    return structuredClone(document);
  }

  async deletePersonDocument(idValue, actor) {
    const index = this.db.personDocuments.findIndex((item) => item.id === idValue);
    if (index < 0) throw notFound('Documentul nu exista.');
    const [removed] = this.db.personDocuments.splice(index, 1);
    this.addAudit('person', removed.personId, 'delete_document', actor, removed, null);
    await this.save();
    return removed;
  }

  listHandoverDocuments() {
    return this.db.handoverDocuments
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((document) => this.hydrateHandoverDocument(document));
  }

  getHandoverDocument(idValue) {
    const document = this.db.handoverDocuments.find((item) => item.id === idValue);
    return document ? this.hydrateHandoverDocument(document, true) : null;
  }

  previewHandoverDocument(input) {
    return this.buildHandoverDocument(input, { persist: false });
  }

  async createHandoverDocument(input, actor) {
    const document = this.buildHandoverDocument(input, { persist: true, actor });
    this.db.handoverDocuments.push(document);
    this.addAudit('handover_document', document.id, 'create', actor, null, document);
    await this.save();
    return this.hydrateHandoverDocument(document, true);
  }

  buildHandoverDocument(input, { persist = false, actor = 'IT' } = {}) {
    const type = clean(input.type);
    if (!['primire', 'predare'].includes(type)) throw new Error('Tip PV invalid.');
    if (!this.getHandoverOperators().includes(clean(input.itOperator))) throw new Error('Operator IT invalid.');

    const person = this.db.people.find((item) => item.id === clean(input.personId));
    if (!person) throw notFound('Persoana nu exista.');

    const assignedAssets = this.getActiveAssetsForPerson(person.id);
    const requestedIds = Array.isArray(input.assetIds) ? input.assetIds.map(clean).filter(Boolean) : [];
    const selectedAssets = requestedIds.length
      ? assignedAssets.filter((asset) => requestedIds.includes(asset.id))
      : assignedAssets;
    if (!selectedAssets.length) throw new Error('Persoana nu are dispozitive active pentru PV.');

    const selectedIds = new Set(selectedAssets.map((asset) => asset.id));
    const missingIds = requestedIds.filter((assetId) => !selectedIds.has(assetId));
    if (missingIds.length) throw new Error('Unul sau mai multe dispozitive nu sunt alocate persoanei selectate.');

    const now = nowIso();
    return {
      id: persist ? id() : '',
      type,
      personId: person.id,
      date: clean(input.date) || now.slice(0, 10),
      itOperator: clean(input.itOperator),
      assetIds: selectedAssets.map((asset) => asset.id),
      notes: clean(input.notes),
      createdBy: clean(actor) || 'IT',
      createdAt: persist ? now : '',
      person: structuredClone(person),
      assets: selectedAssets.map((asset) => this.hydrateAsset(asset, false))
    };
  }

  getActiveAssetsForPerson(personId) {
    const activeAssetIds = new Set(
      this.db.assignments
        .filter((assignment) => assignment.personId === personId && !assignment.endedAt)
        .map((assignment) => assignment.assetId)
    );
    return this.db.assets.filter((asset) => activeAssetIds.has(asset.id));
  }

  hydrateHandoverDocument(document, includeAssets = false) {
    const person = this.db.people.find((item) => item.id === document.personId) ?? document.person ?? null;
    const assets = includeAssets
      ? document.assetIds.map((assetId) => this.hydrateAsset(this.db.assets.find((asset) => asset.id === assetId))).filter(Boolean)
      : [];
    return {
      ...structuredClone(document),
      person: person ? structuredClone(person) : null,
      assets,
      assetCount: document.assetIds.length
    };
  }

  dashboard() {
    const hydratedAssets = this.listAssets();
    const total = hydratedAssets.length;
    const assigned = hydratedAssets.filter((asset) => asset.status === 'assigned').length;
    const inStock = hydratedAssets.filter((asset) => asset.status === 'in_stock').length;
    const service = hydratedAssets.filter((asset) => asset.status === 'service').length;
    const retired = hydratedAssets.filter((asset) => asset.status === 'retired').length;
    const deployed = hydratedAssets.filter((asset) => asset.status === 'deployed').length;
    const warrantyExpiring = hydratedAssets.filter((asset) =>
      isWarrantyExpiringWithinDays(asset.warrantyUntil, 30)
    );
    const recentAssignments = this.db.assignments
      .slice()
      .sort((a, b) => {
        const byDate = String(b.assignedAt || '').localeCompare(String(a.assignedAt || ''));
        if (byDate) return byDate;
        return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      })
      .slice(0, 8)
      .map((assignment) => ({
        ...assignment,
        asset: this.hydrateAsset(this.db.assets.find((asset) => asset.id === assignment.assetId)),
        person: this.db.people.find((person) => person.id === assignment.personId) ?? null
      }));

    const peopleActive = this.db.people.filter((person) => person.status !== 'inactive').length;
    const peopleInactive = this.db.people.length - peopleActive;
    const modelLabel = (asset) => formatAssetModelLabel(asset.model, asset.brand, asset.category);

    return {
      total,
      assigned,
      inStock,
      service,
      retired,
      deployed,
      warrantyExpiring,
      recentAssignments,
      people: {
        total: this.db.people.length,
        active: peopleActive,
        inactive: peopleInactive,
        byDepartment: countLabels(this.db.people, (person) => normalizeDepartmentLabel(person.department) || 'Fara departament'),
        byRole: countLabels(this.db.people, (person) => normalizeRoleLabel(person.role) || 'Fara rol')
      },
      devices: {
        byStatus: [
          { label: 'assigned', count: assigned },
          { label: 'in_stock', count: inStock },
          { label: 'deployed', count: deployed },
          { label: 'service', count: service },
          { label: 'retired', count: retired }
        ].filter((item) => item.count > 0),
        byCategory: countLabels(hydratedAssets, (asset) => asset.category?.name || 'Fara categorie'),
        byModel: countLabels(hydratedAssets, modelLabel)
      },
      personDocuments: {
        total: this.db.personDocuments.length,
        byType: countLabels(this.db.personDocuments, (document) => document.docType || 'altul')
      }
    };
  }

  withPersonStats(person, includeDocuments = false) {
    const activeAssignments = this.db.assignments.filter((assignment) => assignment.personId === person.id && !assignment.endedAt);
    const result = {
      ...structuredClone(person),
      activeAssignments: activeAssignments.map((assignment) => ({
        ...assignment,
        asset: this.hydrateAsset(this.db.assets.find((asset) => asset.id === assignment.assetId))
      })),
      documentCount: this.db.personDocuments.filter((document) => document.personId === person.id).length
    };
    if (includeDocuments) {
      result.documents = this.listPersonDocuments(person.id);
    }
    return result;
  }

  hydrateAsset(asset, includeDetails = false) {
    if (!asset) return null;
    const model = this.db.catalog.models.find((item) => item.id === asset.modelId) ?? null;
    const brand = model ? this.db.catalog.brands.find((item) => item.id === model.brandId) : null;
    const category = model ? this.db.catalog.categories.find((item) => item.id === model.categoryId) : null;
    const currentAssignment = this.getCurrentAssignment(asset.id);
    const hydrated = {
      ...structuredClone(asset),
      model,
      brand,
      category,
      currentAssignment: currentAssignment
        ? {
            ...structuredClone(currentAssignment),
            person: this.db.people.find((person) => person.id === currentAssignment.personId) ?? null
          }
        : null
    };
    if (includeDetails) {
      hydrated.assignments = this.db.assignments
        .filter((assignment) => assignment.assetId === asset.id)
        .map((assignment) => ({
          ...structuredClone(assignment),
          person: this.db.people.find((person) => person.id === assignment.personId) ?? null
        }));
      hydrated.invoices = this.db.invoices
        .filter((invoice) => invoice.assetId === asset.id)
        .map((invoice) => structuredClone(invoice));
      hydrated.auditLogs = this.db.auditLogs.filter((log) => log.entityId === asset.id || log.relatedPersonId === asset.id);
    }
    return hydrated;
  }

  getCurrentAssignment(assetId) {
    return this.db.assignments.find((assignment) => assignment.assetId === assetId && !assignment.endedAt) ?? null;
  }

  /**
   * Find an asset by serial number (case-insensitive). Used by invoice import.
   */
  findAssetBySerial(serial) {
    const s = clean(serial).toLowerCase();
    return this.db.assets.find((a) => clean(a.serialNumber).toLowerCase() === s) ?? null;
  }

  /**
   * Create a new catalog model dynamically (used during invoice import).
   * Requires: { brandId, name, generation, deviceType }
   * OR:       { brandName, categoryName, name, generation, deviceType }
   */
  async createCatalogModel(input, actor) {
    let brandId = clean(input.brandId);
    let categoryId = '';

    if (!brandId && input.brandName) {
      let brand = this.db.catalog.brands.find((b) => b.name.toLowerCase() === input.brandName.toLowerCase());
      if (!brand) {
        const categoryName = clean(input.categoryName) || (clean(input.deviceType) === 'Telefon' ? 'Telefon' : 'Laptop');
        let category = this.db.catalog.categories.find((item) => item.name === categoryName);
        if (!category) {
          category = { id: id(), name: categoryName };
          this.db.catalog.categories.push(category);
        }
        brand = { id: id(), categoryId: category.id, name: clean(input.brandName) };
        this.db.catalog.brands.push(brand);
        this.addAudit('catalog', brand.id, 'create_brand', actor, null, brand);
      }
      brandId = brand.id;
      categoryId = brand.categoryId;
    } else {
      const brand = this.db.catalog.brands.find((b) => b.id === brandId);
      if (!brand) throw new Error('Brand not found.');
      categoryId = brand.categoryId;
    }

    const name = clean(input.name);
    const generation = clean(input.generation) || 'Standard';
    const deviceType = clean(input.deviceType) || 'Laptop';

    if (!name) throw new Error('Model name is required.');

    const existing = this.db.catalog.models.find(
      (m) => m.brandId === brandId && m.name.toLowerCase() === name.toLowerCase() && m.generation === generation
    );
    if (existing) return existing;

    const model = { id: id(), categoryId, brandId, name, generation, deviceType };
    this.db.catalog.models.push(model);
    this.addAudit('catalog', model.id, 'create_model', actor, null, model);
    await this.save();
    return model;
  }

  requireModel(modelId) {
    const model = this.db.catalog.models.find((item) => item.id === modelId);
    if (!model) throw new Error('Modelul selectat nu exista.');
    return model;
  }

  ensureUniqueAsset(asset) {
    const duplicate = this.findAssetConflict(asset.assetTag, asset.serialNumber, asset.id);
    if (duplicate) throw new Error('Asset tag-ul sau seria exista deja.');
  }

  addAudit(entityType, entityId, action, actor, before, after) {
    this.db.auditLogs.push({
      id: id(),
      entityType,
      entityId,
      relatedPersonId: after?.personId ?? before?.personId ?? '',
      action,
      actor: clean(actor) || 'IT',
      timestamp: nowIso(),
      before,
      after
    });
  }
}

export function normalizeAssetStatus(status) {
  const value = clean(status);
  return ['in_stock', 'assigned', 'deployed', 'service', 'retired'].includes(value) ? value : 'in_stock';
}

export function isMtrCatalogModel(catalog, modelId) {
  const model = catalog?.models?.find((item) => item.id === modelId);
  if (!model) return false;
  const category = catalog.categories?.find((item) => item.id === model.categoryId);
  return String(category?.name || '').startsWith('MTR');
}

export function clean(value) {
  return String(value ?? '').trim();
}

export function id() {
  return randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

export function requireFields(object, fields) {
  for (const field of fields) {
    if (!object[field]) throw new Error(`Camp obligatoriu lipsa: ${field}`);
  }
}

function mergeIfPresent(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] ??= {};
      mergeIfPresent(target[key], value);
      continue;
    }
    const cleaned = clean(value);
    if (cleaned) target[key] = cleaned;
  }
}

function buildImportNotes(row) {
  return [
    row.externalId ? `External ID: ${row.externalId}` : '',
    row.lastSeen ? `Last seen: ${row.lastSeen}` : '',
    row.modelIdentifier ? `Model identifier: ${row.modelIdentifier}` : ''
  ].filter(Boolean).join('\n');
}

function assetReportRow(asset) {
  return {
    assetTag: asset.assetTag || '',
    serialNumber: asset.serialNumber || '',
    status: asset.status || '',
    category: asset.category?.name || asset.categoryName || '',
    brand: asset.brand?.name || asset.brandName || '',
    model: asset.model?.name || asset.modelName || formatAssetModelLabel(asset) || '',
    person: asset.currentAssignment?.person ? personDisplayName(asset.currentAssignment.person) : '',
    email: asset.currentAssignment?.person?.email || '',
    warrantyUntil: asset.warrantyUntil || '',
    source: asset.importMeta?.source || ''
  };
}

function personDisplayName(person) {
  return [person?.firstName, person?.lastName].filter(Boolean).join(' ').trim();
}

function countLabels(items, getLabel) {
  const counts = new Map();
  for (const item of items) {
    const label = clean(getLabel(item)) || 'Necunoscut';
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ro'));
}

/** Collapse FullStack / Fullstack Engineer / Developer variants into one role. */
export function normalizeRoleLabel(value) {
  const text = clean(value);
  if (!text) return '';
  const compact = text.toLocaleLowerCase('ro-RO').replace(/[\s_-]+/g, '');
  if (compact.includes('fullstack')) return 'Fullstack Engineer';
  return text;
}

/** Collapse eSolutions / Tchibo Brands department name variants. */
export function normalizeDepartmentLabel(value) {
  const text = clean(value);
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

export function notFound(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}
