import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  embedTexts,
  cosine,
  chunkText,
  search,
  validateAndNormalizeVector,
  computeModelFingerprint,
  detectLanguage,
  CHUNKER_VERSION,
  INDEX_DEFAULTS,
} from './embedding.mjs';

test('cosine, L2-float32 normalization, finite/dimension validation, and model fingerprint', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosine([1, 1], [1, 1]) - 1) < 1e-9);
  assert.throws(() => cosine([1], [1, 2]));
  assert.throws(() => cosine([1, NaN], [1, 0]), /non-finite/);

  // validateAndNormalizeVector enforces dimensions, finite floats, non-zero norm, and l2-float32
  const raw = new Array(768).fill(0).map((_, i) => (i === 0 ? 3 : i === 1 ? 4 : 0));
  const norm = validateAndNormalizeVector(raw, 768);
  assert.equal(norm.length, 768);
  assert.equal(norm[0], Math.fround(0.6));
  assert.equal(norm[1], Math.fround(0.8));
  const l2 = Math.sqrt(norm.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(l2 - 1) < 1e-6);

  assert.throws(() => validateAndNormalizeVector([1, 2, 3], 768), /expected 768 dimensions/);
  assert.throws(() => validateAndNormalizeVector(new Array(768).fill(0), 768), /zero or invalid vector norm/);
  const withNan = new Array(768).fill(1);
  withNan[10] = Number.NaN;
  assert.throws(() => validateAndNormalizeVector(withNan, 768), /non-finite/);
  const withInf = new Array(768).fill(1);
  withInf[5] = Number.POSITIVE_INFINITY;
  assert.throws(() => validateAndNormalizeVector(withInf, 768), /non-finite/);

  assert.equal(INDEX_DEFAULTS.dimensions, 768);
  assert.equal(INDEX_DEFAULTS.normalization, 'l2-float32');
  assert.equal(INDEX_DEFAULTS.chunkerVersion, CHUNKER_VERSION);
  assert.equal(
    computeModelFingerprint({ model: 'embeddinggemma:300m', dimensions: 768, normalization: 'l2-float32' }),
    'embeddinggemma:300m|dim=768|norm=l2-float32',
  );
});

