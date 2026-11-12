import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packages } from './packages.mjs';

export function packPackages(output) {
  mkdirSync(output, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const stdout = execFileSync(npm, [
    'pack', '--json', '--ignore-scripts', '--offline', '--pack-destination', output,
    ...packages.map(pkg => pkg.path),
  ], { cwd: output, encoding: 'utf8' });
  const packed = new Map(JSON.parse(stdout).map(entry => [entry.name, entry]));
  const archives = {};
  for (const { dir, metadata } of packages) {
    const entry = packed.get(metadata.name);
    if (!entry || entry.version !== metadata.version) throw new Error(`Pack result missing for ${dir}`);
    const paths = new Set(entry.files.map(file => file.path));
    for (const required of ['LICENSE', 'README.md', 'package.json', metadata.dsh.bundle.patch.slice(2)]) {
      if (!paths.has(required)) throw new Error(`${dir}: missing ${required} in packed files`);
    }
    for (const target of Object.values(metadata.exports ?? {})) {
      if (typeof target === 'string' && !target.includes('*') && !paths.has(target.slice(2))) {
        throw new Error(`${dir}: missing export ${target} in packed files`);
      }
    }
    for (const file of paths) {
      if (/(?:^|\/)(?:node_modules|\.git|\.venv)(?:\/|$)|\.private\.|\.tgz$|build-metadata\.json$/.test(file)) {
        throw new Error(`${dir}: unexpected packaged path ${file}`);
      }
    }
    archives[dir] = { file: entry.filename, sha256: archiveHash(join(output, entry.filename)) };
  }
  writeFileSync(join(output, 'archives.json'), JSON.stringify(archives, null, 2) + '\n');
  return archives;
}

export function archiveHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function readArchives(output) {
  return JSON.parse(readFileSync(join(output, 'archives.json'), 'utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/pack.mjs OUTPUT_DIRECTORY');
  const output = resolve(process.argv[2]);
  const archives = packPackages(output);
  console.log(`Packed ${Object.keys(archives).length} packages in ${output}`);
}
