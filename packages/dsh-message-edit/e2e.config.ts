import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from '../dsh-source/node_modules/typescript/lib/typescript.js'
import { standardDecoratorPlugin, vitestExecArgv } from '../dsh-source/vitest.shared.ts'

const upstreamRoot = realpathSync(fileURLToPath(new URL('../dsh-source', import.meta.url)))
const configPath = resolve(upstreamRoot, 'tsconfig.base.json')
const { config, error } = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'))
if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, '\n'))
const paths = config.compilerOptions.paths as Record<string, string[]>
const escapeRegex = (text: string) => text.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
const alias = Object.entries(paths).sort(([a], [b]) => b.length - a.length).map(([name, [target]]) => ({
  find: new RegExp(`^${name.split('*').map(escapeRegex).join('(.*)')}$`),
  replacement: resolve(upstreamRoot, target.replace('*', '$1')),
}))

export default {
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias },
  plugins: [standardDecoratorPlugin()],
  test: {
    pool: 'threads',
    execArgv: vitestExecArgv,
    include: ['plugin.e2e.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 45000,
    hookTimeout: 90000,
  },
}
