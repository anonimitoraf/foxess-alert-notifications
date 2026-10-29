/**
 * Scrape orchestration: launch a browser, authenticate, walk the configured
 * alert views, and return normalized alerts.
 */

import { buildUnreadSignalAlert, extractUnreadSignal, normalizeAlerts } from '../alerts.js';
import { createContext, launchBrowser, saveStorageState } from './browser.js';
import { attachNetworkCollector, collectDomTables, runPageActions, settlePage, writeDebugArtifacts } from './extract.js';
import { ensureLoggedIn } from './login.js';

/**
 * @returns {Promise<{
 *   alerts: import('../alerts.js').Alert[],
 *   ignored: import('../alerts.js').Alert[],
 *   sources: {label: string, url: string, rows: number}[],
 *   diagnostics: object,
 * }>}
 */
export async function scrapeAlerts(config, logger) {
  const startedAt = Date.now();
  const log = logger.child('scrape');
  let browser;
  let page;

  const collectedRows = [];
  const sources = [];
  let tables = [];
  let collector;

  try {
    browser = await launchBrowser(config, log);
    const context = await createContext(browser, config, log);
    page = await context.newPage();

    page.on('pageerror', (error) => log.debug('page error', { error: error.message }));
    page.on('console', (message) => {
      if (message.type() === 'error') log.debug('console error', { text: message.text().slice(0, 300) });
    });

    collector = attachNetworkCollector(page, config, log);

    const auth = await ensureLoggedIn(page, config, log);

    // The landing page after login can already contain alerts (dashboard cards).
    await settlePage(page, config, log);
    const landing = await collectDomTables(page);
    tables.push({ ...landing, label: 'landing' });
    sources.push({ label: 'landing', url: page.url(), rows: countRows(landing) });
    for (const table of landing.tables) collectedRows.push(...table.rows);

    const actionsResult = await runPageActions(page, config.foxess.pageActions, config, log);
    if (actionsResult.executed) {
      log.info('page actions executed', { ...actionsResult });
      await settlePage(page, config, log);
      const afterActions = await collectDomTables(page);
      tables.push({ ...afterActions, label: 'after-actions' });
      sources.push({ label: 'after-actions', url: page.url(), rows: countRows(afterActions) });
      for (const table of afterActions.tables) collectedRows.push(...table.rows);
    }

    for (const url of config.foxess.alertsUrls) {
      const label = routeLabel(url);
      if (page.url() === url) continue;
      try {
        log.info('visiting alert view', { url });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.foxess.navTimeoutMs });
        await settlePage(page, config, log);

        const result = await collectDomTables(page);
        tables.push({ ...result, label });
        const rows = result.tables.reduce((total, table) => total + table.rows.length, 0);
        sources.push({ label, url: page.url(), rows });
        for (const table of result.tables) collectedRows.push(...table.rows);

        if (rows === 0) {
          log.warn('alert view rendered no rows', {
            url: page.url(),
            emptyTexts: result.emptyTexts,
            hint: 'use DEBUG=true to dump the page, or FOXESS_PAGE_ACTIONS to drive filters',
          });
        }
      } catch (error) {
        log.warn('could not load alert view', { url, error: error.message });
        sources.push({ label, url, rows: 0, error: error.message });
      }
    }

    await collector.flush();
    const relevantPayloads = collector.relevant();
    if (relevantPayloads.length && collector.matchedCount() === 0) {
      log.warn('no alarm-shaped api responses matched ALERT_RESPONSE_URL_REGEX, falling back to every /c/v0 response', {
        responses: relevantPayloads.length,
        sample: relevantPayloads.slice(0, 5).map((entry) => entry.url),
      });
    }
    const { alerts, ignored, fromNetwork, fromDom } = normalizeAlerts(
      {
        payloads: relevantPayloads.map((entry) => ({ payload: entry.json, url: entry.url })),
        rows: collectedRows,
      },
      { now: new Date(), lookbackHours: config.alerts.lookbackHours },
    );

    // Last resort: some accounts only expose an unread badge, never the list.
    let finalAlerts = alerts;
    let unreadSignal = null;
    if (!alerts.length && config.alerts.signalFallback) {
      const signals = relevantPayloads
        .map((entry) => ({ ...(extractUnreadSignal(entry.json) ?? {}), url: entry.url }))
        .filter((signal) => Number.isFinite(signal.count))
        .sort((a, b) => b.count - a.count);

      if (signals.length) {
        unreadSignal = signals[0];
        if (unreadSignal.count > 0) {
          log.warn('no alert records found, but the site reported unread notifications', {
            count: unreadSignal.count,
            key: unreadSignal.key,
            url: unreadSignal.url,
          });
          finalAlerts = [
            buildUnreadSignalAlert(unreadSignal, { url: unreadSignal.url, now: new Date() }),
          ];
        }
      }
    }

    const diagnostics = {
      durationMs: Date.now() - startedAt,
      authenticated: auth.loggedIn,
      reusedSession: Boolean(auth.reused),
      apiResponsesCaptured: collector.payloads.length,
      apiResponsesUsed: relevantPayloads.length,
      domRows: collectedRows.length,
      alertsFromNetwork: fromNetwork.length,
      alertsFromDom: fromDom.length,
      alertsInWindow: finalAlerts.length,
      ignoredByLookback: ignored.length,
      tablesFound: tables.reduce((total, table) => total + table.tables.length, 0),
      unreadSignal: unreadSignal ? { count: unreadSignal.count, key: unreadSignal.key } : null,
    };

    if (!finalAlerts.length && config.foxess.debugDir) {
      await writeDebugArtifacts(page, { config, payloads: collector.payloads, tables, label: 'no-alerts' }, log);
    }

    if (auth.loggedIn) await saveStorageState(context, config.runtime.sessionFile, log);

    return { alerts: finalAlerts, ignored, sources, diagnostics };
  } catch (error) {
    // A failed run is exactly when a screenshot is worth its weight in gold.
    if (config.foxess.debugDir && page) {
      await writeDebugArtifacts(
        page,
        {
          config,
          payloads: collector?.payloads ?? [],
          tables,
          label: `error-${error.name || 'failure'}`,
        },
        log,
      );
    }
    throw error;
  } finally {
    collector?.detach?.();
    if (browser) {
      await browser.close().catch((error) => log.debug('browser close failed', { error: error.message }));
    }
  }
}

function countRows(result) {
  return result.tables.reduce((total, table) => total + table.rows.length, 0);
}

function routeLabel(url) {
  try {
    const parsed = new URL(url);
    const hash = parsed.hash.replace(/^#\/?/, '');
    return hash || parsed.pathname.replace(/^\//, '') || 'page';
  } catch {
    return 'page';
  }
}
