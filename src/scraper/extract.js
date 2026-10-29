/**
 * Extraction helpers.
 *
 * Two independent collectors run while the authenticated app is being browsed:
 *
 *  1. `attachNetworkCollector` - records the JSON responses the SPA itself makes
 *     (`/c/v0/...`). This is the highest fidelity source: it is the same data
 *     the UI renders, but structured.
 *  2. `collectDomTables` - reads the rendered tables. Fallback for views whose
 *     data is embedded in HTML, or that build rows from memory.
 *
 * Neither is tied to a specific FoxESS release; both are heuristic by design.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveRoute } from '../config.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function attachNetworkCollector(page, config, logger) {
  const payloads = [];
  const skipped = [];
  const pending = new Set();

  const handle = async (response) => {
    const url = response.url();
    if (!/\/c\/v\d+\//.test(url)) return;
    if (config.foxess.ignoreResponseUrlPattern?.test(url)) return;

    const contentType = (response.headers()['content-type'] ?? '').toLowerCase();
    if (!contentType.includes('json')) return;

    let json;
    try {
      json = await response.json();
    } catch {
      return;
    }

    const serializedLength = (() => {
      try {
        return JSON.stringify(json).length;
      } catch {
        return 0;
      }
    })();
    if (serializedLength > MAX_BODY_BYTES) {
      skipped.push({ url, reason: 'payload too large', bytes: serializedLength });
      return;
    }

    const matchesPattern = config.foxess.responseUrlPattern.test(url);
    payloads.push({ url, status: response.status(), json, matchesPattern });
    logger.debug('captured api response', { url, status: response.status(), bytes: serializedLength });
  };

  const handler = (response) => {
    // Response bodies are read asynchronously; keep the promises so the caller
    // can drain them before reading `payloads`.
    const task = handle(response)
      .catch((error) => logger.debug('could not read response', { error: error.message }))
      .finally(() => pending.delete(task));
    pending.add(task);
  };

  page.on('response', handler);
  return {
    payloads,
    skipped,
    detach: () => page.off('response', handler),
    flush: async () => {
      while (pending.size) await Promise.allSettled([...pending]);
    },
    /** Payloads whose URL looked alarm/notification related (preferred). */
    relevant() {
      const matched = payloads.filter((entry) => entry.matchesPattern);
      return matched.length ? matched : payloads;
    },
    matchedCount() {
      return payloads.filter((entry) => entry.matchesPattern).length;
    },
  };
}

/**
 * Reads every rendered table into `{ headers, rows: [{ headers, cells, pageUrl }] }`.
 * Runs inside the browser, so it must stay self-contained.
 */
