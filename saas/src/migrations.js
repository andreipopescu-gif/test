const commonTables = `
  CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memberships (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin', 'it', 'readonly')),
    created_at TEXT NOT NULL,
    UNIQUE (organization_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT,
    department TEXT,
    role_title TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    asset_tag TEXT NOT NULL,
    serial_number TEXT NOT NULL,
    model_name TEXT,
    status TEXT NOT NULL DEFAULT 'in_stock',
    person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (organization_id, serial_number),
    UNIQUE (organization_id, asset_tag)
  );

  CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'it', 'readonly')),
    token_hash TEXT NOT NULL UNIQUE,
    invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS import_batches (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    source TEXT NOT NULL CHECK (source IN ('intune', 'jamf')),
    file_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('preview', 'applied', 'cancelled')),
    summary_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    applied_at TEXT
  );

  CREATE TABLE IF NOT EXISTS import_rows (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    row_key TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('create', 'update', 'skip')),
    data_json TEXT NOT NULL,
    warnings_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    UNIQUE (batch_id, row_key)
  );

  CREATE INDEX IF NOT EXISTS idx_people_org ON people(organization_id);
  CREATE INDEX IF NOT EXISTS idx_assets_org ON assets(organization_id);
  CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
  CREATE INDEX IF NOT EXISTS idx_memberships_org ON memberships(organization_id);
  CREATE INDEX IF NOT EXISTS idx_invitations_org ON invitations(organization_id);
  CREATE INDEX IF NOT EXISTS idx_audit_org_created ON audit_logs(organization_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_import_batches_org ON import_batches(organization_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_import_rows_batch ON import_rows(batch_id);
`;

// Seeded lazily per organization from seed/models.json, never globally: one
// tenant's hardware catalogue must not leak into another's pickers.
const catalogTables = `
  CREATE TABLE IF NOT EXISTS catalog_categories (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (organization_id, key)
  );

  CREATE TABLE IF NOT EXISTS catalog_brands (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL REFERENCES catalog_categories(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE (organization_id, category_id, key)
  );

  CREATE TABLE IF NOT EXISTS catalog_models (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    brand_id TEXT NOT NULL REFERENCES catalog_brands(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    aliases_json TEXT NOT NULL DEFAULT '[]',
    UNIQUE (organization_id, brand_id, key)
  );

  CREATE INDEX IF NOT EXISTS idx_catalog_categories_org ON catalog_categories(organization_id);
  CREATE INDEX IF NOT EXISTS idx_catalog_brands_org ON catalog_brands(organization_id);
  CREATE INDEX IF NOT EXISTS idx_catalog_models_org ON catalog_models(organization_id);
`;

