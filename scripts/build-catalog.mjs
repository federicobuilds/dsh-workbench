import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, packages } from './packages.mjs';

const entries = packages.map(({ metadata }) => ({
  name: metadata.name, version: metadata.version, description: metadata.description,
  ...(metadata.dsh.bundle.platforms ? { platforms: metadata.dsh.bundle.platforms } : {}),
}));
mkdirSync(join(root, 'site'), { recursive: true });
writeFileSync(join(root, 'site', 'index.json'), JSON.stringify({
  schema: 'dsh-workbench.catalog/v1', count: entries.length, packages: entries,
}, null, 2) + '\n');
console.log(`Catalog written: ${entries.length} packages`);
