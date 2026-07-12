import { basename, dirname, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const prefix = 'agent-cat-house-e2e-';

export function removeE2ERunDirectory(directory: string): void {
  const resolved = resolve(directory);
  if (dirname(resolved) !== resolve(tmpdir()) || !basename(resolved).startsWith(prefix)) {
    throw new Error(`Refusing to remove unexpected E2E directory: ${directory}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

export const e2eDirectoryPrefix = prefix;
