/** Assemble license notices for the modules actually bundled in this plugin. */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('.', import.meta.url))
const meta = JSON.parse(await readFile(root + 'dist/build-metadata.json', 'utf8'))
const repository = 'git+https://github.com/deepseek-ai/deepseek-harness.git'
const chatLicense = (await readFile(root + 'DSH-LICENSE', 'utf8')).trim()
const dshVersion = JSON.parse(await readFile(root + 'package.json', 'utf8')).engines.dsh
const directories = new Map()
for (const file of new Set([...Object.keys(meta.host.inputs), ...Object.keys(meta.client.inputs)])) {
  let directory = dirname(resolve(meta.cwd, file))
  while (directory !== parse(directory).root) {
    try {
      const pkg = JSON.parse(await readFile(directory + '/package.json', 'utf8'))
      if (typeof pkg.name === 'string') {
        directories.set(directory, { name: pkg.name, version: pkg.version, license: pkg.license, repository: pkg.repository })
        break
      }
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error }
    directory = dirname(directory)
  }
}
let out = '# Bundled license notices\n\n'
out += 'This plugin privately bundles the version-matched DSH Chat presentation and its reachable static dependencies. Shared React, Cordis and virtualizer modules remain supplied by DSH.\n\n'
const names = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'COPYING', 'OFL.txt', 'NOTICE']
for (const [directory, pkg] of [...directories].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  out += `## ${pkg.name} ${pkg.version}\n\nLicense declaration: ${pkg.license ?? 'See upstream notice'}.\n\n`
  let found = false
  for (const name of names) {
    try { out += '```text\n' + (await readFile(directory + '/' + name, 'utf8')).trim() + '\n```\n\n'; found = true }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (!found && pkg.repository?.url === repository && pkg.repository?.directory?.startsWith('packages/')
    && pkg.license === 'MIT' && pkg.version === dshVersion) {
    out += '```text\n' + chatLicense + '\n```\n\n'
  } else if (!found && pkg.name !== '@dsh-workbench/dsh-message-edit') {
    throw new Error('No license file found for bundled dependency ' + pkg.name)
  }
}
out += '## Copied DSH Chat implementation\n\n```text\n' + chatLicense.trim() + '\n```\n'
await writeFile(root + 'dist/LICENSES.md', out)
console.log('Collected notices for ' + directories.size + ' bundled package roots.')
