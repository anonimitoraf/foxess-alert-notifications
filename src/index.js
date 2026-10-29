#!/usr/bin/env node
/**
 * foxess-alert-notifications
 *
 * Polls a FoxESS Cloud account with a headless browser, extracts active alerts
 * from the rendered views (plus the JSON the app itself fetches) and emails new
 * ones to the configured recipients.
 *
 * Modes:
 *   node src/index.js            long running worker (poll every POLL_INTERVAL_MINUTES)
 *   node src/index.js --once     single check, exits 0 when the check completed
 *   node src/index.js --dry-run  never sends mail, prints a preview instead
 *   node src/index.js --debug    captures screenshots / HTML / JSON under DEBUG_DIR
 */

import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import { filterBySeverity, sortAlerts } from './alerts.js';
import { collectAlerts } from './api/collect.js';
import { ConfigError, loadConfig } from './config.js';
import { buildEmail, buildErrorEmail, buildTestEmail } from './email/template.js';
import { startHealthServer } from './health.js';
import { createLogger } from './logger.js';
import { createMailer } from './mailer.js';
import { capAlerts, selectNotifications } from './policy.js';
import {
  markNotified,
  markSeen,
  pruneSeen,
  readState,
  recordError,
  recordErrorNotified,
  recordRun,
  seenCount,
  shouldNotifyError,
  writeState,
} from './state.js';

const USAGE = `
foxess-alert-notifications - email new FoxESS Cloud alerts

Usage:
  node src/index.js [--once] [--test-email] [--dry-run] [--debug] [--help]

Flags:
  --once        run a single check and exit (use with cron / Kubernetes CronJob)
  --test-email  send one test email using the configured SMTP settings and exit
  --dry-run     render and log the email instead of sending it
  --debug       capture screenshots, HTML and API payloads for troubleshooting
  --help        show this help

Configuration is read from the environment; see .env.example and README.md.
`.trim();

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      once: { type: 'boolean', default: false },
      'test-email': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      debug: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  return values;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * De-duplication is the only thing standing between a 30 minute poll and an
 * inbox full of the same inverter fault, so an unwritable state directory must
 * stop the worker instead of silently degrading.
 */
async function assertWritableDir(dir, label) {
  try {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, `.write-probe-${process.pid}`);
    await writeFile(probe, 'ok', 'utf8');
    await unlink(probe);
  } catch (error) {
    throw new ConfigError(
      `${label} directory "${dir}" is not writable (${error.code ?? error.message}).\n` +
        'Fix it with: chown -R 1000:1000 <host directory>  (the container runs as uid 1000), ' +
        'or point STATE_FILE/SESSION_FILE at a writable path.',
    );
  }
}

async function assertWritablePaths(config) {
  await assertWritableDir(dirname(config.runtime.stateFile), 'STATE_FILE');
  await assertWritableDir(dirname(config.runtime.sessionFile), 'SESSION_FILE');
  if (config.mail.transport === 'json' && !config.runtime.dryRun) {
    await assertWritableDir(config.mail.jsonDir, 'MAIL_JSON_DIR');
  }
  if (config.foxess.mode === 'api' && config.foxess.signatureMode === 'auto') {
    await assertWritableDir(config.foxess.signerDir, 'SIGNER_CACHE_DIR');
  }
}

/** Resolves the configured alert source (api = HTTP, browser = headless Chromium). */
async function loadSource(config) {
  if (config.foxess.mode !== 'browser') return collectAlerts;

  try {
    const { scrapeAlerts } = await import('./scraper/scrape.js');
    return scrapeAlerts;
  } catch (error) {
    throw new ConfigError(
      'FOXESS_MODE=browser needs Playwright, which is an optional dependency:\n' +
        '  npm install playwright && npx playwright install --with-deps chromium\n' +
        `Original error: ${error.message}`,
    );
  }
}

