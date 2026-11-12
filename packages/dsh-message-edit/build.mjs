/** Build self-contained plugin artifacts; never rebuild or replace the DSH app. */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const resolveLocal = createRequire(import.meta.url)
const { build } = await import('esbuild')
const root = fileURLToPath(new URL('.', import.meta.url))
const zod = resolveLocal.resolve('zod')
await mkdir(root + 'dist', { recursive: true })
const tsconfig = root + 'tsconfig.json'
const hostBuild = await build({ entryPoints: [root + 'host.mjs'], outfile: root + 'dist/index.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node24', tsconfig, metafile: true, nodePaths: [root + 'node_modules'],
  alias: { zod }, legalComments: 'inline' })
const browser = await build({ entryPoints: [root + 'native-chat/src/client/index.ts'], write: false,
  outfile: root + 'dist/native.js', tsconfig, nodePaths: [root + 'node_modules'],
  bundle: true, platform: 'browser', format: 'iife', globalName: 'MessageEditClient', jsx: 'automatic',
  target: 'es2022', external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@tanstack/react-virtual'],
  define: { 'process.env': '{}' }, loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl' },
  legalComments: 'inline', metafile: true })
const js = browser.outputFiles.find(file => file.path.endsWith('.js')).text
const css = browser.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? ''
const wrapper = `window.__ModuleLoader__.load({id:'@dsh-workbench/dsh-message-edit',factory(require){\n${js}\nconst nativeApply=MessageEditClient.apply;return {...MessageEditClient,apply(ctx){ctx.effect(()=>{const tag=document.createElement('style');tag.dataset.plugin='@dsh-workbench/dsh-message-edit';tag.textContent=${JSON.stringify(css)};document.head.appendChild(tag);return()=>tag.remove();});return nativeApply(ctx);}};}});\n`
await writeFile(root + 'dist/client.js', wrapper)
const packageVersion = JSON.parse(await readFile(root + 'package.json', 'utf8')).version
await writeFile(root + `dist/index-${packageVersion}.js`, await readFile(root + 'dist/index.js', 'utf8'))
await writeFile(root + `dist/client-${packageVersion}.js`, wrapper)
await writeFile(root + 'dist/build-metadata.json', JSON.stringify({ cwd: process.cwd(), host: hostBuild.metafile, client: browser.metafile }, null, 2))
// Isolated Loader/browser fixture. It is never installed into the desktop profile.
await mkdir(root + 'tests/fixture', { recursive: true })
await writeFile(root + 'tests/fixture/index.js', await readFile(root + 'dist/index.js', 'utf8'))
await writeFile(root + 'tests/fixture/client.js', wrapper)
await writeFile(root + 'tests/fixture/package.json', JSON.stringify({ name: '@dsh-workbench/dsh-message-edit',
  version: packageVersion, private: true, type: 'module', exports: { '.': './index.js', './client': './client.js' },
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } } }, null, 2) + '\n')
await writeFile(root + 'tests/fixture/cordis.patch.yml', "- id: ui-chat\n  disabled: true\n- insert:\n    - id: message-edit\n      name: '@dsh-workbench/dsh-message-edit'\n      config:\n        transcriptView: detailed\n        performanceUsage: detailed\n        collapseTiming: completion\n        foldedReplies: all\n        linkOpening: sidebar\n")
console.log('Built self-contained Host and Client plugin artifacts and isolated test fixture.')
