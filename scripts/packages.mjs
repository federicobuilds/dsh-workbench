import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const packagesRoot = join(root, 'packages');
export const packages = readdirSync(packagesRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort()
  .map(dir => {
    const path = join(packagesRoot, dir);
    const metadata = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    if (metadata.name !== `@dsh-workbench/${dir}` || !metadata.version || !metadata.description) {
      throw new Error(`Invalid package metadata for ${dir}`);
    }
    return { dir, path, metadata };
  });

export function packagesForPlatform(platform) {
  return packages.filter(({ metadata }) => !metadata.dsh.bundle.platforms || metadata.dsh.bundle.platforms.includes(platform));
}
