import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { packages } from './packages.mjs';

for (const { dir, path } of packages) {
  const files = readdirSync(path).filter(file => /\.test\.(?:mjs|js)$/.test(file)).sort();
  if (files.length === 0) throw new Error(`No tests for ${dir}`);
  console.log(`\nTesting ${dir}`);
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd: path, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
