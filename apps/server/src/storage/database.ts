import Database from 'better-sqlite3';

import { runMigrations } from './migrations.js';

export type StorageDatabase = Database.Database;

export function openDatabase(path: string): StorageDatabase {
  const database = new Database(path);

  try {
    database.pragma('foreign_keys = ON');
    if (path !== ':memory:' && path !== '') {
      database.pragma('journal_mode = WAL');
    }
    runMigrations(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