async function withRetry(fn, { attempts = 3, backoffMs = 5_000, logger, label = 'operation' }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      lastError.attempts = attempt;
      logger.warn(`${label} failed`, { attempt, attempts, error: error.message });
      if (error.retryable === false) {
        logger.debug(`${label} cannot succeed on retry, giving up`, { errno: error.errno });
        throw error;
      }
      if (attempt < attempts) await sleep(backoffMs * attempt);
    }
  }
  throw lastError;
}

/**
 * Renders and sends (or logs, in dry-run mode) the alert email.
 */
async function sendAlerts({ alerts, sources, config, mailer, logger, dryRun, diagnostics }) {
  const { alerts: capped, truncated } = capAlerts(alerts, config.alerts.maxAlertsPerEmail);

  const { subject, text, html } = buildEmail({
    alerts: capped,
    sources: sources.map((source) => ({ label: source.label, url: source.url })),
    checkTime: new Date().toISOString(),
    timezone: config.foxess.timezone,
    truncated,
    home: 'FoxESS Cloud',
  });

  if (dryRun || config.runtime.dryRun) {
    logger.info('dry-run: email not sent', { subject, recipients: config.mail.to, alerts: capped.length });
    logger.info(`dry-run email body:\n${text}`);
    return { sent: false, dryRun: true, subject };
  }

  await mailer.send({ subject, text, html });
  logger.info('alert email sent', { subject, recipients: config.mail.to.length, truncated, diagnostics });
  return { sent: true, subject };
}

async function runCheck({ config, state, mailer, logger, runtime, source }) {
  const now = new Date();
  // Dry runs must not consume the backlog: work on a throwaway copy of the state
  // so `DRY_RUN=true` then a real run still emails everything unseen.
  const working = config.runtime.dryRun ? { ...state, seen: { ...state.seen } } : state;
  const isFirstRun = !working.firstRunCompletedAt;
  logger.info('starting alert check', {
    mode: config.foxess.mode,
    firstRun: isFirstRun,
    lookbackHours: config.alerts.lookbackHours,
  });

  let scraped;
  try {
    scraped = await withRetry(() => source(config, logger), {
      attempts: config.schedule.maxAttempts,
      backoffMs: config.schedule.retryBackoffMs,
      logger,
      label: 'scrape',
    });
  } catch (error) {
    return handleCheckFailure({ error, config, state: working, mailer, logger, runtime, now });
  }

  const filtered = filterBySeverity(scraped.alerts, config.alerts.minSeverity);
  const alerts = sortAlerts(filtered);
  const { newAlerts } = markSeen(working, alerts, now);
  const candidates = selectNotifications({ alerts, newAlerts, isFirstRun, config });

  logger.info('check completed', {
    ...scraped.diagnostics,
    keptAfterSeverityFilter: alerts.length,
    newAlerts: newAlerts.length,
    toNotify: candidates.length,
  });
  for (const source of scraped.sources) {
    logger.debug('view scanned', { label: source.label, url: source.url, rows: source.rows });
  }

  let email = { sent: false };
  if (candidates.length > 0) {
    email = await sendAlerts({
      alerts: candidates,
      sources: scraped.sources,
      config,
      mailer,
      logger,
      diagnostics: scraped.diagnostics,
    });
    if (email.sent) markNotified(working, candidates, now);
  } else if (config.alerts.notifyOnEmpty) {
    await sendAlerts({ alerts: [], sources: scraped.sources, config, mailer, logger, diagnostics: scraped.diagnostics });
    logger.info('no new alerts; sent "all clear" email because NOTIFY_ON_EMPTY=true');
  } else {
    logger.info('no new alerts to notify', { activeInWindow: alerts.length });
  }

  pruneSeen(working, { now, retentionDays: config.alerts.stateRetentionDays });
  recordRun(
    working,
    {
      status: 'ok',
      alertsInWindow: alerts.length,
      newAlerts: newAlerts.length,
      notified: email.sent ? candidates.length : 0,
      emailed: email.sent,
      diagnostics: scraped.diagnostics,
    },
    now,
  );
  working.lastError = null;

  if (config.runtime.dryRun) {
    logger.info('dry-run: state not persisted, alerts were not marked as seen');
  } else {
    await writeState(config.runtime.stateFile, working);
  }

  runtime.lastRun = { at: now.toISOString(), status: 'ok', ...working.lastRun };
  runtime.lastError = null;
  runtime.seenAlerts = seenCount(config.runtime.dryRun ? state : working);

  return { ok: true, alerts, newAlerts, email, diagnostics: scraped.diagnostics };
}

