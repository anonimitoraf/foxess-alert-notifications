/**
 * Environment based configuration.
 *
 * Every knob the scraper exposes lives here so that the rest of the code never
 * touches `process.env`. See `.env.example` and README.md for the full list.
 */

import { dirname, join } from 'node:path';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const YES = new Set(['1', 'true', 'yes', 'y', 'on']);
const NO = new Set(['0', 'false', 'no', 'n', 'off', '']);

function readString(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const trimmed = String(raw).trim();
  return trimmed === '' ? fallback : trimmed;
}

function readBool(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (YES.has(value)) return true;
  if (NO.has(value)) return false;
  throw new ConfigError(`${key} must be a boolean (true/false), received "${raw}"`);
}

function readInt(env, key, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ConfigError(`${key} must be an integer, received "${raw}"`);
  }
  if (value < min || value > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max}, received "${value}"`);
  }
  return value;
}

function readNumber(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value)) {
    throw new ConfigError(`${key} must be a number, received "${raw}"`);
  }
  return value;
}

function readList(env, key, fallback = []) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return [...fallback];
  return String(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readJson(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  try {
    return JSON.parse(String(raw));
  } catch (error) {
    throw new ConfigError(`${key} must be valid JSON: ${error.message}`);
  }
}

function readRegex(env, key, fallback) {
  const raw = readString(env, key);
  if (!raw) return fallback;
  try {
    return new RegExp(raw, 'i');
  } catch (error) {
    throw new ConfigError(`${key} is not a valid regular expression: ${error.message}`);
  }
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

/**
 * Joins the site base URL with a route.
 *
 * foxesscloud.com runs vue-router in history mode and normalises legacy hash
 * routes (`/#/login` -> `/login#/login`), so canonical routes are plain paths.
 * Absolute URLs and explicit `#/...` fragments are passed through untouched.
 */