export async function collectDomTables(page) {
  return page.evaluate(() => {
    const clean = (value) => (value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

    const headerTexts = (root) => {
      const selectors = [
        '.el-table__header-wrapper thead th',
        'thead th',
        '.el-table__header th',
        '[role="columnheader"]',
      ];
      for (const selector of selectors) {
        const cells = Array.from(root.querySelectorAll(selector));
        if (!cells.length) continue;
        return cells.map((cell) => clean(cell.innerText || cell.textContent));
      }
      return [];
    };

    const rowTexts = (root) => {
      const selectors = ['tbody tr', '.el-table__body-wrapper tbody tr', '[role="row"]'];
      for (const selector of selectors) {
        const rows = Array.from(root.querySelectorAll(selector));
        if (!rows.length) continue;
        return rows
          .filter((row) => !row.querySelector('.el-table__empty-text'))
          .map((row) => {
            const cellSelectors = ['td', '.el-table__cell', '[role="cell"]', '[role="gridcell"]'];
            for (const cellSelector of cellSelectors) {
              const cells = Array.from(row.querySelectorAll(cellSelector));
              if (!cells.length) continue;
              return cells.map((cell) => clean(cell.innerText || cell.textContent));
            }
            return [];
          })
          .filter((cells) => cells.length > 0);
      }
      return [];
    };

    const pageUrl = window.location.href;
    const tables = [];

    // element-ui renders its own header table; plain <table> is handled too.
    const roots = Array.from(document.querySelectorAll('.el-table, table'));
    const seen = new Set();

    for (const root of roots) {
      if (root.closest('table') && root.tagName.toLowerCase() === 'table' && root.closest('.el-table')) continue;
      if (root.parentElement?.closest('.el-table')) continue;

      const headers = headerTexts(root);
      const rows = rowTexts(root);
      if (!rows.length) continue;

      // De-duplicate identical row cell arrays (fixed columns clone rows).
      const uniqueRows = [];
      const rowSignatures = new Set();
      for (const cells of rows) {
        const signature = cells.join('\u0001');
        if (rowSignatures.has(signature)) continue;
        rowSignatures.add(signature);
        uniqueRows.push({ headers, cells, pageUrl });
      }

      const signature = `${headers.join('|')}::${uniqueRows.length}`;
      if (seen.has(signature)) continue;
      seen.add(signature);

      tables.push({ headers, rows: uniqueRows });
    }

    const emptyTexts = Array.from(document.querySelectorAll('.el-table__empty-text, .ant-empty-description, .no-data'))
      .map((node) => clean(node.innerText || node.textContent))
      .filter(Boolean);

    return { tables, emptyTexts, pageUrl, title: document.title };
  });
}

/**
 * Executes the optional `FOXESS_PAGE_ACTIONS` JSON DSL after login, e.g.
 *
 *   [{"goto":"/bus/alarm"},
 *    {"fill":{"selector":"input[placeholder*='SN']","value":"MY-SERIAL"}},
 *    {"click":".el-button--primary"},
 *    {"wait":2000}]
 *
 * Failures are logged as warnings instead of aborting: the storage of a UI
 * detail must not stop alerting.
 */
export async function runPageActions(page, actions, config, logger) {
  if (!Array.isArray(actions) || actions.length === 0) return { executed: 0, failed: 0 };

  let executed = 0;
  let failed = 0;

  const resolveUrl = (value) => resolveRoute(config.foxess.baseUrl, value);

  for (const [index, action] of actions.entries()) {
    try {
      if (action.goto) {
        await page.goto(resolveUrl(action.goto), { waitUntil: 'domcontentloaded', timeout: config.foxess.navTimeoutMs });
        await page.waitForTimeout(config.foxess.settleMs);
      } else if (action.fill) {
        const { selector, value, env } = action.fill;
        const resolved = env ? process.env[env] : value;
        if (!resolved) throw new Error(`fill action has no value (selector=${selector}, env=${env})`);
        const locator = page.locator(selector).first();
        await locator.waitFor({ state: 'visible', timeout: 15_000 });
        await locator.fill(String(resolved), { timeout: 15_000 });
      } else if (action.click) {
        const selectors = Array.isArray(action.click) ? action.click : [action.click];
        let clicked = false;
        for (const selector of selectors) {
          const locator = page.locator(selector).first();
          if ((await locator.count()) === 0) continue;
          await locator.click({ timeout: 15_000 });
          clicked = true;
          break;
        }
        if (!clicked) throw new Error(`no clickable element for: ${selectors.join(', ')}`);
      } else if (action.press) {
        await page.keyboard.press(action.press);
      } else if (action.waitFor) {
        await page.waitForSelector(action.waitFor, { timeout: action.timeout ?? 30_000 });
      } else if (action.wait !== undefined) {
        await page.waitForTimeout(Number(action.wait) || 0);
      } else if (action.scrollToBottom) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      } else {
        throw new Error(`unknown action: ${JSON.stringify(action)}`);
      }
      executed += 1;
    } catch (error) {
      failed += 1;
      logger.warn('page action failed', { index, action: JSON.stringify(action), error: error.message });
    }
  }

  return { executed, failed };
}

/** Waits for the SPA to stop churning, without failing when it never idles. */
export async function settlePage(page, config, logger) {
  try {
    await page.waitForLoadState('networkidle', { timeout: Math.min(config.foxess.navTimeoutMs, 20_000) });
  } catch {
    logger.debug('network never went idle, continuing');
  }
  await page.waitForTimeout(config.foxess.settleMs);
}

/** Persists screenshot/HTML/payload dumps so selectors can be fixed after a site change. */
export async function writeDebugArtifacts(page, { config, payloads, tables, label }, logger) {
  const dir = config.foxess.debugDir;
  if (!dir) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(dir, `${stamp}-${label.replace(/[^a-z0-9_-]+/gi, '-')}`);

  try {
    await mkdir(target, { recursive: true });
    await page.screenshot({ path: join(target, 'screenshot.png'), fullPage: true }).catch(() => {});
    await writeFile(join(target, 'page.html'), await page.content(), 'utf8').catch(() => {});
    await writeFile(join(target, 'tables.json'), JSON.stringify(tables, null, 2), 'utf8');
    await writeFile(
      join(target, 'payloads.json'),
      JSON.stringify(
        payloads.map((entry) => ({ url: entry.url, status: entry.status, body: entry.json })),
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(join(target, 'meta.json'), JSON.stringify({ url: page.url(), title: await page.title() }, null, 2));
    logger.info('debug artifacts written', { dir: target });
    return target;
  } catch (error) {
    logger.warn('could not write debug artifacts', { error: error.message });
    return null;
  }
}