async function handleCheckFailure({ error, config, state, mailer, logger, runtime, now }) {
  logger.error('alert check failed', { error: error.message, name: error.name, url: error.details?.url });

  recordError(state, error, now);
  pruneSeen(state, { now, retentionDays: config.alerts.stateRetentionDays });

  let emailed = false;
  if (config.alerts.notifyOnError && shouldNotifyError(state, { now, cooldownHours: config.alerts.errorNotifyCooldownHours })) {
    try {
      const { subject, text, html } = buildErrorEmail({
        error,
        checkTime: now.toISOString(),
        timezone: config.foxess.timezone,
        attempts: error.attempts ?? 1,
      });
      if (config.runtime.dryRun) {
        logger.info('dry-run: failure email not sent', { subject });
        logger.info(`dry-run failure email body:\n${text}`);
      } else {
        await mailer.send({ subject, text, html });
        emailed = true;
        recordErrorNotified(state, now);
      }
    } catch (mailError) {
      logger.error('could not send failure notification', { error: mailError.message });
    }
  } else if (config.alerts.notifyOnError) {
    logger.info('skipping failure notification (cooldown)', {
      lastNotifiedAt: state.lastErrorNotifiedAt,
      cooldownHours: config.alerts.errorNotifyCooldownHours,
    });
  }

  recordRun(state, { status: 'error', notified: emailed ? 1 : 0, error: error.message }, now, { markFirstRun: false });
  if (config.runtime.dryRun) {
    logger.info('dry-run: state not persisted');
  } else {
    await writeState(config.runtime.stateFile, state).catch((writeError) =>
      logger.error('could not persist state', { error: writeError.message }),
    );
  }

  runtime.lastRun = { at: now.toISOString(), status: 'error', error: error.message };
  runtime.lastError = { at: now.toISOString(), message: error.message };
  runtime.seenAlerts = seenCount(state);

  return { ok: false, error, emailed };
}

