import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { packagesRoot } from './packages.mjs';

const privateName = /(?:\.private\.|^\.env(?:$|\.(?!example$|sample$|template$))|\.(?:db|sqlite|tgz|pyc)$)/;
const localPath = /(?:\/Users\/[^/\s]+\/(?:Documents|Downloads|Library|\.(?:config|dsh|kilocode))\/|Downloads\/Kilo\/dsh-migration-|role-roster\.private\.json)/;
const secret = /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|\b(?:sk-(?:or-v1-|proj-|ant-)[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/;
let checked = 0;
function verify(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const label = relative(packagesRoot, path);
    if (['node_modules', '.git', '.venv'].includes(entry.name)) continue;
    if (entry.name === 'build-metadata.json' && label === 'dsh-message-edit/dist/build-metadata.json') continue;
    if (entry.isSymbolicLink() || privateName.test(entry.name)) throw new Error(`Unexpected source path: ${label}`);
    if (entry.isDirectory()) { verify(path); continue; }
    if (!/\.(?:[cm]?js|tsx?|json|ya?ml|md|txt|py|css|svg)$/.test(entry.name)) continue;
    const contents = readFileSync(path, 'utf8');
    const fixture = /\.test\.|(?:^|\/)test-fixtures\//.test(label);
    if (localPath.test(contents) || (!fixture && secret.test(contents))) {
      throw new Error(`Inspect private path or token marker in ${label}`);
    }
    checked++;
  }
}
verify(packagesRoot);
console.log(`Checked ${checked} source files for private paths and common token formats`);
