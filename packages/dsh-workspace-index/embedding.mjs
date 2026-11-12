/** Local embedding, L2-float32 validation, and syntax-aware semantic code chunker
 * for the DSH workspace index (@dsh-workbench/dsh-workspace-index).
 * Talks only to the configured local Ollama OpenAI-compatible embeddings endpoint
 * (default http://127.0.0.1:11434/v1 with embeddinggemma:300m, 768-dim).
 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
const DEFAULT_MODEL = 'embeddinggemma:300m';
const DEFAULT_DIMENSIONS = 768;
const DEFAULT_NORMALIZATION = 'l2-float32';

export const CHUNKER_VERSION = 'ast-v2';

export function computeModelFingerprint({
  model = DEFAULT_MODEL,
  dimensions = DEFAULT_DIMENSIONS,
  normalization = DEFAULT_NORMALIZATION,
} = {}) {
  const m = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_MODEL;
  const d = Number.isInteger(dimensions) && dimensions > 0 ? dimensions : DEFAULT_DIMENSIONS;
  const n = typeof normalization === 'string' && normalization.trim() ? normalization.trim() : DEFAULT_NORMALIZATION;
  return `${m}|dim=${d}|norm=${n}`;
}

export const INDEX_DEFAULTS = Object.freeze({
  baseURL: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  dimensions: DEFAULT_DIMENSIONS,
  normalization: DEFAULT_NORMALIZATION,
  prompt: 'none',
  chunkerVersion: CHUNKER_VERSION,
  modelFingerprint: computeModelFingerprint(),
});

/** Validate finite numbers, expected dimension, and L2-normalize to float32 precision. */
export function validateAndNormalizeVector(vec, expectedDimensions = DEFAULT_DIMENSIONS, normalize = true) {
  if (!Array.isArray(vec) && !ArrayBuffer.isView(vec)) {
    throw new Error('validateAndNormalizeVector: vector must be an array');
  }
  if (Number.isInteger(expectedDimensions) && expectedDimensions > 0 && vec.length !== expectedDimensions) {
    throw new Error(`validateAndNormalizeVector: expected ${expectedDimensions} dimensions, got ${vec.length}`);
  }
  if (vec.length === 0) {
    throw new Error('validateAndNormalizeVector: vector must not be empty');
  }
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`validateAndNormalizeVector: non-finite component at index ${i}`);
    }
    sumSq += v * v;
  }
  if (!Number.isFinite(sumSq) || sumSq <= 0) {
    throw new Error('validateAndNormalizeVector: zero or invalid vector norm');
  }
  if (!normalize) return Array.from(vec);
  const norm = Math.sqrt(sumSq);
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const f32 = Math.fround(vec[i] / norm);
    if (!Number.isFinite(f32)) {
      throw new Error(`validateAndNormalizeVector: normalized component overflow at index ${i}`);
    }
    out[i] = f32;
  }
  return out;
}

/** Check whether a stored vector is valid (matches expected dimensions and all components are finite). */
export function isValidVector(vec, expectedDimensions = DEFAULT_DIMENSIONS) {
  if (!Array.isArray(vec) || vec.length !== expectedDimensions || expectedDimensions <= 0) return false;
  for (let i = 0; i < vec.length; i++) {
    if (typeof vec[i] !== 'number' || !Number.isFinite(vec[i])) return false;
  }
  return true;
}

/** Embed an array of texts, returning L2-float32 normalized vectors in input order. */
export async function embedTexts(
  texts,
  {
    baseURL = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    dimensions = DEFAULT_DIMENSIONS,
    normalize = true,
    fetchImpl = globalThis.fetch,
    signal,
  } = {},
) {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new Error('embedTexts: texts must be a non-empty array');
  }
  for (const t of texts) {
    if (typeof t !== 'string') throw new Error('embedTexts: every input must be a string');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('embedTexts: fetch implementation unavailable');
  }
  const response = await fetchImpl(`${baseURL.replace(/\/+$/, '')}/embeddings`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
    signal,
  });
  if (!response.ok) throw new Error(`embedTexts: endpoint returned ${response.status}`);
  const body = await response.json();
  const data = body?.data;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error('embedTexts: response shape mismatch');
  }
  const vectors = new Array(texts.length);
  for (const item of data) {
    if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= texts.length || !Array.isArray(item.embedding)) {
      throw new Error('embedTexts: bad item');
    }
    vectors[item.index] = validateAndNormalizeVector(item.embedding, dimensions, normalize);
  }
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length === 0) throw new Error('embedTexts: missing vector');
  }
  return vectors;
}