test('multi-language syntax-aware semantic chunker (TS/JS, Python, Go, Rust, C, Java, Markdown, JSON) + byte/char caps', () => {
  // 1. TypeScript / JavaScript: functions, classes, and methods with 1-based line ranges
  const tsCode = [
    'import { readFile } from "node:fs/promises";',
    '',
    '/** Fetch user record */',
    'export async function fetchUser(id: string) {',
    '  return { id };',
    '}',
    '',
    'export class AuthService {',
    '  login(user: string) {',
    '    return true;',
    '  }',
    '',
    '  logout(user: string) {',
    '    return false;',
    '  }',
    '}',
  ].join('\n');
  const tsChunks = chunkText(tsCode, 1600, { filePath: 'auth.ts' });
  assert.ok(tsChunks.some(c => c.kind === 'function' && c.text.includes('fetchUser') && c.startLine === 3 && c.endLine === 6));
  assert.ok(tsChunks.some(c => c.kind === 'method' && c.text.includes('login(')));
  assert.ok(tsChunks.some(c => c.kind === 'method' && c.text.includes('logout(') && c.startLine === 13 && c.endLine === 16));

  // 2. Python: decorators, functions, classes, methods, and ignoring def inside docstrings
  const pyCode = [
    'import os',
    '',
    '@cached',
    'def compute_total(items):',
    '    """',
    '    def fake_inside_docstring():',
    '        pass',
    '    """',
    '    return sum(items)',
    '',
    'class Processor:',
    '    def first_step(self):',
    '        return 1',
    '',
    '    def second_step(self):',
    '        return 2',
  ].join('\n');
  const pyChunks = chunkText(pyCode, 1600, { filePath: 'proc.py' });
  const fnChunk = pyChunks.find(c => c.kind === 'function');
  assert.ok(fnChunk, 'expected python function chunk');
  assert.equal(fnChunk.startLine, 3); // includes @cached decorator
  assert.equal(fnChunk.endLine, 9);
  assert.ok(pyChunks.some(c => c.kind === 'method' && c.text.includes('first_step')));
  assert.ok(pyChunks.some(c => c.kind === 'method' && c.text.includes('second_step') && c.startLine === 15 && c.endLine === 16));

  // 3. Go: struct and receiver methods
  const goCode = [
    'package server',
    '',
    'type Server struct {',
    '  Port int',
    '}',
    '',
    'func (s *Server) Start() error {',
    '  return nil',
    '}',
    '',
    'func Helper() string {',
    '  return "ok"',
    '}',
  ].join('\n');
  const goChunks = chunkText(goCode, 1600, { filePath: 'server.go' });
  assert.ok(goChunks.some(c => c.kind === 'class' && c.text.includes('type Server struct')));
  assert.ok(goChunks.some(c => c.kind === 'method' && c.text.includes('Start()')));
  assert.ok(goChunks.some(c => c.kind === 'function' && c.text.includes('Helper()')));

  // 4. Rust: attributes, struct, impl methods
  const rsCode = [
    '#[derive(Debug, Clone)]',
    'pub struct Indexer {',
    '    pub count: usize,',
    '}',
    '',
    'impl Indexer {',
    '    pub fn new() -> Self {',
    '        Self { count: 0 }',
    '    }',
    '',
    '    pub async fn run(&mut self) {',
    '        self.count += 1;',
    '    }',
    '}',
  ].join('\n');
  const rsChunks = chunkText(rsCode, 1600, { filePath: 'lib.rs' });
  assert.ok(rsChunks.some(c => c.kind === 'class' && c.text.includes('#[derive(Debug, Clone)]') && c.startLine === 1));
  assert.ok(rsChunks.some(c => c.kind === 'method' && c.text.includes('pub fn new')));
  assert.ok(rsChunks.some(c => c.kind === 'method' && c.text.includes('pub async fn run')));

  // 5. C and Java
  const cCode = [
    '#include <stdio.h>',
    '',
    'struct Point {',
    '  int x;',
    '  int y;',
    '};',
    '',
    'int add_points(int a, int b) {',
    '  return a + b;',
    '}',
  ].join('\n');
  const cChunks = chunkText(cCode, 1600, { filePath: 'point.c' });
  assert.ok(cChunks.some(c => c.kind === 'class' && c.text.includes('struct Point')));
  assert.ok(cChunks.some(c => c.kind === 'function' && c.text.includes('add_points')));

  const javaCode = [
    'public class Calculator {',
    '  public int add(int a, int b) {',
    '    return a + b;',
    '  }',
    '  public int sub(int a, int b) {',
    '    return a - b;',
    '  }',
    '}',
  ].join('\n');
  const javaChunks = chunkText(javaCode, 1600, { filePath: 'Calculator.java' });
  assert.ok(javaChunks.some(c => c.kind === 'method' && c.text.includes('add(')));
  assert.ok(javaChunks.some(c => c.kind === 'method' && c.text.includes('sub(')));

  // 6. Markdown: splits on headings, ignores # inside fenced code blocks
  const mdCode = [
    '# Overview',
    'Intro text.',
    '```python',
    '# comment inside code fence, not a heading',
    'x = 1',
    '```',
    '',
    '## Installation',
    'Run npm test.',
  ].join('\n');
  const mdChunks = chunkText(mdCode, 1600, { filePath: 'README.md' });
  assert.equal(mdChunks.length, 2);
  assert.equal(mdChunks[0].startLine, 1);
  assert.equal(mdChunks[0].endLine, 6);
  assert.equal(mdChunks[1].startLine, 8);
  assert.equal(mdChunks[1].endLine, 9);

  // 7. JSON: splits oversized JSON at top-level keys
  const jsonObj = {
    alpha: 'a'.repeat(80),
    beta: 'b'.repeat(80),
    gamma: 'c'.repeat(80),
  };
  const jsonText = JSON.stringify(jsonObj, null, 2);
  const jsonChunks = chunkText(jsonText, 140, { filePath: 'config.json' });
  assert.ok(jsonChunks.length >= 2);
  assert.ok(jsonChunks.every(c => c.text.length <= 140 && Buffer.byteLength(c.text, 'utf8') <= 140));

  // 8. Single long line & multi-byte UTF-8 strict character/byte cap
  const giantLine = 'const x = "' + 'é'.repeat(600) + '";';
  const bounded = chunkText(giantLine, 200, { filePath: 'minified.js', maxBytes: 200 });
  assert.ok(bounded.length >= 6);
  for (const c of bounded) {
    assert.ok(c.text.length <= 200, `char length ${c.text.length} exceeded 200`);
    assert.ok(Buffer.byteLength(c.text, 'utf8') <= 200, `byte length exceeded 200`);
    assert.equal(c.startLine, 1);
    assert.equal(c.endLine, 1);
  }
  assert.equal(detectLanguage('foo.rs'), 'rust');
});

test('real local Ollama embeddings return 768-dim l2-float32 vectors and rank matching chunk first', { skip: process.env.DSH_TEST_OLLAMA !== '1' }, async () => {
  const chunks = [
    'def sort_items(items):\n    return sorted(items)\n# python sorting helper',
    'function Button({onClick}) {\n  return <button onClick={onClick}>Click</button>\n}\n// react component',
    'SELECT a.id, b.name FROM orders a JOIN customers b ON a.customer_id = b.id;\n-- sql join',
  ];
  const vectors = await embedTexts(chunks);
  assert.equal(vectors.length, 3);
  for (const vec of vectors) {
    assert.equal(vec.length, INDEX_DEFAULTS.dimensions);
    assert.ok(vec.every(x => typeof x === 'number' && Number.isFinite(x)));
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-5, `expected unit L2 norm, got ${norm}`);
  }
  const [qvec] = await embedTexts(['how do I sort a list in python']);
  const results = search(
    qvec,
    vectors.map((vector, i) => ({ vector, path: `file${i}`, chunk: i })),
    3,
  );
  assert.equal(results[0].entry.chunk, 0, 'python sorting chunk should rank first');
  assert.ok(results[0].score > results[2].score);
}, { timeout: 60000 });

test('raw embeddings preserve magnitude and requests reject redirects', async () => {
  const vectors = await embedTexts(['fixture'], {
    dimensions: 2,
    normalize: false,
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, 'error');
      return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [3, 4] }] }) };
    },
  });
  assert.deepEqual(vectors, [[3, 4]]);
});
