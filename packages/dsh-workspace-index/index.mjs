import { constants, watch as nodeWatch } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import {
  embedTexts,
  chunkText,
  search,
  computeModelFingerprint,
  isValidVector,
  CHUNKER_VERSION,
  INDEX_DEFAULTS,
} from './embedding.mjs';

const protocol = await import('@deepseek-ai/dsh-typert-protocol').catch(error => {
  if (process.env.NODE_TEST_CONTEXT && error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});
const TYPERT = protocol ? (await import('./remote.mjs')).TYPERT : null;

/** Workspace semantic index for DeepSeek Harness.
 * Local Ollama embeddinggemma:300m (768-dim, l2-float32), syntax-aware chunking,
 * SHA-256 incremental indexing + deletion pruning, .gitignore/.kilocodeignore +
 * secret/symlink/containment safeguards, ctx.fs integration, file watching, and
 * atomic 0600 index publication.
 */
export const name = 'dsh-workspace-index';
export const inject = ['tools', 'typert'];
export const Config = Schema.object({
  provider: Schema.union(['ollama', 'openai-compatible']).default('ollama').description('Embedding provider protocol.'),
  baseURL: Schema.string().default('http://127.0.0.1:11434').description('Embedding server base URL (loopback Ollama or OpenAI-compatible endpoint).'),
  model: Schema.string().default('embeddinggemma:300m').description('Embedding model identifier.'),
  dimensions: Schema.number().default(768).description('Embedding vector dimensions.'),
  storageBackend: Schema.union(['jsonl']).default('jsonl').description('Local vector storage format.'),
  allowExternalEmbeddings: Schema.boolean().default(false).description('Permit sending workspace source text and searches to the configured external HTTPS endpoint.'),
  autoBuild: Schema.boolean().default(true).description('Automatically build the workspace index when a session opens.'),
  autoWatch: Schema.boolean().default(true).description('Watch workspace files for incremental updates.'),
  maxFiles: Schema.number().default(3000).description('Maximum files to index per workspace (1–20000).'),
});

const ALWAYS_IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.hg',
  '.svn',
  'dist',
  'build',
  '.next',
  '.cache',
  '.idea',
  '.gradle',
  'target',
  'coverage',
  '.turbo',
  '.dsh',
]);

const SECRET_DIR_NAMES = new Set([
  'secrets',
  '.secrets',
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
]);

const SECRET_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.pkcs12',
  '.jks',
  '.keystore',
  '.kdbx',
  '.asc',
  '.gpg',
  '.der',
  '.crt',
  '.cer',
  '.ovpn',
  '.tfstate',
]);

const SECRET_FILENAMES = new Set([
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'id_xmss',
  'authorized_keys',
  'known_hosts',
  'credentials',
  'credentials.json',
  'client_secret.json',
  'service-account.json',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.htpasswd',
  '.dockercfg',
  'master.key',
  'secrets.yml',
  'secrets.yaml',
  'secrets.json',
]);

const ALLOWED_ENV_SUFFIXES = ['.env.example', '.env.sample', '.env.template', '.env.dist'];

const TEXT_EXT =
  /\.(md|markdown|mdx|txt|py|pyi|js|mjs|cjs|ts|tsx|jsx|json|jsonc|yml|yaml|toml|ini|cfg|sh|bash|zsh|css|scss|html|htm|xml|sql|go|rs|java|kt|kts|c|h|cpp|hpp|cc|cxx|hh|rb|php|swift|m|mm|r|jl|tex|rst|csv|env\.example|env\.sample|env\.template)$/i;

const DEFAULT_INDEX_ROOT = join(homedir(), '.dsh', 'workspace-index');
const EMBED_BATCH = 24;
const MAX_FILES_CAP = 20000;
const DEFAULT_MAX_FILES = 3000;

const svc = (ctx, key) => {
  if (ctx == null) return undefined;
  if (typeof ctx.get === 'function') {
    try {
      const val = ctx.get(key);
      if (val !== undefined) return val;
    } catch { /* fall through */ }
  }
  return ctx[key];
};

function toPosix(p) {
  return p.split(sep).join('/');
}

function workspaceId(root) {
  return createHash('sha256').update(root).digest('hex').slice(0, 32);
}

function indexPathFor(indexRoot, root) {
  return join(indexRoot, `${workspaceId(root)}.jsonl`);
}

function isProbablyText(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

function hasPrivateKeyMaterial(text) {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text);
}

/** Check if a file or directory path is a secret/credential path that must never be indexed. */
export function isSecretFileOrDir(relPosixPath, entryName = basename(relPosixPath), isDirectory = false) {
  const lowerName = entryName.toLowerCase();
  const segments = relPosixPath.toLowerCase().split('/').filter(Boolean);

  for (const seg of segments) {
    if (SECRET_DIR_NAMES.has(seg)) return true;
  }
  if (isDirectory) {
    return SECRET_DIR_NAMES.has(lowerName);
  }

  // .env and .env.* handling: skip all except .env.example / .env.sample / .env.template / .env.dist
  if (lowerName === '.env' || lowerName.startsWith('.env.') || lowerName.endsWith('.env')) {
    if (ALLOWED_ENV_SUFFIXES.some(suffix => lowerName === suffix || lowerName.endsWith(suffix))) {
      return false;
    }
    return true;
  }

  if (SECRET_FILENAMES.has(lowerName)) return true;
  if (lowerName.endsWith('.tfstate.backup')) return true;

  const ext = extname(lowerName);
  if (ext && SECRET_EXTENSIONS.has(ext)) return true;
  if (/^id_(?:rsa|ed25519|ecdsa|dsa)(?:\..+)?$/.test(lowerName)) return true;

  return false;
}