export const sqliteMigrations = [
  {
    version: 1,
    sql: `
      ${commonTables}

      CREATE TRIGGER IF NOT EXISTS assets_person_same_organization_insert
      BEFORE INSERT ON assets
      WHEN NEW.person_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM people
          WHERE id = NEW.person_id AND organization_id = NEW.organization_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'person belongs to another organization');
      END;

      CREATE TRIGGER IF NOT EXISTS assets_person_same_organization_update
      BEFORE UPDATE OF person_id, organization_id ON assets
      WHEN NEW.person_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM people
          WHERE id = NEW.person_id AND organization_id = NEW.organization_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'person belongs to another organization');
      END;
    `
  },
  {
    version: 2,
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower_unique
      ON users(LOWER(email));
    `
  },
  {
    version: 3,
    sql: `
      ALTER TABLE users ADD COLUMN token_epoch INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS organization_settings (
        organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        excluded_emails_json TEXT NOT NULL DEFAULT '[]',
        excluded_name_rules_json TEXT NOT NULL DEFAULT '[]',
        identity_groups_json TEXT NOT NULL DEFAULT '[]',
        model_overrides_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );
      ALTER TABLE import_batches ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE assets ADD COLUMN external_ids_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE assets ADD COLUMN import_meta_json TEXT NOT NULL DEFAULT '{}';
      CREATE TABLE IF NOT EXISTS asset_assignments (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        end_reason TEXT,
        source TEXT NOT NULL DEFAULT 'manual'
      );
      CREATE INDEX IF NOT EXISTS idx_asset_assignments_asset ON asset_assignments(asset_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_asset_assignments_org ON asset_assignments(organization_id);
      CREATE TABLE IF NOT EXISTS rate_limits (
        bucket TEXT NOT NULL,
        client_key TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (bucket, client_key, window_start)
      );
    `
  },
  {
    // SQLite cannot widen a CHECK constraint in place, so the two tables whose
    // vocabulary grew (import actions, import kinds) are rebuilt. Both are
    // working tables for the import wizard, so copying them is cheap.
    version: 5,
    sql: `
      ${catalogTables}

      ALTER TABLE people ADD COLUMN external_ids_json TEXT NOT NULL DEFAULT '{}';

      ALTER TABLE assets ADD COLUMN model_id TEXT REFERENCES catalog_models(id) ON DELETE SET NULL;
      ALTER TABLE assets ADD COLUMN category TEXT;
      ALTER TABLE assets ADD COLUMN brand TEXT;
      ALTER TABLE assets ADD COLUMN ram_gb INTEGER;
      ALTER TABLE assets ADD COLUMN storage_gb INTEGER;
      ALTER TABLE assets ADD COLUMN cpu TEXT;
      ALTER TABLE assets ADD COLUMN imei TEXT;
      ALTER TABLE assets ADD COLUMN operating_system TEXT;
      ALTER TABLE assets ADD COLUMN warranty_ends_on TEXT;
      ALTER TABLE assets ADD COLUMN purchased_on TEXT;
      ALTER TABLE assets ADD COLUMN vendor TEXT;
      ALTER TABLE assets ADD COLUMN notes TEXT;
      ALTER TABLE assets ADD COLUMN enrolled_at TEXT;
      ALTER TABLE assets ADD COLUMN last_enrolled_at TEXT;

      CREATE TABLE import_batches_v5 (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        kind TEXT NOT NULL DEFAULT 'devices' CHECK (kind IN ('devices', 'users')),
        source TEXT NOT NULL CHECK (source IN ('intune', 'jamf', 'entra', 'intune_users')),
        file_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('preview', 'applied', 'cancelled')),
        summary_json TEXT NOT NULL,
        policy_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        applied_at TEXT
      );
      INSERT INTO import_batches_v5 (
        id, organization_id, user_id, kind, source, file_name, status,
        summary_json, policy_json, created_at, applied_at
      )
      SELECT id, organization_id, user_id, 'devices', source, file_name, status,
             summary_json, policy_json, created_at, applied_at
      FROM import_batches;

      CREATE TABLE import_rows_v5 (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES import_batches_v5(id) ON DELETE CASCADE,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        row_key TEXT NOT NULL,
        action TEXT NOT NULL CHECK (
          action IN ('create', 'update', 'reassign', 'skip', 'needs_review')
        ),
        data_json TEXT NOT NULL,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE (batch_id, row_key)
      );
      INSERT INTO import_rows_v5 (
        id, batch_id, organization_id, row_key, action, data_json, warnings_json, created_at
      )
      SELECT id, batch_id, organization_id, row_key, action, data_json, warnings_json, created_at
      FROM import_rows;

      DROP TABLE import_rows;
      DROP TABLE import_batches;
      ALTER TABLE import_batches_v5 RENAME TO import_batches;
      ALTER TABLE import_rows_v5 RENAME TO import_rows;
      CREATE INDEX IF NOT EXISTS idx_import_batches_org ON import_batches(organization_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_import_rows_batch ON import_rows(batch_id);
    `
  },
  {
    // Per-tenant editable catalog metadata, options, custom fields and saved
    // import profiles. import_batches.source is widened so new MDM presets and
    // mapped imports can be stored without a second rebuild later.
    version: 6,
    sql: `
      ALTER TABLE catalog_categories ADD COLUMN archived_at TEXT;
      ALTER TABLE catalog_categories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE catalog_brands ADD COLUMN archived_at TEXT;
      ALTER TABLE catalog_brands ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE catalog_models ADD COLUMN archived_at TEXT;
      ALTER TABLE catalog_models ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS org_options (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('status', 'department', 'location')),
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        meta_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (organization_id, kind, key)
      );
      CREATE INDEX IF NOT EXISTS idx_org_options_org_kind ON org_options(organization_id, kind);

      CREATE TABLE IF NOT EXISTS custom_field_defs (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        entity TEXT NOT NULL CHECK (entity IN ('asset', 'person')),
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('text', 'number', 'date', 'select', 'boolean')),
        options_json TEXT NOT NULL DEFAULT '[]',
        required INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        UNIQUE (organization_id, entity, key)
      );
      CREATE INDEX IF NOT EXISTS idx_custom_field_defs_org ON custom_field_defs(organization_id, entity);

      ALTER TABLE assets ADD COLUMN location_key TEXT;
      ALTER TABLE assets ADD COLUMN custom_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE people ADD COLUMN custom_json TEXT NOT NULL DEFAULT '{}';

      CREATE TABLE IF NOT EXISTS import_profiles (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        preset_key TEXT,
        header_signature TEXT NOT NULL,
        mapping_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (organization_id, header_signature)
      );
      CREATE INDEX IF NOT EXISTS idx_import_profiles_org ON import_profiles(organization_id);

      CREATE TABLE import_batches_v6 (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        kind TEXT NOT NULL DEFAULT 'devices' CHECK (kind IN ('devices', 'users')),
        source TEXT NOT NULL,
        profile_id TEXT REFERENCES import_profiles(id) ON DELETE SET NULL,
        file_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('preview', 'applied', 'cancelled')),
        summary_json TEXT NOT NULL,
        policy_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        applied_at TEXT
      );
      INSERT INTO import_batches_v6 (
        id, organization_id, user_id, kind, source, file_name, status,
        summary_json, policy_json, created_at, applied_at
      )
      SELECT id, organization_id, user_id, kind, source, file_name, status,
             summary_json, policy_json, created_at, applied_at
      FROM import_batches;

      CREATE TABLE import_rows_v6 (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES import_batches_v6(id) ON DELETE CASCADE,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        row_key TEXT NOT NULL,
        action TEXT NOT NULL CHECK (
          action IN ('create', 'update', 'reassign', 'skip', 'needs_review')
        ),
        data_json TEXT NOT NULL,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE (batch_id, row_key)
      );
      INSERT INTO import_rows_v6 (
        id, batch_id, organization_id, row_key, action, data_json, warnings_json, created_at
      )
      SELECT id, batch_id, organization_id, row_key, action, data_json, warnings_json, created_at
      FROM import_rows;

      DROP TABLE import_rows;
      DROP TABLE import_batches;
      ALTER TABLE import_batches_v6 RENAME TO import_batches;
      ALTER TABLE import_rows_v6 RENAME TO import_rows;
      CREATE INDEX IF NOT EXISTS idx_import_batches_org ON import_batches(organization_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_import_rows_batch ON import_rows(batch_id);
    `
  },
  {
    version: 7,
    sql: `
      ALTER TABLE people ADD COLUMN source_presence_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE people ADD COLUMN manager_email TEXT;
      ALTER TABLE people ADD COLUMN last_synced_at TEXT;
      ALTER TABLE assets ADD COLUMN last_seen_at TEXT;
      ALTER TABLE assets ADD COLUMN source_presence_json TEXT NOT NULL DEFAULT '{}';
      CREATE INDEX IF NOT EXISTS idx_assets_org_last_seen ON assets(organization_id, last_seen_at);
      ALTER TABLE organization_settings ADD COLUMN exception_rules_json TEXT NOT NULL DEFAULT '{}';

      CREATE TABLE IF NOT EXISTS exceptions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        rule_key TEXT NOT NULL,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'asset')),
        entity_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'snoozed', 'resolved', 'dismissed')),
        details_json TEXT NOT NULL DEFAULT '{}',
        assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        first_detected_at TEXT NOT NULL,
        last_detected_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        resolution TEXT,
        snooze_until TEXT,
        UNIQUE (organization_id, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS idx_exceptions_org_status ON exceptions(organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_exceptions_org_entity ON exceptions(organization_id, entity_type, entity_id);

      CREATE TABLE IF NOT EXISTS exception_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        exception_id TEXT NOT NULL REFERENCES exceptions(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_exception_events_exception ON exception_events(exception_id, created_at);

      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'disconnected',
        scopes_json TEXT NOT NULL DEFAULT '[]',
        encrypted_credentials TEXT,
        config_json TEXT NOT NULL DEFAULT '{}',
        last_sync_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (organization_id, provider)
      );
    `
  },
  {
    version: 8,
    sql: `
      ALTER TABLE organization_settings ADD COLUMN retention_json TEXT NOT NULL DEFAULT '{}';
    `
  }
];

export const postgresMigrations = [
  {
    version: 1,
    sql: `
      ${commonTables}

      CREATE OR REPLACE FUNCTION check_asset_person_organization()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.person_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM people
          WHERE id = NEW.person_id AND organization_id = NEW.organization_id
        ) THEN
          RAISE EXCEPTION 'person belongs to another organization';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS assets_person_same_organization ON assets;
      CREATE TRIGGER assets_person_same_organization
      BEFORE INSERT OR UPDATE OF person_id, organization_id ON assets
      FOR EACH ROW EXECUTE FUNCTION check_asset_person_organization();
    `
  },
  {
    version: 2,
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower_unique
      ON users(LOWER(email));
    `
  },
  {
    // Tokens are stateless, so a password change would otherwise leave a stolen
    // session valid until it expired. The epoch travels in the token and is
    // compared on every request; bumping it ends every existing session.
    version: 3,
    sql: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS token_epoch INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS organization_settings (
        organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        excluded_emails_json TEXT NOT NULL DEFAULT '[]',
        excluded_name_rules_json TEXT NOT NULL DEFAULT '[]',
        identity_groups_json TEXT NOT NULL DEFAULT '[]',
        model_overrides_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );
      ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS policy_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS external_ids_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS import_meta_json TEXT NOT NULL DEFAULT '{}';
      CREATE TABLE IF NOT EXISTS asset_assignments (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        end_reason TEXT,
        source TEXT NOT NULL DEFAULT 'manual'
      );
      CREATE INDEX IF NOT EXISTS idx_asset_assignments_asset ON asset_assignments(asset_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_asset_assignments_org ON asset_assignments(organization_id);
      CREATE TABLE IF NOT EXISTS rate_limits (
        bucket TEXT NOT NULL,
        client_key TEXT NOT NULL,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (bucket, client_key, window_start)
      );
    `
  },
  {
    version: 5,
    sql: `
      ${catalogTables}

      ALTER TABLE people ADD COLUMN IF NOT EXISTS external_ids_json TEXT NOT NULL DEFAULT '{}';

      ALTER TABLE assets ADD COLUMN IF NOT EXISTS model_id TEXT REFERENCES catalog_models(id) ON DELETE SET NULL;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS category TEXT;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS brand TEXT;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS ram_gb INTEGER;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS storage_gb INTEGER;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS cpu TEXT;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS imei TEXT;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS operating_system TEXT;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS warranty_ends_on TEXT;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS purchased_on TEXT;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS vendor TEXT;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS notes TEXT;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS enrolled_at TEXT;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS last_enrolled_at TEXT;

      ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'devices';
      ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batches_kind_check;
      ALTER TABLE import_batches ADD CONSTRAINT import_batches_kind_check
        CHECK (kind IN ('devices', 'users'));
      ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batches_source_check;
      ALTER TABLE import_batches ADD CONSTRAINT import_batches_source_check
        CHECK (source IN ('intune', 'jamf', 'entra', 'intune_users'));

      ALTER TABLE import_rows DROP CONSTRAINT IF EXISTS import_rows_action_check;
      ALTER TABLE import_rows ADD CONSTRAINT import_rows_action_check
        CHECK (action IN ('create', 'update', 'reassign', 'skip', 'needs_review'));
    `
  },
  {
    version: 6,
    sql: `
      ALTER TABLE catalog_categories ADD COLUMN IF NOT EXISTS archived_at TEXT;
      ALTER TABLE catalog_categories ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE catalog_brands ADD COLUMN IF NOT EXISTS archived_at TEXT;
      ALTER TABLE catalog_brands ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE catalog_models ADD COLUMN IF NOT EXISTS archived_at TEXT;
      ALTER TABLE catalog_models ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS org_options (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('status', 'department', 'location')),
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        meta_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (organization_id, kind, key)
      );
      CREATE INDEX IF NOT EXISTS idx_org_options_org_kind ON org_options(organization_id, kind);

      CREATE TABLE IF NOT EXISTS custom_field_defs (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        entity TEXT NOT NULL CHECK (entity IN ('asset', 'person')),
        key TEXT NOT NULL,
        label TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('text', 'number', 'date', 'select', 'boolean')),
        options_json TEXT NOT NULL DEFAULT '[]',
        required BOOLEAN NOT NULL DEFAULT FALSE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        UNIQUE (organization_id, entity, key)
      );
      CREATE INDEX IF NOT EXISTS idx_custom_field_defs_org ON custom_field_defs(organization_id, entity);

      ALTER TABLE assets ADD COLUMN IF NOT EXISTS location_key TEXT;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS custom_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE people ADD COLUMN IF NOT EXISTS custom_json TEXT NOT NULL DEFAULT '{}';

      CREATE TABLE IF NOT EXISTS import_profiles (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        preset_key TEXT,
        header_signature TEXT NOT NULL,
        mapping_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (organization_id, header_signature)
      );
      CREATE INDEX IF NOT EXISTS idx_import_profiles_org ON import_profiles(organization_id);

      ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS profile_id TEXT REFERENCES import_profiles(id) ON DELETE SET NULL;
      ALTER TABLE import_batches DROP CONSTRAINT IF EXISTS import_batches_source_check;
    `
  },
  {
    version: 7,
    sql: `
      ALTER TABLE people ADD COLUMN IF NOT EXISTS source_presence_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE people ADD COLUMN IF NOT EXISTS manager_email TEXT;
      ALTER TABLE people ADD COLUMN IF NOT EXISTS last_synced_at TEXT;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS last_seen_at TEXT;
      ALTER TABLE assets ADD COLUMN IF NOT EXISTS source_presence_json TEXT NOT NULL DEFAULT '{}';
      CREATE INDEX IF NOT EXISTS idx_assets_org_last_seen ON assets(organization_id, last_seen_at);
      ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS exception_rules_json TEXT NOT NULL DEFAULT '{}';

      CREATE TABLE IF NOT EXISTS exceptions (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        rule_key TEXT NOT NULL,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'asset')),
        entity_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'snoozed', 'resolved', 'dismissed')),
        details_json TEXT NOT NULL DEFAULT '{}',
        assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        first_detected_at TEXT NOT NULL,
        last_detected_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        resolution TEXT,
        snooze_until TEXT,
        UNIQUE (organization_id, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS idx_exceptions_org_status ON exceptions(organization_id, status);
      CREATE INDEX IF NOT EXISTS idx_exceptions_org_entity ON exceptions(organization_id, entity_type, entity_id);

      CREATE TABLE IF NOT EXISTS exception_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        exception_id TEXT NOT NULL REFERENCES exceptions(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_exception_events_exception ON exception_events(exception_id, created_at);

      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'disconnected',
        scopes_json TEXT NOT NULL DEFAULT '[]',
        encrypted_credentials TEXT,
        config_json TEXT NOT NULL DEFAULT '{}',
        last_sync_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (organization_id, provider)
      );
    `
  },
  {
    version: 8,
    sql: `
      ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS retention_json TEXT NOT NULL DEFAULT '{}';
    `
  }
];
