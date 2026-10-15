import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const { dependencies } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries(dependencies)) {
    const installed = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'));
    if (installed.version !== version) process.exit(1);
  }
} catch { process.exit(1); }