/** Cosine similarity between two equal-length finite vectors. */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
    throw new Error('cosine: vector mismatch');
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i];
    const vb = b[i];
    if (typeof va !== 'number' || typeof vb !== 'number' || !Number.isFinite(va) || !Number.isFinite(vb)) {
      throw new Error(`cosine: non-finite component at index ${i}`);
    }
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Detect language family from file path and optional content heuristics. */
export function detectLanguage(filePath = '', text = '') {
  const lower = typeof filePath === 'string' ? filePath.toLowerCase() : '';
  if (/\.(ts|tsx|js|mjs|cjs|jsx)$/.test(lower)) return 'ts-js';
  if (/\.pyi?$/.test(lower)) return 'python';
  if (/\.go$/.test(lower)) return 'go';
  if (/\.rs$/.test(lower)) return 'rust';
  if (/\.(c|h|cpp|hpp|cc|cxx|hh)$/.test(lower)) return 'c';
  if (/\.(java|kt|kts)$/.test(lower)) return 'java';
  if (/\.(md|markdown|mdx|rst)$/.test(lower)) return 'markdown';
  if (/\.jsonc?$/.test(lower)) return 'json';

  if (typeof text === 'string' && text.length > 0) {
    const trimmed = text.trimStart();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        JSON.parse(trimmed);
        return 'json';
      } catch { /* fall through */ }
    }
    if (/^#{1,6}\s+\S/m.test(text) && (/^```/m.test(text) || /\n#{1,6}\s+\S/.test(text))) return 'markdown';
    if (/^(?:def|async\s+def|class)\s+[A-Za-z_]\w*.*:\s*$/m.test(text)) return 'python';
    if (/^package\s+\w+/m.test(text) || /^func\s+(?:\([^)]+\)\s*)?[A-Za-z_]\w*\s*\(/m.test(text)) return 'go';
    if (/^(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod)\s+[A-Za-z_]/m.test(text)) return 'rust';
    if (/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+[A-Za-z_$]/m.test(text)) return 'ts-js';
    if (/^(?:public|private|protected)\s+(?:static\s+|final\s+|abstract\s+)*(?:class|interface|enum|record)\s+[A-Za-z_]/m.test(text)) return 'java';
    if (/^#include\s+[<"]/m.test(text)) return 'c';
  }
  return 'generic';
}

/** Slice a single string into pieces each <= maxChars characters and <= maxBytes UTF-8 bytes. */
function sliceBoundedString(str, maxChars, maxBytes) {
  if (str.length <= maxChars && Buffer.byteLength(str, 'utf8') <= maxBytes) {
    return [str];
  }
  const pieces = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of str) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (current.length > 0 && (current.length + ch.length > maxChars || currentBytes + chBytes > maxBytes)) {
      pieces.push(current);
      current = ch;
      currentBytes = chBytes;
    } else {
      current += ch;
      currentBytes += chBytes;
    }
  }
  if (current.length > 0) pieces.push(current);
  return pieces;
}

/** Pack a sequence of lines (covering 1-based startLine..endLine) into chunks respecting maxChars and maxBytes. */
function windowLines(lines, baseStartLine, maxChars, maxBytes, kind = 'block') {
  const out = [];
  let buf = '';
  let bufBytes = 0;
  let chunkStart = baseStartLine;
  let chunkEnd = baseStartLine;

  function flush() {
    if (buf.trim().length > 0) {
      out.push({ text: buf, startLine: chunkStart, endLine: chunkEnd, kind });
    }
    buf = '';
    bufBytes = 0;
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNo = baseStartLine + i;
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, 'utf8');

    // If a single line exceeds caps, flush existing buffer and split the long line cleanly.
    if (line.length > maxChars || lineBytes > maxBytes) {
      flush();
      const slices = sliceBoundedString(line, maxChars, maxBytes);
      for (const s of slices) {
        if (s.trim().length > 0) {
          out.push({ text: s, startLine: lineNo, endLine: lineNo, kind });
        }
      }
      chunkStart = lineNo + 1;
      chunkEnd = lineNo + 1;
      continue;
    }

    if (buf === '') {
      buf = line;
      bufBytes = lineBytes;
      chunkStart = lineNo;
      chunkEnd = lineNo;
    } else {
      const candChars = buf.length + 1 + line.length;
      const candBytes = bufBytes + 1 + lineBytes;
      if (candChars > maxChars || candBytes > maxBytes) {
        flush();
        buf = line;
        bufBytes = lineBytes;
        chunkStart = lineNo;
        chunkEnd = lineNo;
      } else {
        buf += '\n' + line;
        bufBytes = candBytes;
        chunkEnd = lineNo;
      }
    }
  }
  flush();
  return out;
}