export function resolveRoute(baseUrl, route) {
  if (/^https?:\/\//i.test(route)) return route;
  const base = trimTrailingSlash(baseUrl);
  const path = route.startsWith('/') ? route : `/${route}`;
  return `${base}${path}`;
}

export function loadConfig(env = process.env, { requireCredentials = true } = {}) {
  const dryRun = readBool(env, 'DRY_RUN', false);
  const debug = readBool(env, 'DEBUG', false);
  const runOnce = readBool(env, 'RUN_ONCE', false);

  const mode = (readString(env, 'FOXESS_MODE', 'api') || 'api').toLowerCase();
  if (!['api', 'browser'].includes(mode)) {
    throw new ConfigError('FOXESS_MODE must be "api" (recommended) or "browser"');
  }

  const username = readString(env, 'FOXESS_USERNAME');
  const password = readString(env, 'FOXESS_PASSWORD');
  const token = readString(env, 'FOXESS_TOKEN');

  const signatureMode = (readString(env, 'FOXESS_SIGNATURE', 'auto') || 'auto').toLowerCase();
  if (!['auto', 'off'].includes(signatureMode)) {
    throw new ConfigError('FOXESS_SIGNATURE must be "auto" or "off"');
  }

  const scope = (readString(env, 'FOXESS_ALERT_SCOPE', 'both') || 'both').toLowerCase();
  if (!['active', 'history', 'both'].includes(scope)) {
    throw new ConfigError('FOXESS_ALERT_SCOPE must be "active", "history" or "both"');
  }

  const baseUrl = trimTrailingSlash(readString(env, 'FOXESS_BASE_URL', 'https://www.foxesscloud.com'));
  const loginRoute = readString(env, 'FOXESS_LOGIN_ROUTE', '/login');
  const alertsRoutes = readList(env, 'FOXESS_ALERTS_ROUTES', ['/bus/alarm']);

  const pollIntervalMinutes = readInt(env, 'POLL_INTERVAL_MINUTES', 30, { min: 1, max: 24 * 60 });

  const transport = (readString(env, 'MAIL_TRANSPORT', 'smtp') || 'smtp').toLowerCase();
  if (!['smtp', 'json'].includes(transport)) {
    throw new ConfigError('MAIL_TRANSPORT must be one of: smtp, json');
  }

  const smtpPort = readInt(env, 'SMTP_PORT', 587, { min: 1, max: 65535 });
  const mailTo = readList(env, 'MAIL_TO');
  const mailCc = readList(env, 'MAIL_CC');
  const smtpUser = readString(env, 'SMTP_USER');
  const mailFrom =
    readString(env, 'MAIL_FROM') || smtpUser || readString(env, 'SMTP_FROM') || 'foxess-alerts@localhost';

  const config = {
    foxess: {
      mode,
      username,
      password,
      token,
      baseUrl,
      loginUrl: resolveRoute(baseUrl, loginRoute),
      alertsUrls: alertsRoutes.map((route) => resolveRoute(baseUrl, route)),
      routes: alertsRoutes,
      headless: readBool(env, 'HEADLESS', true),
      lang: readString(env, 'FOXESS_LANG', 'en'),
      proxyUrl: readString(env, 'FOXESS_PROXY_URL'),
      timezone: readString(env, 'FOXESS_TIMEZONE'),
      signatureMode,
      signerDir:
        readString(env, 'SIGNER_CACHE_DIR') ||
        join(dirname(readString(env, 'STATE_FILE', './data/state.json')), 'signer'),
      navTimeoutMs: readInt(env, 'NAV_TIMEOUT_MS', 45_000, { min: 5_000, max: 300_000 }),
      loginTimeoutMs: readInt(env, 'LOGIN_TIMEOUT_MS', 60_000, { min: 5_000, max: 300_000 }),
      settleMs: readInt(env, 'PAGE_SETTLE_MS', 3_000, { min: 0, max: 60_000 }),
      responseUrlPattern: readRegex(
        env,
        'ALERT_RESPONSE_URL_REGEX',
        /(alarm|alert|notif|message|notice|fault|event|warn)/i,
      ),
      ignoreResponseUrlPattern: readRegex(env, 'ALERT_RESPONSE_IGNORE_REGEX', /\/errors\/message$/i),
      pageActions: readJson(env, 'FOXESS_PAGE_ACTIONS', []),
      debugDir: readString(env, 'DEBUG_DIR') || (debug ? './debug' : null),
    },
    api: {
      timeoutMs: readInt(env, 'API_TIMEOUT_MS', 30_000, { min: 1_000, max: 300_000 }),
      loginPath: readString(env, 'FOXESS_LOGIN_PATH', '/foxess/biz/auth/login'),
      token,
      plantIds: readList(env, 'FOXESS_PLANT_IDS'),
      scope,
      historyChunkDays: readInt(env, 'FOXESS_HISTORY_CHUNK_DAYS', 14, { min: 1, max: 31 }),
    },
    schedule: {
      runOnce,
      intervalMs: pollIntervalMinutes * 60_000,
      jitterMs: readInt(env, 'POLL_JITTER_SECONDS', 30, { min: 0, max: 3600 }) * 1000,
      maxAttempts: readInt(env, 'MAX_ATTEMPTS', 3, { min: 1, max: 10 }),
      retryBackoffMs: readInt(env, 'RETRY_BACKOFF_MS', 5_000, { min: 0, max: 120_000 }),
    },
    alerts: {
      lookbackHours: readNumber(env, 'ALERT_LOOKBACK_HOURS', 24),
      minSeverity: (readString(env, 'ALERT_MIN_SEVERITY', 'unknown') || 'unknown').toLowerCase(),
      notifyMode: (readString(env, 'NOTIFY_MODE', 'new') || 'new').toLowerCase(),
      notifyOnFirstRun: readBool(env, 'NOTIFY_ON_FIRST_RUN', true),
      notifyOnEmpty: readBool(env, 'NOTIFY_ON_EMPTY', false),
      signalFallback: readBool(env, 'ALERT_SIGNAL_FALLBACK', true),
      notifyOnError: readBool(env, 'NOTIFY_ON_ERROR', true),
      errorNotifyCooldownHours: readNumber(env, 'ERROR_NOTIFY_COOLDOWN_HOURS', 6),
      stateRetentionDays: readInt(env, 'STATE_RETENTION_DAYS', 30, { min: 1, max: 3650 }),
      maxAlertsPerEmail: readInt(env, 'MAX_ALERTS_PER_EMAIL', 50, { min: 1, max: 500 }),
    },
    mail: {
      transport,
      jsonDir: readString(env, 'MAIL_JSON_DIR', './outbox'),
      host: readString(env, 'SMTP_HOST'),
      port: smtpPort,
      secure: readBool(env, 'SMTP_SECURE', smtpPort === 465),
      requireTls: readBool(env, 'SMTP_REQUIRE_TLS', false),
      rejectUnauthorized: readBool(env, 'SMTP_REJECT_UNAUTHORIZED', true),
      user: smtpUser,
      pass: readString(env, 'SMTP_PASS'),
      from: mailFrom,
      to: mailTo,
      cc: mailCc,
      subjectPrefix: readString(env, 'MAIL_SUBJECT_PREFIX', '[FoxESS]'),
    },
    runtime: {
      stateFile: readString(env, 'STATE_FILE', './data/state.json'),
      sessionFile: readString(env, 'SESSION_FILE', './data/session.json'),
      logLevel: (readString(env, 'LOG_LEVEL', 'info') || 'info').toLowerCase(),
      healthPort: readInt(env, 'HEALTH_PORT', 8080, { min: 0, max: 65535 }),
      dryRun,
      debug: Boolean(debug),
    },
  };

  validateConfig(config, { requireCredentials });
  return Object.freeze(config);
}

function validateConfig(config, { requireCredentials = true } = {}) {
  const problems = [];

  if (!requireCredentials) {
    // e.g. `--test-email`, which only exercises the SMTP path.
  } else if (config.foxess.mode === 'api') {
    const hasCredentials = config.foxess.username && config.foxess.password;
    if (!hasCredentials && !config.api.token) {
      problems.push('FOXESS_USERNAME and FOXESS_PASSWORD are required (or set FOXESS_TOKEN)');
    }
    if (config.foxess.username && !config.foxess.password) problems.push('FOXESS_PASSWORD is required');
  } else {
    if (!config.foxess.username) problems.push('FOXESS_USERNAME is required');
    if (!config.foxess.password) problems.push('FOXESS_PASSWORD is required');
  }

  if (!['new', 'all'].includes(config.alerts.notifyMode)) {
    problems.push('NOTIFY_MODE must be "new" or "all"');
  }
  if (!['critical', 'warning', 'info', 'unknown'].includes(config.alerts.minSeverity)) {
    problems.push('ALERT_MIN_SEVERITY must be one of: critical, warning, info, unknown');
  }
  if (!['debug', 'info', 'warn', 'error', 'silent'].includes(config.runtime.logLevel)) {
    problems.push('LOG_LEVEL must be one of: debug, info, warn, error, silent');
  }

  if (!Array.isArray(config.foxess.pageActions)) {
    problems.push('FOXESS_PAGE_ACTIONS must be a JSON array of action objects');
  }

  if (config.runtime.dryRun) {
    // Nothing to validate: we never touch SMTP in dry-run mode.
  } else if (config.mail.transport === 'smtp') {
    if (!config.mail.host) problems.push('SMTP_HOST is required (or set DRY_RUN=true)');
    if (!config.mail.to.length) problems.push('MAIL_TO is required (comma separated list of recipients)');
    if (config.mail.user && !config.mail.pass) problems.push('SMTP_PASS is required when SMTP_USER is set');
  }

  if (problems.length) {
    throw new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
