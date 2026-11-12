import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

export const name = 'dsh-credential-router';
export const NOZDR_KEY_PATH = process.env.DSH_OPENROUTER_NOZDR_KEY_FILE || `${homedir()}/.config/kilo/secrets/openrouter-nozdr`;

const plainObject = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const fieldNames = (value, allowed) => {
  if (!plainObject(value) || Object.getOwnPropertySymbols(value).length) throw new Error('Invalid credential router configuration');
  for (const [field, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!allowed.includes(field) || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Invalid credential router configuration');
  }
};
const plainArray = value => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && Object.getOwnPropertySymbols(value).length === 0 &&
  Object.getOwnPropertyNames(value).length === value.length + 1 && Array.from({ length: value.length }, (_, index) =>
    Object.getOwnPropertyDescriptor(value, String(index))).every(descriptor => descriptor && descriptor.enumerable && 'value' in descriptor);
const stringList = value => nonempty(value) || (plainArray(value) && value.length > 0 && value.every(nonempty));
const headerName = value => nonempty(value) && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value);
const headerValue = value => typeof value === 'string' && !/[\r\n]/.test(value);

export function validateRouterConfig(config) {
  fieldNames(config, ['destinations', 'defaultDestination', 'rules']);
  if (!plainObject(config.destinations) || Object.getOwnPropertySymbols(config.destinations).length || !plainArray(config.rules)) {
    throw new Error('Invalid credential router configuration');
  }
  const entries = Object.entries(Object.getOwnPropertyDescriptors(config.destinations));
  if (!entries.length || (config.rules.length && entries.length < 2 && config.defaultDestination !== 'passthrough')) {
    throw new Error('Invalid credential router destinations');
  }
  for (const [destination, descriptor] of entries) {
    if (!nonempty(destination) || destination === 'passthrough' || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Invalid credential router destination');
    const value = descriptor.value;
    fieldNames(value, ['keyFile', 'keyEnv', 'headerName', 'headerPrefix', 'baseURL', 'headers', 'requireStrictPermissions', 'errorMessage']);
    if ((Object.hasOwn(value, 'keyFile') === Object.hasOwn(value, 'keyEnv')) ||
        (Object.hasOwn(value, 'keyFile') && !nonempty(value.keyFile)) ||
        (Object.hasOwn(value, 'keyEnv') && !nonempty(value.keyEnv)) ||
        (Object.hasOwn(value, 'headerName') && !headerName(value.headerName)) ||
        (Object.hasOwn(value, 'headerPrefix') && !headerValue(value.headerPrefix)) ||
        (Object.hasOwn(value, 'baseURL') && !nonempty(value.baseURL)) ||
        (Object.hasOwn(value, 'requireStrictPermissions') && typeof value.requireStrictPermissions !== 'boolean') ||
        (Object.hasOwn(value, 'errorMessage') && !nonempty(value.errorMessage))) {
      throw new Error('Invalid credential router destination');
    }
    if (Object.hasOwn(value, 'headers')) {
      if (!plainObject(value.headers) || Object.getOwnPropertySymbols(value.headers).length) throw new Error('Invalid credential router headers');
      for (const [key, header] of Object.entries(Object.getOwnPropertyDescriptors(value.headers))) {
        if (!header.enumerable || !('value' in header) || !headerName(key) || !headerValue(header.value) ||
            /authorization|api[-_]?key|token|secret/i.test(key) || key.toLowerCase() === (value.headerName ?? 'Authorization').toLowerCase()) {
          throw new Error('Invalid credential router headers');
        }
      }
    }
  }
  if (!nonempty(config.defaultDestination) || (config.defaultDestination !== 'passthrough' && !Object.hasOwn(config.destinations, config.defaultDestination))) {
    throw new Error('Invalid credential router default destination');
  }
  for (const rule of config.rules) {
    fieldNames(rule, ['provider', 'model', 'purpose', 'destination', 'matchQualifiedAndUnqualified', 'unqualifiedAliases']);
    if (!['provider', 'model', 'purpose'].some(key => Object.hasOwn(rule, key)) ||
        ['provider', 'model', 'purpose'].some(key => Object.hasOwn(rule, key) && !stringList(rule[key])) ||
        !nonempty(rule.destination) || !Object.hasOwn(config.destinations, rule.destination) ||
        (Object.hasOwn(rule, 'matchQualifiedAndUnqualified') && typeof rule.matchQualifiedAndUnqualified !== 'boolean') ||
        (rule.matchQualifiedAndUnqualified === true && (rule.provider !== 'openrouter' || !Object.hasOwn(rule, 'model'))) ||
        (Object.hasOwn(rule, 'unqualifiedAliases') && (rule.matchQualifiedAndUnqualified !== true || !plainArray(rule.unqualifiedAliases) || !stringList(rule.unqualifiedAliases)))) {
      throw new Error('Invalid credential router rule');
    }
  }
  return config;
}

const matches = (condition, value) => Array.isArray(condition) ? condition.includes(value) : condition === value;

function matchesRule(rule, request) {
  const model = request?.model;
  const provider = (request?.provider == null || request?.provider === '') && typeof model === 'string' && model.startsWith('openrouter/')
    ? 'openrouter' : request?.provider;
  if (Object.hasOwn(rule, 'provider') && !matches(rule.provider, provider)) return false;
  if (Object.hasOwn(rule, 'purpose') && !matches(rule.purpose, request?.purpose)) return false;
  if (Object.hasOwn(rule, 'model')) {
    if (matches(rule.model, model)) return true;
    if (rule.matchQualifiedAndUnqualified !== true || typeof model !== 'string') return false;
    const models = Array.isArray(rule.model) ? rule.model : [rule.model];
    if (rule.unqualifiedAliases?.includes(model)) return true;
    return models.some(candidate => model === (candidate.startsWith('openrouter/') ? candidate.slice('openrouter/'.length) : `openrouter/${candidate}`));
  }
  return true;
}

function resolveSecret(destination) {
  let fd;
  try {
    let value;
    if (destination.keyFile !== undefined) {
      fd = openSync(destination.keyFile, 'r');
      const stat = fstatSync(fd);
      if (!stat.isFile() || (process.platform !== 'win32' && destination.requireStrictPermissions !== false && (stat.mode & 0o077) !== 0)) throw new Error();
      value = readFileSync(fd, 'utf8');
    } else {
      value = process.env[destination.keyEnv];
    }
    if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value.trim())) throw new Error();
    return value.trim();
  } catch {
    throw new Error(destination.errorMessage ?? 'Credential router could not resolve the selected destination secret.');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function setHeader(headers, key, value) {
  if (typeof headers?.set === 'function') headers.set(key, value);
  else if (headers && typeof headers === 'object') {
    for (const existing of Object.keys(headers)) if (existing.toLowerCase() === key.toLowerCase()) delete headers[existing];
    headers[key] = value;
  }
}

export function createCredentialRouter(config) {
  validateRouterConfig(config);
  const routing = structuredClone(config);
  return (request, headers, next) => {
    const destinationName = routing.rules.find(rule => matchesRule(rule, request))?.destination ?? routing.defaultDestination;
    if (destinationName !== 'passthrough') {
      const destination = routing.destinations[destinationName];
      const secret = resolveSecret(destination);
      try {
        for (const [key, value] of Object.entries(destination.headers ?? {})) setHeader(headers, key, value);
        setHeader(headers, destination.headerName ?? 'Authorization', `${destination.headerPrefix ?? 'Bearer '}${secret}`);
      } catch {
        throw new Error(destination.errorMessage ?? 'Credential router could not apply the selected destination.');
      }
      if (destination.baseURL !== undefined) request.baseURL = destination.baseURL;
    }
    return typeof next === 'function' ? next() : headers;
  };
}

export function personalFablePreset({ noZdrKeyFile = NOZDR_KEY_PATH, zdrKeyFile = null, requireStrictPermissions = false } = {}) {
  const destinations = {
    openrouter_nozdr: {
      keyFile: noZdrKeyFile,
      errorMessage: 'Fable requires its dedicated OpenRouter key; the normal ZDR key was not substituted.',
      requireStrictPermissions,
    },
  };
  if (zdrKeyFile) destinations.openrouter_zdr = { keyFile: zdrKeyFile, requireStrictPermissions };
  return validateRouterConfig({
    destinations,
    defaultDestination: zdrKeyFile ? 'openrouter_zdr' : 'passthrough',
    rules: [{ provider: 'openrouter', model: ['anthropic/claude-fable-5.1', 'openrouter/anthropic/claude-fable-5.1'],
      matchQualifiedAndUnqualified: true, unqualifiedAliases: ['claude-fable-5.1'], destination: 'openrouter_nozdr' }],
  });
}

export function isCanonicalFable(modelID, openRouterScoped = false) {
  return modelID === 'openrouter/anthropic/claude-fable-5.1' ||
    (openRouterScoped && (modelID === 'anthropic/claude-fable-5.1' || modelID === 'claude-fable-5.1'));
}

export function applyFableKeyHeader(request, headers, keyPath = NOZDR_KEY_PATH) {
  return createCredentialRouter(personalFablePreset({ noZdrKeyFile: keyPath }))(request, headers);
}

export function apply(ctx, config) {
  if (plainObject(config) && Object.hasOwn(config, 'preset')) {
    fieldNames(config, ['preset']);
    if (config.preset !== 'personal-fable') throw new Error('Invalid credential router preset');
    config = personalFablePreset();
  }
  const router = createCredentialRouter(config);
  const dispose = ctx.on('llm-pi-ai/request-headers', router);
  ctx.effect?.(() => dispose);
  return dispose;
}
