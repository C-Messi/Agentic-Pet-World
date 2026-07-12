import type { StorageDatabase } from './database.js';
import { initialMigrationSql } from './migrations/001-initial.js';
import { actionDeliveryIdentityMigrationSql } from './migrations/002-action-delivery-identity.js';
import { petTownMigrationSql } from './migrations/003-pet-town.js';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: initialMigrationSql,
  },
  {
    version: 2,
    name: 'action-delivery-identity',
    sql: actionDeliveryIdentityMigrationSql,
  },
  {
    version: 3,
    name: '003_pet_town',
    sql: petTownMigrationSql,
  },
];

export function loadMigrations(): readonly Migration[] {
  return migrations;
}

export function runMigrations(
  database: StorageDatabase,
  pendingMigrations = loadMigrations(),
): void {
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      )
    `);
  })();

  const appliedVersions = new Set(
    database
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => (row as { version: number }).version),
  );

  const applyMigration = database.transaction((migration: Migration) => {
    database.exec(migration.sql);
    database
      .prepare(
        `INSERT INTO schema_migrations (version, name, applied_at)
         VALUES (?, ?, ?)`,
      )
      .run(migration.version, migration.name, new Date().toISOString());
  });

  for (const migration of pendingMigrations) {
    if (!appliedVersions.has(migration.version)) {
      applyMigration(migration);
    }
  }
}
