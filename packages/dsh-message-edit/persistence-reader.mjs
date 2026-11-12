import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const require = createRequire(import.meta.url);

function readWorker(archive) {
  if (!archive) {
    const entry = require.resolve('@deepseek-ai/dsh-session-persistence-jsonl');
    return readFileSync(join(dirname(entry), 'worker.cjs'), 'utf8');
  }
  const bytes = readFileSync(archive);
  const header = JSON.parse(bytes.subarray(16, 16 + bytes.readUInt32LE(12)).toString('utf8'));
  const base = 8 + bytes.readUInt32LE(4);
  const path = 'dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs';
  let entry = header;
  for (const part of path.split('/')) entry = entry.files[part];
  const start = base + Number(entry.offset);
  return bytes.subarray(start, start + entry.size).toString('utf8');
}

// Load the version-pinned reader without starting its worker.
export function installedSessionReader(archive = process.env.DSH_TEST_DESKTOP_ASAR) {
  const code = readWorker(archive);
  const boundary = code.indexOf('//#region lib/types/win32.js')
  if (boundary < 0 || !code.slice(0, boundary).includes('var SessionLogScanner = class')) {
    throw new Error('Unsupported installed DSH reader layout')
  }
  const runtimeRequire = specifier => {
    if (specifier === 'node:module') {
      return { ...require(specifier), createRequire: () => target => {
        if (target !== '../package.json') throw new Error('Unexpected reader dependency: ' + target)
        return { version: '0.2.2-rc.1' }
      } }
    }
    return require(specifier)
  }
  const Scanner = new Function('require', '__filename', code.slice(0, boundary) + '\nreturn SessionLogScanner;')(
    runtimeRequire, '/installed-dsh-reader/worker.cjs')
  const frameScannerSource = code.match(/function scanZstdFrames[\s\S]*?\n}\n/)?.[0]
  if (!frameScannerSource) throw new Error('Unsupported installed DSH frame scanner layout')
  const scanFrames = new Function('const ZSTD_MAGIC = 0xFD2FB528;\n' + frameScannerSource + '\nreturn scanZstdFrames;')()
  const readSession = raw => {
    const newline = raw.indexOf(10)
    if (newline < 0 || raw.at(-1) !== 10) throw new Error('Session log must contain complete newline-terminated records')
    const scanner = new Scanner(raw.subarray(0, newline + 1), 'strict')
    scanner.write(raw.subarray(newline + 1))
    return scanner.finish()
  }
  readSession.compressed = bytes => {
    const { frames, tornStart } = scanFrames(bytes)
    if (tornStart !== undefined || frames.length === 0) throw new Error('Incomplete compressed session artifact')
    const plaintext = frames.map(frame => zstdDecompressSync(bytes.subarray(frame.start, frame.end)))
    const header = plaintext[0]
    if (header.length === 0 || header.indexOf(10) !== header.length - 1) {
      throw new Error('corrupt Zstandard session log: first frame is not exactly one header line')
    }
    if (plaintext.some(frame => frame.at(-1) !== 10)) throw new Error('Compressed frame contains a torn JSONL record')
    return { ...readSession(Buffer.concat(plaintext)), frameCount: frames.length }
  }
  return readSession
}
