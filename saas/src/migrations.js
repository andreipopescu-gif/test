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
  }
];