/** Convert a single gitignore pattern into a RegExp. */
function gitignoreGlobToRegExp(pattern) {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) {
      re += '(?:.+/)?';
      i += 3;
      continue;
    }
    if (pattern.startsWith('/**', i) && i + 3 === pattern.length) {
      re += '(?:/.*)?';
      i += 3;
      continue;
    }
    if (pattern.startsWith('**', i)) {
      re += '.*';
      i += 2;
      continue;
    }
    const ch = pattern[i];
    if (ch === '*') {
      re += '[^/]*';
      i++;
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close !== -1) {
        let cls = pattern.slice(i + 1, close);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += '[' + cls.replace(/\\/g, '\\\\') + ']';
        i = close + 1;
      } else {
        re += '\\[';
        i++;
      }
    } else if (ch === '\\' && i + 1 < pattern.length) {
      re += pattern[i + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 2;
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

/** Parse a .gitignore or .kilocodeignore file content into rule descriptors scoped to baseRel. */
export function parseIgnoreFile(content, baseRel = '') {
  if (typeof content !== 'string' || !content) return [];
  const rules = [];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  for (const rawLine of lines) {
    let line = rawLine;
    // Strip trailing unescaped spaces
    line = line.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;

    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith('\\#') || line.startsWith('\\!')) {
      line = line.slice(1);
    }

    let dirOnly = false;
    if (line.endsWith('/') && !line.endsWith('\\/')) {
      dirOnly = true;
      line = line.replace(/\/+$/, '');
    }
    if (!line) continue;

    let anchored = false;
    if (line.startsWith('/')) {
      anchored = true;
      line = line.replace(/^\/+/, '');
    } else if (line.includes('/')) {
      anchored = true;
    }
    if (!line) continue;

    rules.push({
      baseRel: baseRel ? toPosix(baseRel).replace(/^\/+|\/+$/g, '') : '',
      negated,
      dirOnly,
      anchored,
      pattern: line,
      regex: gitignoreGlobToRegExp(line),
    });
  }
  return rules;
}

/** Match a relative POSIX path against a list of hierarchical ignore rules. */
export function createWorkspaceIgnoreMatcher(initialRules = []) {
  const rules = [...initialRules];
  return {
    rules,
    addRules(newRules) {
      return createWorkspaceIgnoreMatcher([...rules, ...newRules]);
    },
    isIgnored(relPosixPath, isDirectory = false) {
      const cleanPath = relPosixPath.replace(/^\/+|\/+$/g, '');
      if (!cleanPath) return false;
      const entryName = basename(cleanPath);

      // Security & built-in safeguards always take precedence and cannot be negated.
      if (isSecretFileOrDir(cleanPath, entryName, isDirectory)) return true;
      const parts = cleanPath.split('/');
      for (let idx = 0; idx < parts.length; idx++) {
        const seg = parts[idx];
        const segIsDir = idx < parts.length - 1 || isDirectory;
        if (segIsDir && ALWAYS_IGNORE_DIRS.has(seg)) return true;
      }

      let ignored = false;
      for (const rule of rules) {
        let subPath = cleanPath;
        if (rule.baseRel) {
          if (cleanPath === rule.baseRel || !cleanPath.startsWith(rule.baseRel + '/')) {
            continue;
          }
          subPath = cleanPath.slice(rule.baseRel.length + 1);
        }
        if (rule.dirOnly && !isDirectory) continue;

        let matched = false;
        if (rule.anchored) {
          matched = rule.regex.test(subPath);
        } else {
          if (rule.regex.test(subPath) || rule.regex.test(basename(subPath))) {
            matched = true;
          } else {
            const subParts = subPath.split('/');
            matched = subParts.some(seg => rule.regex.test(seg));
          }
        }
        if (matched) {
          ignored = !rule.negated;
        }
      }
      return ignored;
    },
  };
}

function isContainedInRoot(realRoot, candidateRealPath) {
  if (candidateRealPath === realRoot) return true;
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return candidateRealPath.startsWith(prefix);
}

/** Build a filesystem reader that uses DSH ctx.fs when available and falls back to node:fs/promises. */
async function createWorkspaceFs(ctx, realRoot, signal) {
  const fsSvc = svc(ctx, 'fs');
  let rootTarget = null;
  if (fsSvc && typeof fsSvc.resolve === 'function') {
    try {
      rootTarget = await fsSvc.resolve(realRoot, { cwd: realRoot, signal });
    } catch {
      rootTarget = null;
    }
  }

  async function inspectEntry(absPath) {
    // Always verify with lstat first so symlinks are rejected before following.
    if (fsSvc && typeof fsSvc.lstat === 'function') {
      try {
        const info = await fsSvc.lstat(absPath, { cwd: realRoot }, signal);
        if (!info) return null;
        if (info.type === 'symlink') return { type: 'symlink', size: 0 };
      } catch {
        return null;
      }
    }
    let st;
    try {
      st = await lstat(absPath);
    } catch {
      return null;
    }
    if (st.isSymbolicLink()) return { type: 'symlink', size: 0 };

    // Enforce workspace containment on the resolved realpath.
    let resolvedReal;
    try {
      resolvedReal = await realpath(absPath);
    } catch {
      return null;
    }
    if (!isContainedInRoot(realRoot, resolvedReal)) {
      return { type: 'outside-root', size: 0 };
    }
    if (fsSvc && rootTarget && typeof fsSvc.resolve === 'function' && typeof fsSvc.contains === 'function') {
      try {
        const target = await fsSvc.resolve(absPath, { cwd: realRoot, signal });
        if (!fsSvc.contains(rootTarget, target)) {
          return { type: 'outside-root', size: 0 };
        }
      } catch {
        return null;
      }
    }

    if (st.isDirectory()) return { type: 'directory', size: st.size };
    if (st.isFile()) return { type: 'file', size: st.size };
    return { type: 'other', size: 0 };
  }

  async function listDirEntries(dirAbs) {
    if (fsSvc && typeof fsSvc.resolve === 'function' && typeof fsSvc.listDir === 'function') {
      try {
        const dirTarget = await fsSvc.resolve(dirAbs, { cwd: realRoot, signal });
        if (rootTarget && typeof fsSvc.contains === 'function' && !fsSvc.contains(rootTarget, dirTarget)) {
          return [];
        }
        const listed = await fsSvc.listDir(dirTarget, signal);
        return listed.map(e => e.name).sort((a, b) => a.localeCompare(b));
      } catch (err) {
        if (err?.code === 'FS_SANDBOX_DENIED' || err?.code === 'FS_PERMISSION_DENIED') return [];
        /* fall through to node readdir if mock ctx.fs only implements partial contract */
      }
    }
    try {
      const entries = await readdir(dirAbs, { withFileTypes: true });
      return entries.map(e => e.name).sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  async function readFileBytesBounded(fileAbs, maxBytes) {
    if (fsSvc && typeof fsSvc.resolve === 'function' && typeof fsSvc.readBytes === 'function') {
      try {
        const target = await fsSvc.resolve(fileAbs, { cwd: realRoot, signal });
        if (rootTarget && typeof fsSvc.contains === 'function' && !fsSvc.contains(rootTarget, target)) {
          return null;
        }
        const bytes = await fsSvc.readBytes(target, signal, maxBytes);
        return Buffer.from(bytes);
      } catch (err) {
        if (
          err?.code === 'FS_SANDBOX_DENIED' ||
          err?.code === 'FS_PERMISSION_DENIED' ||
          err?.code === 'FS_TOO_LARGE' ||
          err?.code === 'FS_NOT_FOUND'
        ) {
          return null;
        }
        /* fall back if partial mock */
      }
    }
    if (fsSvc && typeof fsSvc.resolve === 'function' && typeof fsSvc.readText === 'function') {
      try {
        const target = await fsSvc.resolve(fileAbs, { cwd: realRoot, signal });
        const text = await fsSvc.readText(target, signal);
        const buf = Buffer.from(typeof text === 'string' ? text : text?.content ?? '', 'utf8');
        if (buf.length > maxBytes) return null;
        return buf;
      } catch (err) {
        if (
          err?.code === 'FS_SANDBOX_DENIED' ||
          err?.code === 'FS_PERMISSION_DENIED' ||
          err?.code === 'FS_NOT_TEXT' ||
          err?.code === 'FS_NOT_FOUND'
        ) {
          return null;
        }
      }
    }
    try {
      const buf = await readFile(fileAbs);
      if (buf.length > maxBytes) return null;
      return buf;
    } catch {
      return null;
    }
  }

  return { inspectEntry, listDirEntries, readFileBytesBounded, fsSvc, rootTarget };
}

function isAllowedTextFileName(entryName) {
  const lower = entryName.toLowerCase();
  if (ALLOWED_ENV_SUFFIXES.some(suffix => lower === suffix || lower.endsWith(suffix))) {
    return true;
  }
  if (entryName.startsWith('.')) return false;
  return TEXT_EXT.test(entryName);
}

async function loadDirectoryIgnoreRules(wsFs, dirAbs, dirRel, maxIgnoreBytes = 64 * 1024) {
  const rules = [];
  for (const ignoreFile of ['.gitignore', '.kilocodeignore']) {
    const abs = join(dirAbs, ignoreFile);
    const info = await wsFs.inspectEntry(abs);
    if (!info || info.type !== 'file' || info.size === 0 || info.size > maxIgnoreBytes) continue;
    const buf = await wsFs.readFileBytesBounded(abs, maxIgnoreBytes);
    if (!buf || !isProbablyText(buf)) continue;
    rules.push(...parseIgnoreFile(buf.toString('utf8'), dirRel));
  }
  return rules;
}

async function walkWorkspaceFiles(ctx, realRoot, { maxFiles, maxFileBytes, signal }) {
  const wsFs = await createWorkspaceFs(ctx, realRoot, signal);
  const out = [];
  const rootRules = await loadDirectoryIgnoreRules(wsFs, realRoot, '');
  const rootMatcher = createWorkspaceIgnoreMatcher(rootRules);

  async function walk(dirAbs, dirRel, matcher) {
    if (out.length >= maxFiles || signal?.aborted) return;
    const names = await wsFs.listDirEntries(dirAbs);
    for (const entryName of names) {
      if (out.length >= maxFiles || signal?.aborted) return;
      if (entryName === '.gitignore' || entryName === '.kilocodeignore') continue;

      const fullAbs = join(dirAbs, entryName);
      const relPosix = dirRel ? `${dirRel}/${entryName}` : entryName;
      const info = await wsFs.inspectEntry(fullAbs);
      if (!info || info.type === 'symlink' || info.type === 'outside-root' || info.type === 'other') {
        continue;
      }

      if (info.type === 'directory') {
        if (entryName.startsWith('.') || ALWAYS_IGNORE_DIRS.has(entryName)) continue;
        if (matcher.isIgnored(relPosix, true)) continue;
        const childRules = await loadDirectoryIgnoreRules(wsFs, fullAbs, relPosix);
        const childMatcher = childRules.length > 0 ? matcher.addRules(childRules) : matcher;
        await walk(fullAbs, relPosix, childMatcher);
      } else if (info.type === 'file') {
        if (matcher.isIgnored(relPosix, false)) continue;
        if (!isAllowedTextFileName(entryName)) continue;
        if (info.size === 0 || info.size > maxFileBytes) continue;
        out.push({ abs: fullAbs, rel: relPosix, size: info.size });
      }
    }
  }

  await walk(realRoot, '', rootMatcher);
  return { files: out, wsFs, rootMatcher };
}

async function loadIndexState(indexPath, root) {
  let raw;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(indexPath));
  } catch (err) {
    if (err?.code === 'ENOENT') return { header: null, entries: [], byPath: new Map() };
    return { error: err instanceof TypeError ? 'corrupt-index' : 'index-unreadable' };
  }
  try {
    if (!raw.endsWith('\n')) throw new Error('incomplete index');
    const lines = raw.slice(0, -1).split('\n');
    const header = JSON.parse(lines[0]);
    const count = n => Number.isSafeInteger(n) && n >= 0;
    const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    if (!header || header.type !== 'header' || header.version !== 2 || header.root !== root ||
        typeof header.model !== 'string' || !header.model || !Number.isSafeInteger(header.dimensions) || header.dimensions < 1 ||
        typeof header.normalization !== 'string' || !header.normalization ||
        header.modelFingerprint !== computeModelFingerprint(header) ||
        typeof header.chunkerVersion !== 'string' || !header.chunkerVersion ||
        typeof header.indexedAt !== 'string' || !Number.isFinite(Date.parse(header.indexedAt)) ||
        !count(header.fileCount) || !count(header.chunkCount) || !header.files ||
        typeof header.files !== 'object' || Array.isArray(header.files) ||
        Object.keys(header.files).length !== header.fileCount || lines.length - 1 !== header.chunkCount) throw new Error('bad header');
    const entries = [];
    const byPath = new Map();
    for (const [path, meta] of Object.entries(header.files)) {
      if (!path || isAbsolute(path) || path.split('/').some(part => !part || part === '.' || part === '..') ||
          !meta || !sha(meta.sha256) || !count(meta.chunks)) throw new Error('bad manifest');
    }
    for (const line of lines.slice(1)) {
      const o = JSON.parse(line);
      const meta = o && header.files[o.p];
      if (!o || o.type !== 'chunk' || typeof o.p !== 'string' || !meta ||
          !Number.isSafeInteger(o.sl) || o.sl < 1 || !Number.isSafeInteger(o.el) || o.el < o.sl ||
          typeof o.k !== 'string' || !o.k || o.h !== meta.sha256 || o.mf !== header.modelFingerprint ||
          o.cv !== header.chunkerVersion || !isValidVector(o.v, header.dimensions)) throw new Error('bad chunk');
      const norm = Math.sqrt(o.v.reduce((sum, value) => sum + value * value, 0));
      if (!Number.isFinite(norm) || Math.abs(norm - 1) > 0.0001) throw new Error('bad vector');
      const entry = { path: o.p, startLine: o.sl, endLine: o.el, kind: o.k, sha256: o.h,
        modelFingerprint: o.mf, chunkerVersion: o.cv, vector: o.v };
      entries.push(entry);
      if (!byPath.has(o.p)) byPath.set(o.p, []);
      byPath.get(o.p).push(entry);
    }
    for (const [path, meta] of Object.entries(header.files)) {
      if ((byPath.get(path)?.length ?? 0) !== meta.chunks) throw new Error('bad chunk count');
    }
    return { header, entries, byPath };
  } catch {
    return { error: 'corrupt-index' };
  }
}

/** Write index JSONL to a 0600 temp file, fsync, and atomically rename into place. */
async function writeIndexAtomic(indexPath, header, records, signal) {
  const dir = dirname(indexPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${indexPath}.tmp.${process.pid}.${Date.now()}.${randomUUID().slice(0, 8)}`;
  const handle = await open(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    const lines = [];
    if (header) lines.push(JSON.stringify(header));
    for (const r of records) lines.push(JSON.stringify(r));
    const payload = lines.length > 0 ? lines.join('\n') + '\n' : '';
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } catch (err) {
    try { await handle.close(); } catch { /* ignore */ }
    try { await rm(tmpPath, { force: true }); } catch { /* ignore */ }
    throw err;
  }
  await handle.close();
  try {
    await chmod(tmpPath, 0o600);
    if (signal?.aborted) {
      await rm(tmpPath, { force: true });
      return false;
    }
    await rename(tmpPath, indexPath);
  } catch (err) {
    try { await rm(tmpPath, { force: true }); } catch { /* ignore */ }
    throw err;
  }
  return true;
}

function resolveRoot(args, exec, ctx) {
  if (typeof args?.root === 'string' && args.root.trim()) return args.root.trim();
  try {
    const session = exec?.agent?.session;
    const wd = svc(ctx, 'workingDirectory');
    if (session && wd) {
      const cwd = wd.get?.(session);
      if (typeof cwd === 'string' && cwd) return cwd;
    }
    const headerCwd = session?.header?.cwd;
    if (typeof headerCwd === 'string' && headerCwd.trim()) return headerCwd.trim();
  } catch { /* fall through */ }
  return null;
}

function validateMaxFilesArg(val) {
  if (val === undefined) return { ok: true, value: undefined };
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 1 || val > MAX_FILES_CAP) {
    return {
      ok: false,
      error: {
        status: 'error',
        reason: 'invalid-max-files',
        detail: `maxFiles must be an integer between 1 and ${MAX_FILES_CAP}`,
      },
    };
  }
  return { ok: true, value: val };
}

function decodeUtf8Fatal(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

export function apply(ctx, config = {}) {
  const cfg = config && typeof config === 'object' ? config : {};
  const baseURL = typeof cfg.baseURL === 'string' && cfg.baseURL ? cfg.baseURL : INDEX_DEFAULTS.baseURL;
  const provider = cfg.provider === 'openai-compatible' ? 'openai-compatible' : 'ollama';
  const embeddingBaseURL = provider === 'ollama' && /^https?:\/\/[^/]+\/?$/.test(baseURL)
    ? `${baseURL.replace(/\/+$/, '')}/v1` : baseURL;
  const endpoint = URL.canParse(embeddingBaseURL) ? new URL(embeddingBaseURL) : null;
  const loopback = endpoint && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname);
  const endpointError = !endpoint || !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    ? 'invalid-embedding-endpoint'
    : !loopback && cfg.allowExternalEmbeddings !== true
      ? 'external-embeddings-disabled'
      : !loopback && endpoint.protocol !== 'https:' ? 'external-embeddings-require-https' : null;
  const storageBackend = 'jsonl';
  const model = typeof cfg.model === 'string' && cfg.model ? cfg.model : INDEX_DEFAULTS.model;
  const dimensions =
    Number.isInteger(cfg.dimensions) && cfg.dimensions > 0 ? cfg.dimensions : INDEX_DEFAULTS.dimensions;
  const indexRoot = typeof cfg.indexRoot === 'string' && cfg.indexRoot ? cfg.indexRoot : DEFAULT_INDEX_ROOT;
  const maxFileBytes =
    Number.isFinite(cfg.maxFileBytes) && cfg.maxFileBytes > 0 ? Math.floor(cfg.maxFileBytes) : 256 * 1024;
  const defaultMaxFiles =
    Number.isInteger(cfg.maxFiles) && cfg.maxFiles >= 1
      ? Math.min(cfg.maxFiles, MAX_FILES_CAP)
      : DEFAULT_MAX_FILES;
  const chunkChars =
    Number.isFinite(cfg.chunkChars) && cfg.chunkChars >= 100 ? Math.floor(cfg.chunkChars) : 1600;
  const autoWatch = cfg.autoWatch !== undefined ? cfg.autoWatch !== false : cfg.watch !== false;
  const autoBuild = !endpointError && cfg.autoBuild !== false;
  const fetchImpl = typeof cfg.fetch === 'function' ? cfg.fetch : globalThis.fetch;
  const currentModelFingerprint = computeModelFingerprint({
    model,
    dimensions,
    normalization: INDEX_DEFAULTS.normalization,
  });

  // Per-root watch + dirty tracking state.
  const watcherStates = new Map();
  const builds = new Map();
  const buildErrors = new Map();
  const rebuilds = new Map();
  const automaticBuilds = new Map();
  let disposed = false;

  function runAutomaticRebuild(root) {
    if (disposed) return;
    const controller = new AbortController();
    automaticBuilds.set(root, controller);
    void buildIndex({ action: 'build', watch: true, root }, { signal: controller.signal })
      .catch(() => {})
      .finally(() => { if (automaticBuilds.get(root) === controller) automaticBuilds.delete(root); });
  }

  function scheduleRebuild(root, reset = true) {
    if (!autoBuild || !autoWatch || disposed || watcherStates.get(root)?.autoPaused) return;
    let pending = rebuilds.get(root);
    if (!pending) {
      pending = { timer: null, queued: false };
      rebuilds.set(root, pending);
    }
    if (!reset && (pending.timer || pending.queued)) return;
    if (builds.has(root)) pending.queued = true;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      pending.timer = null;
      if (builds.has(root)) {
        pending.queued = true;
        return;
      }
      pending.queued = false;
      runAutomaticRebuild(root);
    }, 1500);
    pending.timer.unref?.();
  }

  function markDirty(realRoot, relPath = '.') {
    let state = watcherStates.get(realRoot);
    if (!state) {
      state = {
        dirty: false,
        dirtyPaths: new Set(),
        dirtySince: null,
        watching: false,
        closeFns: [],
        matcher: createWorkspaceIgnoreMatcher(),
      };
      watcherStates.set(realRoot, state);
    }
    const cleanRel = toPosix(String(relPath || '.')).replace(/^\/+|\/+$/g, '');
    if (cleanRel && cleanRel !== '.') {
      if (state.matcher?.isIgnored(cleanRel, false) || state.matcher?.isIgnored(cleanRel, true)) {
        return;
      }
      state.dirtyPaths.add(cleanRel);
    }
    state.dirty = true;
    state.changeVersion = (state.changeVersion ?? 0) + 1;
    if (!state.dirtySince) state.dirtySince = new Date().toISOString();
    if (state.watching) scheduleRebuild(realRoot);
  }

  async function stopWatcher(realRoot) {
    automaticBuilds.get(realRoot)?.abort();
    const pending = rebuilds.get(realRoot);
    if (pending) clearTimeout(pending.timer);
    rebuilds.delete(realRoot);
    const state = watcherStates.get(realRoot);
    if (!state) return;
    state.autoPaused = true;
    state.watching = false;
    state.recursive = false;
    state.watchError = null;
    state.driftCheckedAt = 0;
    const fns = state.closeFns.splice(0, state.closeFns.length);
    for (const close of fns) {
      try {
        await close();
      } catch { /* ignore */ }
    }
  }

  async function startWatcher(realRoot, matcher) {
    let state = watcherStates.get(realRoot);
    if (!state) {
      state = {
        dirty: false,
        dirtyPaths: new Set(),
        dirtySince: null,
        watching: false,
        closeFns: [],
        matcher: matcher || createWorkspaceIgnoreMatcher(),
      };
      watcherStates.set(realRoot, state);
    } else if (matcher) {
      state.matcher = matcher;
    }

    state.autoPaused = false;
    if (state.watching) return state;

    const closeFns = [];
    const fsSvc = svc(ctx, 'fs');
    if (fsSvc && typeof fsSvc.watch === 'function' && typeof fsSvc.resolve === 'function') {
      try {
        const ac = new AbortController();
        const target = await fsSvc.resolve(realRoot, { cwd: realRoot, signal: ac.signal });
        const closeCtxWatch = await fsSvc.watch(
          target,
          err => {
            if (err) state.watchError = err;
            else markDirty(realRoot, '.');
          },
          ac.signal,
        );
        closeFns.push(async () => {
          ac.abort();
          if (typeof closeCtxWatch === 'function') await closeCtxWatch();
        });
      } catch (err) {
        state.watchError = err;
      }
    }

    try {
      let watcher;
      try {
        watcher = nodeWatch(realRoot, { recursive: true, persistent: false }, (_event, filename) => {
          if (filename) markDirty(realRoot, String(filename));
          else markDirty(realRoot, '.');
        });
        state.recursive = true;
      } catch {
        state.recursive = false;
        watcher = nodeWatch(realRoot, { persistent: false }, (_event, filename) => {
          if (filename) markDirty(realRoot, String(filename));
          else markDirty(realRoot, '.');
        });
      }
      watcher.on('error', err => { state.watchError = err; });
      closeFns.push(async () => {
        try {
          watcher.close();
        } catch { /* ignore */ }
      });
    } catch (err) {
      state.watchError = err;
    }

    state.closeFns = closeFns;
    state.watching = closeFns.length > 0;
    return state;
  }

  /** Detect workspace drift against the stored index manifest (handles edits even before OS watch events arrive). */
  async function detectFilesystemDrift(realRoot, header, maxFilesCap, signal) {
    if (!header || !header.files || typeof header.files !== 'object') {
      return { drifted: true, changedPaths: [] };
    }
    const { files, wsFs } = await walkWorkspaceFiles(ctx, realRoot, {
      maxFiles: maxFilesCap,
      maxFileBytes,
      signal,
    });
    const manifest = header.files;
    const manifestKeys = Object.keys(manifest);
    const changedPaths = [];
    const seen = new Set();

    for (const f of files) {
      seen.add(f.rel);
      const prevMeta = manifest[f.rel];
      if (!prevMeta) {
        changedPaths.push(f.rel);
        continue;
      }
      const buf = await wsFs.readFileBytesBounded(f.abs, maxFileBytes);
      if (!buf) {
        changedPaths.push(f.rel);
        continue;
      }
      const sha256 = createHash('sha256').update(buf).digest('hex');
      if (sha256 !== prevMeta.sha256) {
        changedPaths.push(f.rel);
      }
    }
    for (const oldPath of manifestKeys) {
      if (!seen.has(oldPath)) {
        changedPaths.push(oldPath);
      }
    }
    return { drifted: changedPaths.length > 0, changedPaths };
  }

  async function resolveRealWorkspaceRoot(args, exec) {
    const root = resolveRoot(args, exec, ctx);
    if (!root) {
      return {
        ok: false,
        error: {
          status: 'error',
          reason: 'no-root',
          detail: 'pass root or run inside a session with a working directory',
        },
      };
    }
    if (!isAbsolute(root)) {
      return {
        ok: false,
        error: {
          status: 'error',
          reason: 'invalid-root',
          detail: 'root must be an absolute path',
        },
      };
    }
    let st;
    try {
      st = await lstat(root);
    } catch {
      return { ok: false, error: { status: 'error', reason: 'root-missing' } };
    }
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        error: { status: 'error', reason: 'symlink-root-rejected', detail: 'workspace root cannot be a symlink' },
      };
    }
    if (!st.isDirectory()) {
      return {
        ok: false,
        error: { status: 'error', reason: 'root-not-directory' },
      };
    }
    let realRoot;
    try {
      realRoot = await realpath(root);
    } catch {
      return { ok: false, error: { status: 'error', reason: 'root-missing' } };
    }
    return { ok: true, realRoot };
  }

  async function getIndexStatus(args, exec) {
    if (endpointError) return { status: 'error', reason: endpointError };
    const resolved = await resolveRealWorkspaceRoot(args, exec);
    if (!resolved.ok) return resolved.error;
    const { realRoot } = resolved;
    const indexPath = indexPathFor(indexRoot, realRoot);
    const loaded = await loadIndexState(indexPath, realRoot);
    if (loaded.error) return { status: 'error', reason: loaded.error, action: 'rebuild', root: realRoot };
    const { header, entries, byPath } = loaded;
    const wState = watcherStates.get(realRoot);

    if (!header && entries.length === 0) {
      return {
        status: 'ok',
        root: realRoot,
        indexed: false,
        indexPath,
        files: 0,
        chunks: 0,
        stale: true,
        dirty: Boolean(wState?.dirty),
        dirtyPaths: wState ? [...wState.dirtyPaths].slice(0, 50) : [],
        fingerprintMismatch: false,
        watching: Boolean(wState?.watching),
        recursive: Boolean(wState?.recursive),
        watchError: wState?.watchError ? String(wState.watchError.message ?? wState.watchError) : null,
        lastIndexedAt: null,
        model,
        dimensions,
        modelFingerprint: currentModelFingerprint,
        chunkerVersion: CHUNKER_VERSION,
      };
    }

    const storedFingerprint = header?.modelFingerprint ?? entries[0]?.modelFingerprint ?? null;
    const storedChunker = header?.chunkerVersion ?? entries[0]?.chunkerVersion ?? null;
    const fingerprintMismatch =
      storedFingerprint !== currentModelFingerprint || storedChunker !== CHUNKER_VERSION;

    let isDirty = Boolean(wState?.dirty);
    let dirtyPaths = wState ? [...wState.dirtyPaths] : [];

    if (!isDirty && header?.files && (!wState?.watching || !wState.driftCheckedAt || Date.now() - wState.driftCheckedAt >= 30000)) {
      const drift = await detectFilesystemDrift(realRoot, header, defaultMaxFiles, exec?.signal);
      if (wState) wState.driftCheckedAt = Date.now();
      if (drift.drifted) {
        isDirty = true;
        dirtyPaths = drift.changedPaths;
        for (const p of drift.changedPaths) markDirty(realRoot, p);
      }
    }

    const fileCount = Number.isInteger(header?.fileCount) ? header.fileCount : byPath.size;
    const chunkCount = entries.length;

    return {
      status: 'ok',
      root: realRoot,
      indexed: true,
      indexPath,
      files: fileCount,
      chunks: chunkCount,
      stale: isDirty || fingerprintMismatch,
      dirty: isDirty,
      dirtyPaths: dirtyPaths.slice(0, 50),
      fingerprintMismatch,
      watching: Boolean(wState?.watching),
      recursive: Boolean(wState?.recursive),
      watchError: wState?.watchError ? String(wState.watchError.message ?? wState.watchError) : null,
      lastIndexedAt: header?.indexedAt ?? null,
      model: header?.model ?? model,
      dimensions: header?.dimensions ?? dimensions,
      modelFingerprint: storedFingerprint ?? currentModelFingerprint,
      expectedModelFingerprint: currentModelFingerprint,
      chunkerVersion: storedChunker ?? CHUNKER_VERSION,
    };
  }

  async function performIndexAction(args, exec, progress) {
    const action = typeof args?.action === 'string' ? args.action : 'build';
    if (endpointError && action !== 'unwatch') return { status: 'error', reason: endpointError };
    if (action === 'status') {
      return getIndexStatus(args, exec);
    }
    if (storageBackend !== 'jsonl') return { status: 'error', reason: 'unsupported-storage-backend' };
    const maxCheck = validateMaxFilesArg(args?.maxFiles);
    if (!maxCheck.ok) return maxCheck.error;
    const effectiveMaxFiles = maxCheck.value ?? defaultMaxFiles;

    const resolved = await resolveRealWorkspaceRoot(args, exec);
    if (!resolved.ok) return resolved.error;
    const { realRoot } = resolved;

    if (action === 'unwatch') {
      await stopWatcher(realRoot);
      return { status: 'ok', action: 'unwatch', root: realRoot, watching: false };
    }
    if (action === 'watch') {
      const { rootMatcher } = await walkWorkspaceFiles(ctx, realRoot, {
        maxFiles: 1,
        maxFileBytes,
        signal: exec?.signal,
      });
      const st = await startWatcher(realRoot, rootMatcher);
      return { status: 'ok', action: 'watch', root: realRoot, watching: Boolean(st?.watching) };
    }

    const buildVersion = watcherStates.get(realRoot)?.changeVersion ?? 0;

    const indexPath = indexPathFor(indexRoot, realRoot);
    const loaded = await loadIndexState(indexPath, realRoot);
    if (loaded.error && loaded.error !== 'corrupt-index') return { status: 'error', reason: loaded.error, root: realRoot };
    const prev = loaded.error ? { header: null, entries: [], byPath: new Map() } : loaded;
    if (exec?.signal?.aborted) return { status: 'error', reason: 'canceled', indexed: 0 };
    const { files, wsFs, rootMatcher } = await walkWorkspaceFiles(ctx, realRoot, {
      maxFiles: effectiveMaxFiles,
      maxFileBytes,
      signal: exec?.signal,
    });
    if (progress) progress.totalFiles = files.length;
    if (exec?.signal?.aborted) return { status: 'error', reason: 'canceled', indexed: 0 };

    const seenPaths = new Set();
    const fileManifest = {};
    const reusedRecordsByFile = new Map();
    const pendingChunks = [];

    let reusedFiles = 0;
    let reusedChunks = 0;
    let embeddedFiles = 0;
    let embeddedChunks = 0;

    for (const f of files) {
      if (progress) progress.processedFiles++;
      if (exec?.signal?.aborted) {
        return { status: 'error', reason: 'canceled', indexed: 0 };
      }
      const buf = await wsFs.readFileBytesBounded(f.abs, maxFileBytes);
      if (!buf || !isProbablyText(buf)) continue;
      const text = decodeUtf8Fatal(buf);
      if (text === null || hasPrivateKeyMaterial(text)) continue;

      const sha256 = createHash('sha256').update(buf).digest('hex');
      seenPaths.add(f.rel);

      const prevEntries = prev.byPath.get(f.rel);
      const prevFileMeta = prev.header?.files?.[f.rel];
      const headerFingerprintMatches =
        prev.header?.modelFingerprint === currentModelFingerprint &&
        prev.header?.chunkerVersion === CHUNKER_VERSION;

      const canReuseNonEmpty =
        Array.isArray(prevEntries) &&
        prevEntries.length > 0 &&
        prevEntries.every(
          e =>
            e.sha256 === sha256 &&
            e.modelFingerprint === currentModelFingerprint &&
            e.chunkerVersion === CHUNKER_VERSION &&
            isValidVector(e.vector, dimensions),
        );

      const canReuseEmpty =
        (!prevEntries || prevEntries.length === 0) &&
        headerFingerprintMatches &&
        prevFileMeta &&
        prevFileMeta.sha256 === sha256 &&
        prevFileMeta.chunks === 0;

      if (canReuseNonEmpty || canReuseEmpty) {
        const records = (prevEntries || []).map(e => ({
          type: 'chunk',
          p: e.path,
          sl: e.startLine,
          el: e.endLine,
          k: e.kind,
          h: sha256,
          mf: currentModelFingerprint,
          cv: CHUNKER_VERSION,
          v: e.vector,
        }));
        reusedRecordsByFile.set(f.rel, records);
        fileManifest[f.rel] = { sha256, chunks: records.length };
        reusedFiles++;
        reusedChunks += records.length;
        continue;
      }

      const fileChunks = chunkText(text, chunkChars, { filePath: f.rel, maxBytes: chunkChars });
      fileManifest[f.rel] = { sha256, chunks: fileChunks.length };
      embeddedFiles++;
      for (const c of fileChunks) {
        pendingChunks.push({
          rel: f.rel,
          sha256,
          startLine: c.startLine,
          endLine: c.endLine,
          kind: c.kind,
          text: c.text,
        });
      }
    }

    // Compute pruned files count from previous index state.
    const prevKnownPaths = new Set([
      ...prev.byPath.keys(),
      ...Object.keys(prev.header?.files && typeof prev.header.files === 'object' ? prev.header.files : {}),
    ]);
    let prunedFiles = 0;
    for (const oldPath of prevKnownPaths) {
      if (!seenPaths.has(oldPath)) prunedFiles++;
    }

    const newRecordsByFile = new Map();
    if (progress) progress.totalChunks = pendingChunks.length;
    for (let i = 0; i < pendingChunks.length; i += EMBED_BATCH) {
      if (exec?.signal?.aborted) {
        return { status: 'error', reason: 'canceled', indexed: embeddedChunks };
      }
      const batch = pendingChunks.slice(i, i + EMBED_BATCH);
      const vectors = await embedTexts(
        batch.map(c => c.text),
        { baseURL: embeddingBaseURL, model, dimensions, fetchImpl, signal: exec?.signal },
      );
      for (let j = 0; j < batch.length; j++) {
        const c = batch[j];
        const rec = {
          type: 'chunk',
          p: c.rel,
          sl: c.startLine,
          el: c.endLine,
          k: c.kind,
          h: c.sha256,
          mf: currentModelFingerprint,
          cv: CHUNKER_VERSION,
          v: vectors[j],
        };
        let list = newRecordsByFile.get(c.rel);
        if (!list) {
          list = [];
          newRecordsByFile.set(c.rel, list);
        }
        list.push(rec);
        embeddedChunks++;
        if (progress) progress.embeddedChunks = embeddedChunks;
      }
    }

    const finalRecords = [];
    for (const rel of [...seenPaths].sort((a, b) => a.localeCompare(b))) {
      const recs = reusedRecordsByFile.get(rel) ?? newRecordsByFile.get(rel) ?? [];
      finalRecords.push(...recs);
    }

    const indexedAt = new Date().toISOString();
    const header = {
      type: 'header',
      version: 2,
      root: realRoot,
      model,
      baseURL,
      dimensions,
      normalization: INDEX_DEFAULTS.normalization,
      modelFingerprint: currentModelFingerprint,
      chunkerVersion: CHUNKER_VERSION,
      indexedAt,
      fileCount: seenPaths.size,
      chunkCount: finalRecords.length,
      files: fileManifest,
    };

    if (exec?.signal?.aborted) return { status: 'error', reason: 'canceled', indexed: embeddedChunks };
    if (finalRecords.length > 0 || prevKnownPaths.size > 0 || loaded.error === 'corrupt-index') {
      if (!await writeIndexAtomic(indexPath, header, finalRecords, exec?.signal)) {
        return { status: 'error', reason: 'canceled', indexed: embeddedChunks };
      }
    }

    if (exec?.signal?.aborted) return { status: 'error', reason: 'canceled', indexed: embeddedChunks };
    const shouldWatch = args?.watch !== undefined ? Boolean(args.watch) : autoWatch;
    if (shouldWatch) {
      const st = await startWatcher(realRoot, rootMatcher);
      if ((st.changeVersion ?? 0) === buildVersion) {
        st.dirty = false;
        st.dirtyPaths.clear();
        st.dirtySince = null;
      }
      st.driftCheckedAt = 0;
    } else {
      const st = watcherStates.get(realRoot);
      if (st) {
        if ((st.changeVersion ?? 0) === buildVersion) {
          st.dirty = false;
          st.dirtyPaths.clear();
          st.dirtySince = null;
        }
        st.driftCheckedAt = 0;
      }
    }

    if (finalRecords.length === 0) {
      return {
        status: 'ok',
        root: realRoot,
        files: seenPaths.size,
        chunks: 0,
        indexed: 0,
        reusedFiles,
        reusedChunks,
        embeddedFiles,
        embeddedChunks,
        prunedFiles,
        model,
        dimensions,
        modelFingerprint: currentModelFingerprint,
        chunkerVersion: CHUNKER_VERSION,
        indexedAt,
        stale: false,
        note: 'no indexable text',
      };
    }

    return {
      status: 'ok',
      root: realRoot,
      files: seenPaths.size,
      chunks: finalRecords.length,
      indexed: finalRecords.length,
      reusedFiles,
      reusedChunks,
      embeddedFiles,
      embeddedChunks,
      prunedFiles,
      indexPath,
      model,
      dimensions,
      modelFingerprint: currentModelFingerprint,
      chunkerVersion: CHUNKER_VERSION,
      indexedAt,
      stale: false,
      watching: Boolean(watcherStates.get(realRoot)?.watching),
    };
  }

  async function buildIndex(args, exec) {
    const action = args?.action ?? 'build';
    if (endpointError || action !== 'build') return performIndexAction(args, exec);
    const resolved = await resolveRealWorkspaceRoot(args, exec);
    if (!resolved.ok) return resolved.error;
    const root = resolved.realRoot;
    if (builds.has(root)) {
      const result = await builds.get(root).promise;
      if (result.status === 'ok' && args?.watch === true && !watcherStates.get(root)?.watching) {
        await performIndexAction({ ...args, action: 'watch' }, exec);
      }
      return result;
    }
    const progress = { processedFiles: 0, totalFiles: 0, embeddedChunks: 0, totalChunks: 0 };
    buildErrors.delete(root);
    const promise = performIndexAction(args, exec, progress).then(result => {
      if (result.status !== 'ok' && result.reason !== 'canceled') buildErrors.set(root, result.reason);
      return result;
    }).catch(error => {
      buildErrors.set(root, 'build-failed');
      throw error;
    }).finally(() => {
      builds.delete(root);
      const pending = rebuilds.get(root);
      if (!pending) return;
      if (buildErrors.has(root)) {
        clearTimeout(pending.timer);
        rebuilds.delete(root);
      } else if (pending.queued && !pending.timer && !disposed) {
        pending.queued = false;
        runAutomaticRebuild(root);
      }
    });
    builds.set(root, { progress, promise });
    return promise;
  }

  async function searchIndex(args, exec) {
    if (endpointError) return { status: 'error', reason: endpointError };
    if (storageBackend !== 'jsonl') return { status: 'error', reason: 'unsupported-storage-backend' };
    if (typeof args?.query !== 'string' || !args.query.trim()) {
      return { status: 'error', reason: 'empty-query' };
    }
    const topK = Number.isInteger(args.topK) && args.topK >= 1 && args.topK <= 20 ? args.topK : 5;
    const resolved = await resolveRealWorkspaceRoot(args, exec);
    if (!resolved.ok) return resolved.error;
    const { realRoot } = resolved;

    const indexPath = indexPathFor(indexRoot, realRoot);
    const loaded = await loadIndexState(indexPath, realRoot);
    if (loaded.error) return { status: 'error', reason: loaded.error, action: 'rebuild', root: realRoot };
    const { header, entries } = loaded;
    if (entries.length === 0) {
      return {
        status: 'error',
        reason: 'no-index',
        detail: 'run dsh_index_workspace for this root first',
      };
    }

    const storedFingerprint = header?.modelFingerprint ?? entries[0]?.modelFingerprint ?? null;
    if (storedFingerprint && storedFingerprint !== currentModelFingerprint) {
      return {
        status: 'error',
        reason: 'stale-model-fingerprint',
        detail: `Index was built with ${storedFingerprint}, expected ${currentModelFingerprint}. Re-run dsh_index_workspace.`,
      };
    }

    const [qvec] = await embedTexts([args.query], {
      baseURL: embeddingBaseURL,
      model,
      dimensions,
      fetchImpl,
      signal: exec?.signal,
    });
    const results = search(qvec, entries, topK).map(r => ({
      path: r.entry.path,
      startLine: r.entry.startLine,
      endLine: r.entry.endLine,
      kind: r.entry.kind,
      score: Number(r.score.toFixed(4)),
    }));
    const wState = watcherStates.get(realRoot);
    return {
      status: 'ok',
      root: realRoot,
      query: args.query,
      results,
      stale: Boolean(wState?.dirty),
      modelFingerprint: storedFingerprint ?? currentModelFingerprint,
      note: 'references only; read files with the read tool',
    };
  }

  const render = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }];
  const toolsSvc = svc(ctx, 'tools');
  const d1 = toolsSvc.register({
    name: 'dsh_index_workspace',
    description:
      'Build, refresh, watch, or inspect the semantic embedding index for a workspace using the local Ollama embedding model (embeddinggemma:300m). Performs SHA-256 incremental indexing, syntax-aware code chunking, and deletion pruning while respecting .gitignore/.kilocodeignore and skipping secrets/symlinks.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['build', 'status', 'watch', 'unwatch'],
          description: 'Action to run: build (default), status, watch, or unwatch.',
        },
        root: {
          type: 'string',
          description: 'Absolute workspace root to index (defaults to session working directory).',
        },
        maxFiles: {
          type: 'integer',
          description: 'Cap on number of files to index (1-20000).',
        },
        watch: {
          type: 'boolean',
          description: 'Keep file watcher active on this root to track dirty/stale status.',
        },
      },
    },
    output: { schema: { type: 'object' }, render },
    execute: (args, exec) => buildIndex(args, exec),
  });

  const d2 = toolsSvc.register({
    name: 'dsh_search_workspace',
    description:
      'Semantic-search a previously built workspace index. Returns the most relevant file references (path + line range + chunk kind + score) for a natural-language query. Read the files with the read tool to see content.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Natural-language search query.' },
        root: {
          type: 'string',
          description: 'Workspace root whose index to search (defaults to session working directory).',
        },
        topK: { type: 'integer', description: 'Number of results (1-20, default 5).' },
      },
    },
    output: { schema: { type: 'object' }, render },
    execute: (args, exec) => searchIndex(args, exec),
  });

  const d3 = toolsSvc.register({
    name: 'dsh_index_status',
    description:
      'Report workspace semantic index status: indexed file count, chunk count, stale/dirty state, last indexed timestamp, watcher state, and model fingerprint.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: {
          type: 'string',
          description: 'Absolute workspace root to inspect (defaults to session working directory).',
        },
      },
    },
    output: { schema: { type: 'object' }, render },
    execute: (args, exec) => getIndexStatus(args, exec),
  });

  const autoBuilt = new Set();
  const triggerAutoBuild = (exec) => {
    if (!autoBuild) return;
    try {
      const root = resolveRoot({}, exec, ctx);
      if (root && !autoBuilt.has(root)) {
        autoBuilt.add(root);
        void buildIndex({ action: 'build', watch: autoWatch, root }, exec)
          .then(result => { if (result.status !== 'ok') autoBuilt.delete(root); })
          .catch(() => { autoBuilt.delete(root); });
      }
    } catch { /* indexing never blocks */ }
  };

  const dStatus = typeof ctx?.provide === 'function' ? ctx.provide('dshWorkspaceIndex', {
    async status(agent, signal) {
      const result = await getIndexStatus({}, { agent, signal });
      if (result.status !== 'ok') return result;
      const { indexed, stale, dirty, fingerprintMismatch, lastIndexedAt } = result;
      if (!indexed) triggerAutoBuild({ agent, signal });
      return { status: 'ok', indexed, stale, dirty, fingerprintMismatch, lastIndexedAt };
    },
  }) : null;

  if (protocol) {
    const { Remote, RemoteError, principalOf, TypertRemoteService } = protocol;
    const initializers = [];
    class WorkspaceIndexUiService extends TypertRemoteService {
      constructor() {
        super(ctx, 'workspaceIndexUi');
        for (const initialize of initializers) initialize.call(this);
      }
      async getStatus(agent, signal) {
        const result = await getIndexStatus({}, { agent, signal });
        const root = result.root ?? null;
        const build = builds.get(root);
        const reason = storageBackend !== 'jsonl' ? 'unsupported-storage-backend' : result.reason ?? buildErrors.get(root);
        if (result.status === 'ok' && !result.indexed && !reason) triggerAutoBuild({ agent });
        if (result.status === 'ok' && result.indexed && (result.stale || result.dirty) && !reason && !build) scheduleRebuild(root, false);
        return {
          status: reason ? 'error' : result.status, reason: reason ?? null,
          indexed: Boolean(result.indexed), stale: Boolean(result.stale), dirty: Boolean(result.dirty),
          dirtyPaths: result.dirtyPaths ?? [], fingerprintMismatch: Boolean(result.fingerprintMismatch),
          fileCount: result.files ?? 0, chunkCount: result.chunks ?? 0, lastIndexedAt: result.lastIndexedAt ?? null,
          watching: Boolean(result.watching), recursive: Boolean(result.recursive), watchError: result.watchError ?? null,
          provider, model: result.model ?? model, baseURL: endpointError === 'invalid-embedding-endpoint' ? null : baseURL,
          dimensions: result.dimensions ?? dimensions, storageBackend: 'jsonl', root,
          building: Boolean(build), progress: build?.progress ?? null,
        };
      }
      async rebuild(agent, signal) {
        if (!this.ctx.invocation || principalOf(this.ctx.invocation) !== undefined) {
          throw new RemoteError('gateway/bad-request', 'Only the owner UI may rebuild the index.');
        }
        const result = await buildIndex({ action: 'build', watch: autoWatch }, { agent, signal });
        if (result.status !== 'ok') return { ...await this.getStatus(agent, signal), status: 'error', reason: result.reason };
        return this.getStatus(agent, signal);
      }
    }
    for (const name of ['getStatus', 'rebuild']) Remote(WorkspaceIndexUiService.prototype[name], {
      kind: 'method', name, static: false, private: false,
      addInitializer(fn) { initializers.push(fn); },
    });
    svc(ctx, 'typert').register(TYPERT);
    new WorkspaceIndexUiService();
  }

  const d4 = autoBuild && typeof ctx?.on === 'function'
    ? ctx.on('agent/pre-step', async (step, next) => {
        const decision = await next();
        triggerAutoBuild(step);
        return decision;
      })
    : null;

  const sysPrompt = svc(ctx, 'systemPrompt');
  const dPrompt = sysPrompt && typeof sysPrompt.section === 'function' ? sysPrompt.section({ name: 'dsh-workspace-index:guide', order: 9540, interpolate: false, text: () => 'When searching or exploring the workspace, call `dsh_search_workspace` first for semantic code and document discovery before multi-round `grep` or `glob`.' }) : null;
  const cleanup = () => {
    disposed = true;
    for (const controller of automaticBuilds.values()) controller.abort();
    for (const pending of rebuilds.values()) clearTimeout(pending.timer);
    rebuilds.clear();
    for (const root of [...watcherStates.keys()]) {
      stopWatcher(root);
    }
    watcherStates.clear();
    try { d1(); } catch { /* ignore */ }
    try { d2(); } catch { /* ignore */ }
    try { d3(); } catch { /* ignore */ }
    try { dStatus?.(); } catch { /* ignore */ }
    try { d4?.(); } catch { /* ignore */ }
    try { dPrompt?.(); } catch {}
  };
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => cleanup);
  }
  return cleanup;
}
