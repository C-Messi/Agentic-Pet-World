import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StorageDatabase } from './database.js';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrationFilePattern = /^(\d+)_([a-z0-9_]+)\.sql$/;
const defaultMigrationsDirectory = fileURLToPath(
  new URL('./migrations', import.meta.url),
);

export function loadMigrations(
  directory = defaultMigrationsDirectory,
): readonly Migration[] {
  return readdirSync(directory)
    .filter((filename) => filename.endsWith('.sql'))
    .map((filename) => {
      const match = migrationFilePattern.exec(filename);
      if (match === null) {
        throw new Error(`Invalid migration filename: ${filename}`);
      }

      const versionText = match[1];
      const name = match[2];
      if (versionText === undefined || name === undefined) {
        throw new Error(`Invalid migration filename: ${filename}`);
      }

      return {
        version: Number.parseInt(versionText, 10),
        name,
        sql: readFileSync(join(directory, filename), 'utf8'),
      };
    })
    .sort((left, right) => left.version - right.version);
}

export function runMigrations(
  database: StorageDatabase,
  migrations = loadMigrations(),
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

  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) {
      applyMigration(migration);
    }
  }
}