/** Emit a semantic section (lines[startIdx..endIdx] 0-based inclusive), subdividing if it exceeds caps. */
function emitSection(lines, startIdx, endIdx, maxChars, maxBytes, kind) {
  let s = startIdx;
  let e = endIdx;
  while (s <= e && lines[s].trim() === '') s++;
  while (e >= s && lines[e].trim() === '') e--;
  if (s > e) return [];
  const slice = lines.slice(s, e + 1);
  const joined = slice.join('\n');
  if (joined.length <= maxChars && Buffer.byteLength(joined, 'utf8') <= maxBytes) {
    return [{ text: joined, startLine: s + 1, endLine: e + 1, kind }];
  }
  return windowLines(slice, s + 1, maxChars, maxBytes, kind);
}

/** Markdown structural chunker: splits on ATX (#..######) and Setext headings outside code fences. */
function chunkMarkdown(lines, maxChars, maxBytes) {
  const boundaries = [];
  let inFence = false;
  let fenceMarker = '';

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (inFence) continue;

    if (/^#{1,6}\s+\S/.test(trimmed)) {
      boundaries.push({ lineIdx: i, kind: 'section' });
    } else if (
      i > 0 &&
      lines[i - 1].trim().length > 0 &&
      !lines[i - 1].trimStart().startsWith('#') &&
      /^(?:={3,}|-{3,})\s*$/.test(trimmed)
    ) {
      boundaries.push({ lineIdx: i - 1, kind: 'section' });
    }
  }

  if (boundaries.length === 0) {
    return windowLines(lines, 1, maxChars, maxBytes, 'section');
  }

  const out = [];
  if (boundaries[0].lineIdx > 0) {
    out.push(...emitSection(lines, 0, boundaries[0].lineIdx - 1, maxChars, maxBytes, 'preamble'));
  }
  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b].lineIdx;
    const end = b + 1 < boundaries.length ? boundaries[b + 1].lineIdx - 1 : lines.length - 1;
    out.push(...emitSection(lines, start, end, maxChars, maxBytes, boundaries[b].kind));
  }
  return out;
}

