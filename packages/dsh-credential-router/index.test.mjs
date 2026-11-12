import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as plugin from './index.mjs';
import * as routerModule from './router.mjs';

const fixtureDir = mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), '.router-test-'));
after(() => rmSync(fixtureDir, { recursive: true, force: true }));
const alphaPath = join(fixtureDir, 'alpha');
const betaPath = join(fixtureDir, 'beta');
writeFileSync(alphaPath, 'route-alpha-token', { mode: 0o600 });
writeFileSync(betaPath, 'route-beta-token', { mode: 0o600 });
chmodSync(alphaPath, 0o600);
chmodSync(betaPath, 0o600);
const auth = value => `Bearer ${value}`;
const baseConfig = () => ({
  destinations: { alpha: { keyFile: alphaPath }, beta: { keyFile: betaPath } },
  defaultDestination: 'beta',
  rules: [],
});

test('both entry points export the public router API', () => {
  for (const entry of [plugin, routerModule]) {
    assert.equal(entry.name, 'dsh-credential-router');
    for (const key of ['apply', 'validateRouterConfig', 'createCredentialRouter', 'personalFablePreset', 'isCanonicalFable', 'applyFableKeyHeader']) {
      assert.equal(typeof entry[key], 'function');
    }
  }
});

test('package metadata and bundle patch expose the standalone preset', () => {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  const patch = JSON.parse(readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8'));
  assert.equal(pkg.name, '@dsh-workbench/dsh-credential-router');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=24.9.0');
  assert.equal(pkg.engines.dsh, '0.2.2-rc.1');
  assert.equal(pkg.scripts.test, 'node --test *.test.mjs');
  assert.equal(pkg.exports['.'], './index.mjs');
  assert.ok(pkg.files.includes('*.mjs'));
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.deepEqual(patch, [{ insert: [{ id: 'dsh-credential-router', name: '@dsh-workbench/dsh-credential-router', config: { preset: 'personal-fable' } }] }]);
});

test('first matching rule wins and the named default is used for unmatched requests', () => {
  const config = baseConfig();
  config.rules = [
    { provider: ['openrouter', 'other'], model: ['vendor/model'], purpose: ['chat', 'analysis'], destination: 'alpha' },
    { provider: 'openrouter', destination: 'beta' },
  ];
  const route = plugin.createCredentialRouter(config);
  const headers = new Headers();
  let calls = 0;
  assert.equal(route({ provider: 'openrouter', model: 'vendor/model', purpose: 'chat' }, headers, () => { calls++; return 'continued'; }), 'continued');
  assert.equal(headers.get('authorization'), auth('route-alpha-token'));
  assert.equal(calls, 1);
  route({ provider: 'openrouter', model: 'vendor/model', purpose: 'other' }, headers);
  assert.equal(headers.get('authorization'), auth('route-beta-token'));
  route({ provider: 'another', model: 'vendor/model', purpose: 'chat' }, headers);
  assert.equal(headers.get('authorization'), auth('route-beta-token'));
});

test('Fable preset routes only canonical OpenRouter forms and preserves passthrough', () => {
  const config = plugin.personalFablePreset({ noZdrKeyFile: alphaPath });
  assert.equal(config.defaultDestination, 'passthrough');
  assert.equal(config.destinations.openrouter_nozdr.requireStrictPermissions, false);
  assert.equal(config.destinations.openrouter_nozdr.errorMessage, 'Fable requires its dedicated OpenRouter key; the normal ZDR key was not substituted.');
  const route = plugin.createCredentialRouter(config);
  for (const request of [
    { model: 'openrouter/anthropic/claude-fable-5.1' },
    { provider: 'openrouter', model: 'anthropic/claude-fable-5.1' },
    { provider: 'openrouter', model: 'claude-fable-5.1' },
  ]) {
    const headers = new Headers();
    route(request, headers);
    assert.equal(headers.get('authorization'), auth('route-alpha-token'));
    assert.equal(plugin.isCanonicalFable(request.model, request.provider === 'openrouter'), true);
  }
  for (const request of [
    { provider: 'openrouter', model: 'anthropic/claude-fable-5.1-mini' },
    { provider: 'anthropic', model: 'openrouter/anthropic/claude-fable-5.1' },
    { provider: 'anthropic', model: 'anthropic/claude-fable-5.1' },
    { model: 'claude-fable-5.1' },
  ]) {
    const headers = { Authorization: 'existing' };
    route(request, headers);
    assert.deepEqual(headers, { Authorization: 'existing' });
  }
  assert.equal(plugin.isCanonicalFable('anthropic/claude-fable-5.1-mini', true), false);
  assert.equal(plugin.isCanonicalFable('claude-fable-5.1', false), false);
  const fallback = plugin.createCredentialRouter(plugin.personalFablePreset({ noZdrKeyFile: alphaPath, zdrKeyFile: betaPath }));
  const headers = new Headers();
  fallback({ provider: 'openrouter', model: 'another/model' }, headers);
  assert.equal(headers.get('authorization'), auth('route-beta-token'));
  const helperHeaders = {};
  plugin.applyFableKeyHeader({ provider: 'openrouter', model: 'claude-fable-5.1' }, helperHeaders, alphaPath);
  assert.equal(helperHeaders.Authorization, auth('route-alpha-token'));
});

test('keyEnv, baseURL and static header overrides apply to the selected destination', () => {
  const envName = 'DSH_ROUTER_TEST_VALUE';
  const previous = process.env[envName];
  process.env[envName] = 'route-beta-token';
  try {
    const config = baseConfig();
    config.destinations.beta = { keyEnv: envName, headerName: 'X-Route-Key', headerPrefix: '', baseURL: 'https://example.invalid/v1', headers: { 'X-Region': 'west' } };
    const route = plugin.createCredentialRouter(config);
    const request = { provider: 'another' };
    const headers = { 'x-region': 'old', 'x-route-key': 'old' };
    route(request, headers);
    assert.equal(request.baseURL, 'https://example.invalid/v1');
    assert.deepEqual(headers, { 'X-Region': 'west', 'X-Route-Key': 'route-beta-token' });
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});

test('validation rejects non-declarative, literal, unknown, and malformed configuration', () => {
  const decoratedRules = [];
  decoratedRules.extra = () => true;
  const accessorProviders = ['openrouter'];
  Object.defineProperty(accessorProviders, '0', { get: () => 'openrouter' });
  const hiddenDestination = { keyFile: alphaPath };
  Object.defineProperty(hiddenDestination, 'headerName', { value: 'Authorization' });
  const bad = [
    null, {}, { ...baseConfig(), defaultDestination: 'unknown' },
    { ...baseConfig(), rules: [{ provider: 'openrouter', destination: 'unknown' }] },
    { ...baseConfig(), rules: [{ destination: 'alpha' }] },
    { ...baseConfig(), rules: [{ provider: /openrouter/, destination: 'alpha' }] },
    { ...baseConfig(), rules: [{ provider: () => true, destination: 'alpha' }] },
    { ...baseConfig(), rules: decoratedRules },
    { ...baseConfig(), rules: [{ provider: accessorProviders, destination: 'alpha' }] },
    { ...baseConfig(), rules: [{ provider: 'openrouter', destination: 'alpha', predicate: () => true }] },
    { ...baseConfig(), rules: [{ provider: 'openrouter', model: [], destination: 'alpha' }] },
    { ...baseConfig(), rules: [{ provider: 'other', model: 'model', matchQualifiedAndUnqualified: true, destination: 'alpha' }] },
    { ...baseConfig(), destinations: { alpha: { keyFile: alphaPath, apiKey: 'literal' } } },
    { ...baseConfig(), destinations: { alpha: { keyFile: alphaPath, key: 'literal' } } },
    { ...baseConfig(), destinations: { alpha: { keyFile: alphaPath, token: 'literal' } } },
    { ...baseConfig(), destinations: { alpha: hiddenDestination } },
    { ...baseConfig(), destinations: { alpha: { keyFile: alphaPath, secret: 'literal' } } },
    { ...baseConfig(), destinations: { alpha: { keyFile: alphaPath, Authorization: 'literal' } } },
    { ...baseConfig(), destinations: { alpha: { keyFile: alphaPath, keyEnv: 'TEST' } } },
    { ...baseConfig(), destinations: { alpha: { keyFile: 42 } } },
    { ...baseConfig(), destinations: { alpha: { keyFile: alphaPath, headers: { authorization: 'literal' } } } },
    { ...baseConfig(), destinations: { alpha: { keyFile: alphaPath, requireStrictPermissions: 'false' } } },
    { destinations: { alpha: { keyFile: alphaPath } }, defaultDestination: 'alpha', rules: [{ provider: 'x', destination: 'alpha' }] },
  ];
  for (const value of bad) assert.throws(() => plugin.validateRouterConfig(value));
  assert.doesNotThrow(() => plugin.validateRouterConfig({ destinations: { alpha: { keyFile: alphaPath } }, defaultDestination: 'passthrough', rules: [{ provider: 'x', destination: 'alpha' }] }));
});

test('unusable matched and default credentials fail closed without leaking content', () => {
  const empty = join(fixtureDir, 'empty');
  const permissive = join(fixtureDir, 'permissive');
  const missing = join(fixtureDir, 'missing');
  writeFileSync(empty, ' \n ', { mode: 0o600 });
  writeFileSync(permissive, 'route-alpha-token', { mode: 0o600 });
  chmodSync(permissive, 0o644);
  for (const keyFile of [missing, empty, ...(process.platform === 'win32' ? [] : [permissive])]) {
    for (const matched of [true, false]) {
      const config = baseConfig();
      config.destinations.alpha = { keyFile, errorMessage: 'Selected credential unavailable.' };
      config.defaultDestination = matched ? 'beta' : 'alpha';
      config.rules = matched ? [{ provider: 'openrouter', destination: 'alpha' }] : [];
      const route = plugin.createCredentialRouter(config);
      const headers = { Authorization: 'unchanged' };
      const request = { provider: 'openrouter' };
      let calls = 0;
      assert.throws(() => route(request, headers, () => calls++), error => {
        assert.equal(error.message, 'Selected credential unavailable.');
        assert.equal(error.message.includes('route-alpha-token'), false);
        assert.equal(error.message.includes('route-beta-token'), false);
        return true;
      });
      assert.equal(calls, 0);
      assert.deepEqual(headers, { Authorization: 'unchanged' });
      assert.deepEqual(request, { provider: 'openrouter' });
    }
  }
  const missingEnv = baseConfig();
  missingEnv.destinations.beta = { keyEnv: 'DSH_ROUTER_TEST_MISSING' };
  const previous = process.env.DSH_ROUTER_TEST_MISSING;
  delete process.env.DSH_ROUTER_TEST_MISSING;
  try {
    assert.throws(() => plugin.createCredentialRouter(missingEnv)({}, {}, () => assert.fail('next called')));
  } finally {
    if (previous !== undefined) process.env.DSH_ROUTER_TEST_MISSING = previous;
  }
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const unreadable = join(fixtureDir, 'unreadable');
    writeFileSync(unreadable, 'route-alpha-token', { mode: 0o600 });
    chmodSync(unreadable, 0o000);
    const config = baseConfig();
    config.destinations.beta = { keyFile: unreadable, requireStrictPermissions: false };
    let calls = 0;
    assert.throws(() => plugin.createCredentialRouter(config)({}, {}, () => calls++), error => {
      assert.equal(error.message.includes('route-alpha-token'), false);
      return true;
    });
    assert.equal(calls, 0);
  }
});

test('header implementation failures are sanitized and never continue', () => {
  const route = plugin.createCredentialRouter(baseConfig());
  let calls = 0;
  const headers = { set: (_, value) => { throw new Error(value); } };
  assert.throws(() => route({}, headers, () => calls++), error => {
    assert.equal(error.message, 'Credential router could not apply the selected destination.');
    assert.equal(error.message.includes('route-beta-token'), false);
    return true;
  });
  assert.equal(calls, 0);
});

test('plugin registers exactly one disposable request listener', () => {
  const listeners = [];
  const disposers = [];
  const ctx = { on: (event, fn) => { listeners.push([event, fn]); return () => {}; }, effect: fn => disposers.push(fn) };
  const dispose = plugin.apply(ctx, baseConfig());
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0][0], 'llm-pi-ai/request-headers');
  assert.equal(disposers[0](), dispose);
  const headers = new Headers();
  let calls = 0;
  listeners[0][1]({}, headers, () => calls++);
  assert.equal(calls, 1);
  assert.equal(headers.get('authorization'), auth('route-beta-token'));
  assert.throws(() => plugin.apply(ctx, { preset: 'unknown' }));
  assert.doesNotThrow(() => plugin.apply(ctx, { preset: 'personal-fable' }));
});