/** `--test-email`: prove the SMTP path works without touching FoxESS or state.json. */
async function sendTestEmail(config, logger) {
  const mailer = createMailer(config, logger.child('mail'));
  const { subject, text, html } = buildTestEmail({ config, timezone: config.foxess.timezone });

  try {
    if (config.runtime.dryRun) {
      logger.info('dry-run: test email not sent', { subject, recipients: config.mail.to });
      logger.info(`dry-run test email body:\n${text}`);
      return 0;
    }
    await mailer.send({ subject, text, html });
    logger.info('test email sent', { subject, recipients: config.mail.to, transport: config.mail.transport });
    return 0;
  } catch (error) {
    logger.error('could not send the test email', {
      error: error.message,
      host: config.mail.host,
      port: config.mail.port,
      user: config.mail.user,
    });
    return 1;
  } finally {
    mailer.close();
  }
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log(USAGE);
    return 0;
  }

  if (cli['dry-run']) process.env.DRY_RUN = 'true';
  if (cli.debug) {
    process.env.DEBUG = 'true';
    process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'debug';
  }
  if (cli.once) process.env.RUN_ONCE = 'true';

  let config;
  try {
    // --test-email only needs the mail settings, not FoxESS credentials.
    config = loadConfig(process.env, { requireCredentials: !cli['test-email'] });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n\nRun with --help for usage.\n`);
      return 2;
    }
    throw error;
  }

  const logger = createLogger({ level: config.runtime.logLevel, scope: 'foxess' });

  if (cli['test-email']) {
    return sendTestEmail(config, logger);
  }

  try {
    await assertWritablePaths(config);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const state = await readState(config.runtime.stateFile);
  const mailer = createMailer(config, logger.child('mail'));
  let source;
  try {
    source = await loadSource(config);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n${error.message}\n`);
      return 2;
    }
    throw error;
  }
  const runtime = {
    startedAt: new Date().toISOString(),
    running: false,
    nextRunAt: null,
    lastRun: state.lastRun ? { ...state.lastRun } : null,
    lastError: state.lastError,
    seenAlerts: seenCount(state),
  };

  logger.info('foxess-alert-notifications starting', {
    mode: config.foxess.mode,
    baseUrl: config.foxess.baseUrl,
    routes: config.foxess.mode === 'browser' ? config.foxess.routes : undefined,
    scope: config.foxess.mode === 'api' ? config.api.scope : undefined,
    runOnce: config.schedule.runOnce,
    intervalMinutes: Math.round(config.schedule.intervalMs / 60_000),
    notifyMode: config.alerts.notifyMode,
    dryRun: config.runtime.dryRun,
    transport: config.mail.transport,
    stateFile: config.runtime.stateFile,
  });

  const health = startHealthServer({ port: config.runtime.healthPort, runtime, logger: logger.child('health') });

  let shuttingDown = false;
  let timer = null;
  let currentRun = null;
  let exitCode = 0;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    if (timer) clearTimeout(timer);
    try {
      await currentRun;
    } catch {
      /* already logged */
    }
    await health.close();
    mailer.close();
    await writeState(config.runtime.stateFile, state).catch(() => {});
    logger.info('stopped');
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      shutdown(signal).then(() => process.exit(0));
    });
  }

  const execute = async (trigger) => {
    if (shuttingDown) return { ok: false, skipped: true };
    runtime.running = true;
    const startedAt = Date.now();
    try {
      const result = await runCheck({ config, state, mailer, logger, runtime, source });
      if (!result.ok) exitCode = 1;
      return result;
    } catch (error) {
      // Anything unexpected (state IO, template bug, ...) is logged and counted.
      logger.error('unhandled check error', { error: error.message, stack: error.stack?.split('\n').slice(0, 6).join(' | ') });
      exitCode = 1;
      runtime.lastRun = { at: new Date().toISOString(), status: 'error', error: error.message };
      return { ok: false, error };
    } finally {
      runtime.running = false;
      logger.debug('check finished', { trigger, durationMs: Date.now() - startedAt });
    }
  };

  if (config.schedule.runOnce) {
    const result = await execute('once');
    await health.close();
    mailer.close();
    return result.ok ? 0 : 1;
  }

  // Scheduler: recursive setTimeout so a slow run never overlaps the next one.
  const scheduleNext = () => {
    if (shuttingDown) return;
    const jitter = Math.random() * config.schedule.jitterMs;
    const delay = config.schedule.intervalMs + jitter;
    runtime.nextRunAt = new Date(Date.now() + delay).toISOString();
    logger.debug('next check scheduled', { inMinutes: Number((delay / 60_000).toFixed(1)), at: runtime.nextRunAt });
    timer = setTimeout(() => {
      currentRun = execute('schedule').finally(scheduleNext);
    }, delay);
    timer.unref?.();
  };

  currentRun = execute('startup');
  await currentRun;
  scheduleNext();

  // Keep the event loop alive while waiting for the next scheduled run.
  await new Promise((resolve) => {
    const keepAlive = setInterval(() => {
      if (shuttingDown) {
        clearInterval(keepAlive);
        resolve();
      }
    }, 1_000);
  });

  return exitCode;
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
    // Give stdout a tick to flush before exiting in --once mode.
    setTimeout(() => process.exit(code), 50).unref();
  })
  .catch((error) => {
    console.error('fatal:', error?.stack ?? error);
    process.exit(1);
  });