/** Python AST-like structural boundary chunker (functions, classes, methods, decorators, top-level blocks). */
function chunkPython(lines, maxChars, maxBytes) {
  // Walk lines tracking triple-quoted strings so we only match real declarations.
  const lineMeta = new Array(lines.length);
  let inTriple = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const startInTriple = inTriple !== null;
    let j = 0;
    while (j < line.length) {
      if (inTriple) {
        const idx = line.indexOf(inTriple, j);
        if (idx === -1) break;
        j = idx + 3;
        inTriple = null;
      } else {
        const ch = line[j];
        if (ch === '#') break;
        if (line.startsWith("'''", j) || line.startsWith('"""', j)) {
          inTriple = line.slice(j, j + 3);
          j += 3;
          continue;
        }
        j++;
      }
    }
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;
    lineMeta[i] = { inString: startInTriple, trimmed, indent };
  }

  // Find top-level and class-method boundaries.
  const decls = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lineMeta[i];
    if (m.inString || !m.trimmed) continue;
    if (m.indent === 0) {
      if (/^(?:async\s+def|def)\s+[A-Za-z_]\w*\s*\(/.test(m.trimmed)) {
        decls.push({ declIdx: i, indent: 0, kind: 'function' });
      } else if (/^class\s+[A-Za-z_]\w*/.test(m.trimmed)) {
        decls.push({ declIdx: i, indent: 0, kind: 'class' });
      } else if (/^if\s+__name__\s*==\s*['"]__main__['"]\s*:/.test(m.trimmed)) {
        decls.push({ declIdx: i, indent: 0, kind: 'block' });
      }
    }
  }

  if (decls.length === 0) {
    return windowLines(lines, 1, maxChars, maxBytes, 'block');
  }

  // Attach leading @decorators and # comment lines at the same indent to each declaration.
  function findAttachedStart(declIdx, minIdx, expectedIndent) {
    let start = declIdx;
    while (start > minIdx) {
      const prev = lineMeta[start - 1];
      if (!prev.inString && prev.indent === expectedIndent && (prev.trimmed.startsWith('@') || prev.trimmed.startsWith('#'))) {
        start--;
      } else {
        break;
      }
    }
    return start;
  }

  const starts = [];
  for (let d = 0; d < decls.length; d++) {
    const minIdx = d === 0 ? 0 : decls[d - 1].declIdx + 1;
    starts.push(findAttachedStart(decls[d].declIdx, minIdx, 0));
  }

  const out = [];
  if (starts[0] > 0) {
    out.push(...emitSection(lines, 0, starts[0] - 1, maxChars, maxBytes, 'preamble'));
  }

  for (let d = 0; d < decls.length; d++) {
    const start = starts[d];
    const end = d + 1 < decls.length ? starts[d + 1] - 1 : lines.length - 1;
    const decl = decls[d];

    if (decl.kind === 'class') {
      // Check for methods inside the class
      const methodDecls = [];
      for (let i = decl.declIdx + 1; i <= end; i++) {
        const m = lineMeta[i];
        if (!m.inString && m.indent > 0 && /^(?:async\s+def|def)\s+[A-Za-z_]\w*\s*\(/.test(m.trimmed)) {
          methodDecls.push({ declIdx: i, indent: m.indent });
        }
      }
      const classText = lines.slice(start, end + 1).join('\n');
      const classOversized = classText.length > maxChars || Buffer.byteLength(classText, 'utf8') > maxBytes;
      if (methodDecls.length >= 2 || (methodDecls.length >= 1 && classOversized)) {
        const methodStarts = [];
        for (let k = 0; k < methodDecls.length; k++) {
          const minIdx = k === 0 ? decl.declIdx + 1 : methodDecls[k - 1].declIdx + 1;
          methodStarts.push(findAttachedStart(methodDecls[k].declIdx, minIdx, methodDecls[k].indent));
        }
        // Emit class header + first method together if small, else separate class header
        const headerPlusFirst = lines.slice(start, (methodStarts.length > 1 ? methodStarts[1] - 1 : end) + 1).join('\n');
        if (headerPlusFirst.length <= maxChars && Buffer.byteLength(headerPlusFirst, 'utf8') <= maxBytes) {
          const firstEnd = methodStarts.length > 1 ? methodStarts[1] - 1 : end;
          out.push(...emitSection(lines, start, firstEnd, maxChars, maxBytes, 'method'));
          for (let k = 1; k < methodDecls.length; k++) {
            const mStart = methodStarts[k];
            const mEnd = k + 1 < methodDecls.length ? methodStarts[k + 1] - 1 : end;
            out.push(...emitSection(lines, mStart, mEnd, maxChars, maxBytes, 'method'));
          }
        } else {
          out.push(...emitSection(lines, start, methodStarts[0] - 1, maxChars, maxBytes, 'class'));
          for (let k = 0; k < methodDecls.length; k++) {
            const mStart = methodStarts[k];
            const mEnd = k + 1 < methodDecls.length ? methodStarts[k + 1] - 1 : end;
            out.push(...emitSection(lines, mStart, mEnd, maxChars, maxBytes, 'method'));
          }
        }
        continue;
      }
    }

    out.push(...emitSection(lines, start, end, maxChars, maxBytes, decl.kind));
  }

  return out;
}

/** Compute per-line starting brace depth and comment/string state for brace-scoped languages. */
function analyzeBraceLines(lines) {
  const info = new Array(lines.length);
  let depth = 0;
  let inBlockComment = false;
  let inString = null; // "'", '"', '`'

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const startDepth = depth;
    const startInComment = inBlockComment;
    const startInString = inString !== null;

    let j = 0;
    while (j < line.length) {
      if (inBlockComment) {
        const close = line.indexOf('*/', j);
        if (close === -1) break;
        inBlockComment = false;
        j = close + 2;
        continue;
      }
      if (inString) {
        const ch = line[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === inString) {
          inString = null;
        }
        j++;
        continue;
      }
      const ch = line[j];
      const next = line[j + 1];
      if (ch === '/' && next === '/') break;
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        j += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = ch;
        j++;
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
      j++;
    }

    info[i] = {
      startDepth,
      endDepth: depth,
      startInComment,
      startInString,
      trimmed: line.trim(),
    };
  }
  return info;
}

function classifyBraceDeclaration(trimmed, lang, depth) {
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
    return null;
  }
  if (depth === 0) {
    if (lang === 'ts-js') {
      if (/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[A-Za-z_$]/.test(trimmed)) return 'class';
      if (/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*[A-Za-z_$]/.test(trimmed)) return 'function';
      if (/^(?:export\s+)?(?:interface|type|enum|namespace|module)\s+[A-Za-z_$]/.test(trimmed)) return 'type';
      if (/^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(trimmed)) return 'function';
      if (/^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s+)?function\b/.test(trimmed)) return 'function';
    } else if (lang === 'go') {
      if (/^func\s+\([^)]+\)\s*[A-Za-z_]\w*/.test(trimmed)) return 'method';
      if (/^func\s+[A-Za-z_]\w*/.test(trimmed)) return 'function';
      if (/^type\s+[A-Za-z_]\w*\s+(?:struct|interface)\b/.test(trimmed)) return 'class';
      if (/^(?:type|const|var)\s+(?:[A-Za-z_]\w*|\()/.test(trimmed)) return 'type';
    } else if (lang === 'rust') {
      if (/^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+|const\s+|unsafe\s+)*fn\s+[A-Za-z_]\w*/.test(trimmed)) return 'function';
      if (/^(?:pub(?:\([^)]+\))?\s+)?(?:struct|enum|trait|union)\s+[A-Za-z_]\w*/.test(trimmed)) return 'class';
      if (/^(?:unsafe\s+)?impl(?:\s*<[^>]*>)?\s+\S/.test(trimmed)) return 'class';
      if (/^(?:pub(?:\([^)]+\))?\s+)?mod\s+[A-Za-z_]\w*/.test(trimmed)) return 'block';
      if (/^macro_rules!\s+[A-Za-z_]\w*/.test(trimmed)) return 'function';
    } else if (lang === 'java') {
      if (/^(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|data|open)\s+)*(?:class|interface|enum|record|object)\s+[A-Za-z_]\w*/.test(trimmed)) return 'class';
      if (/^(?:(?:public|private|protected|static|final|inline|suspend|override|open)\s+)*fun\s+[A-Za-z_]\w*/.test(trimmed)) return 'function';
    } else if (lang === 'c') {
      if (/^(?:template\s*<[^>]*>\s*)?(?:class|struct|enum|union|namespace)\s+[A-Za-z_]\w*/.test(trimmed)) return 'class';
      if (/^typedef\s+(?:struct|enum|union)\b/.test(trimmed)) return 'type';
      if (
        !/^(?:if|for|while|switch|return|else|#)\b/.test(trimmed) &&
        /^[A-Za-z_][\w:<>,\s*&~]*\s+[A-Za-z_~][\w:]*\s*\([^;]*$/.test(trimmed) &&
        (trimmed.includes('{') || !trimmed.endsWith(';'))
      ) {
        return 'function';
      }
    }
  } else if (depth === 1) {
    // Member methods inside class / impl / trait / interface
    if (lang === 'ts-js') {
      if (
        !/^(?:if|for|while|switch|catch|return|throw|new)\b/.test(trimmed) &&
        /^(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*(?:\*?\s*)?[A-Za-z_$#][\w$]*\s*(?:<[^>]*>)?\s*\([^;]*\{\s*$/.test(trimmed)
      ) {
        return 'method';
      }
    } else if (lang === 'rust') {
      if (/^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+|const\s+|unsafe\s+)*fn\s+[A-Za-z_]\w*/.test(trimmed)) return 'method';
    } else if (lang === 'java') {
      if (/^(?:(?:public|private|protected|static|final|synchronized|abstract|default|suspend|override|open)\s+)*(?:fun\s+|<[^>]+>\s+)?(?:[\w<>[\],.?]+\s+)?[A-Za-z_]\w*\s*\([^;]*\{\s*$/.test(trimmed)) {
        return 'method';
      }
    } else if (lang === 'c') {
      if (
        !/^(?:if|for|while|switch|catch|return|else)\b/.test(trimmed) &&
        /^(?:(?:virtual|static|inline|explicit|constexpr|friend)\s+)*[A-Za-z_~][\w:<>,\s*&~]*\([^;]*\{\s*$/.test(trimmed)
      ) {
        return 'method';
      }
    }
  }
  return null;
}

/** Attach leading comments (//, /* ... * /), attributes (#[...]), and annotations (@...) to a declaration line. */
function findBraceAttachedStart(info, declIdx, minIdx) {
  let start = declIdx;
  while (start > minIdx) {
    const prev = info[start - 1];
    const t = prev.trimmed;
    if (
      prev.startInComment ||
      t.startsWith('//') ||
      t.startsWith('/*') ||
      t.startsWith('*') ||
      t.startsWith('*/') ||
      t.startsWith('#[') ||
      t.startsWith('@') ||
      t.startsWith('template<') ||
      t.startsWith('template <')
    ) {
      start--;
    } else {
      break;
    }
  }
  return start;
}

/** Chunker for TS/JS, Go, Rust, C/C++, and Java/Kotlin. */
function chunkBraceLanguage(lines, lang, maxChars, maxBytes) {
  const info = analyzeBraceLines(lines);
  const topDecls = [];

  for (let i = 0; i < lines.length; i++) {
    const meta = info[i];
    if (meta.startInComment || meta.startInString) continue;
    if (meta.startDepth === 0) {
      const kind = classifyBraceDeclaration(meta.trimmed, lang, 0);
      if (kind) {
        topDecls.push({ declIdx: i, kind });
      }
    }
  }

  if (topDecls.length === 0) {
    return windowLines(lines, 1, maxChars, maxBytes, 'block');
  }

  const starts = [];
  for (let d = 0; d < topDecls.length; d++) {
    const minIdx = d === 0 ? 0 : topDecls[d - 1].declIdx + 1;
    starts.push(findBraceAttachedStart(info, topDecls[d].declIdx, minIdx));
  }

  const out = [];
  if (starts[0] > 0) {
    out.push(...emitSection(lines, 0, starts[0] - 1, maxChars, maxBytes, 'preamble'));
  }

  for (let d = 0; d < topDecls.length; d++) {
    const start = starts[d];
    const end = d + 1 < topDecls.length ? starts[d + 1] - 1 : lines.length - 1;
    const decl = topDecls[d];

    if (decl.kind === 'class') {
      const methods = [];
      for (let i = decl.declIdx + 1; i <= end; i++) {
        const meta = info[i];
        if (!meta.startInComment && !meta.startInString && meta.startDepth === 1) {
          const mKind = classifyBraceDeclaration(meta.trimmed, lang, 1);
          if (mKind === 'method') {
            methods.push({ declIdx: i });
          }
        }
      }
      const classText = lines.slice(start, end + 1).join('\n');
      const classOversized = classText.length > maxChars || Buffer.byteLength(classText, 'utf8') > maxBytes;
      if (methods.length >= 2 || (methods.length >= 1 && classOversized)) {
        const mStarts = [];
        for (let k = 0; k < methods.length; k++) {
          const minIdx = k === 0 ? decl.declIdx + 1 : methods[k - 1].declIdx + 1;
          mStarts.push(findBraceAttachedStart(info, methods[k].declIdx, minIdx));
        }
        const firstEnd = mStarts.length > 1 ? mStarts[1] - 1 : end;
        const headerPlusFirst = lines.slice(start, firstEnd + 1).join('\n');
        if (headerPlusFirst.length <= maxChars && Buffer.byteLength(headerPlusFirst, 'utf8') <= maxBytes) {
          out.push(...emitSection(lines, start, firstEnd, maxChars, maxBytes, 'method'));
          for (let k = 1; k < methods.length; k++) {
            const mStart = mStarts[k];
            const mEnd = k + 1 < methods.length ? mStarts[k + 1] - 1 : end;
            out.push(...emitSection(lines, mStart, mEnd, maxChars, maxBytes, 'method'));
          }
        } else {
          out.push(...emitSection(lines, start, mStarts[0] - 1, maxChars, maxBytes, 'class'));
          for (let k = 0; k < methods.length; k++) {
            const mStart = mStarts[k];
            const mEnd = k + 1 < methods.length ? mStarts[k + 1] - 1 : end;
            out.push(...emitSection(lines, mStart, mEnd, maxChars, maxBytes, 'method'));
          }
        }
        continue;
      }
    }

    out.push(...emitSection(lines, start, end, maxChars, maxBytes, decl.kind));
  }

  return out;
}

/** Chunker for JSON / JSONC documents: splits at top-level keys/items when oversized. */
function chunkJson(lines, maxChars, maxBytes) {
  const full = lines.join('\n');
  if (full.length <= maxChars && Buffer.byteLength(full, 'utf8') <= maxBytes) {
    return full.trim().length > 0
      ? [{ text: full, startLine: 1, endLine: lines.length, kind: 'json' }]
      : [];
  }
  const info = analyzeBraceLines(lines);
  const entryStarts = [];
  for (let i = 0; i < lines.length; i++) {
    const m = info[i];
    if (!m.startInComment && !m.startInString && m.startDepth === 1 && /^"[^"]+"\s*:/.test(m.trimmed)) {
      entryStarts.push(i);
    }
  }
  if (entryStarts.length <= 1) {
    return windowLines(lines, 1, maxChars, maxBytes, 'json');
  }
  const sections = [];
  for (let k = 0; k < entryStarts.length; k++) {
    const s = k === 0 ? 0 : entryStarts[k];
    const e = k + 1 < entryStarts.length ? entryStarts[k + 1] - 1 : lines.length - 1;
    sections.push({ start: s, end: e });
  }
  // Pack consecutive small JSON keys together up to maxChars/maxBytes, or window oversized ones.
  const out = [];
  let groupStart = null;
  let groupEnd = null;

  function flushGroup() {
    if (groupStart !== null && groupEnd !== null) {
      out.push(...emitSection(lines, groupStart, groupEnd, maxChars, maxBytes, 'json'));
      groupStart = null;
      groupEnd = null;
    }
  }

  for (const sec of sections) {
    if (groupStart === null) {
      groupStart = sec.start;
      groupEnd = sec.end;
    } else {
      const candidate = lines.slice(groupStart, sec.end + 1).join('\n');
      if (candidate.length <= maxChars && Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
        groupEnd = sec.end;
      } else {
        flushGroup();
        groupStart = sec.start;
        groupEnd = sec.end;
      }
    }
  }
  flushGroup();
  return out;
}

/** Split text into syntax-aware semantic chunks with 1-based {text, startLine, endLine, kind}
 * and strict character/UTF-8 byte caps.
 */
export function chunkText(text, maxChars = 1600, options = {}) {
  if (typeof text !== 'string') throw new Error('chunkText: text must be a string');
  if (!Number.isFinite(maxChars) || maxChars < 100) throw new Error('chunkText: maxChars too small');
  const effectiveMaxChars = Math.floor(maxChars);
  const effectiveMaxBytes =
    Number.isFinite(options?.maxBytes) && options.maxBytes >= 100
      ? Math.floor(options.maxBytes)
      : effectiveMaxChars;

  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.trim().length === 0) return [];
  const lines = normalized.split('\n');
  const lang = options?.language || detectLanguage(options?.filePath || '', normalized);

  if (lang === 'markdown') {
    return chunkMarkdown(lines, effectiveMaxChars, effectiveMaxBytes);
  }
  if (lang === 'python') {
    return chunkPython(lines, effectiveMaxChars, effectiveMaxBytes);
  }
  if (lang === 'json') {
    return chunkJson(lines, effectiveMaxChars, effectiveMaxBytes);
  }
  if (lang === 'ts-js' || lang === 'go' || lang === 'rust' || lang === 'c' || lang === 'java') {
    return chunkBraceLanguage(lines, lang, effectiveMaxChars, effectiveMaxBytes);
  }
  return windowLines(lines, 1, effectiveMaxChars, effectiveMaxBytes, 'block');
}

/** Rank entries by cosine similarity to queryVector; returns topK {entry, score}. */
export function search(queryVector, entries, topK = 5) {
  if (!Array.isArray(entries)) throw new Error('search: entries must be an array');
  if (!Number.isInteger(topK) || topK < 1) throw new Error('search: topK must be >= 1');
  const scored = entries.map(entry => ({ entry, score: cosine(queryVector, entry.vector) }));
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, topK);
}
