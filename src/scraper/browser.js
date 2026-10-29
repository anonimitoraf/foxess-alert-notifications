/**
 * Browser plumbing: launching Chromium and opening a context that reuses a
 * previously saved FoxESS session when one exists.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
export async function launchBrowser(config, logger) {
  const { foxess } = config;
  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    // FoxESS renders charts on the dashboard; nothing we need, keep it cheap.
    '--blink-settings=imagesEnabled=true',
  ];

  const browser = await chromium.launch({
    headless: foxess.headless,
    args,
    proxy: foxess.proxyUrl ? { server: foxess.proxyUrl } : undefined,
    timeout: foxess.navTimeoutMs,
  });

  logger.debug('chromium launched', { headless: foxess.headless, version: browser.version?.() });
  return browser;
}

export async function readStorageState(file, logger) {
  try {
    const raw = await readFile(file, 'utf8');
    const state = JSON.parse(raw);
    if (!state || typeof state !== 'object') return undefined;
    logger.debug('reusing saved browser session', { file });
    return state;
  } catch (error) {
    if (error.code !== 'ENOENT') logger.debug('could not read saved session', { file, error: error.message });
    return undefined;
  }
}

export async function saveStorageState(context, file, logger) {
  try {
    await mkdir(dirname(file), { recursive: true });
    const state = await context.storageState();
    await writeFile(file, JSON.stringify(state, null, 2), 'utf8');
    logger.debug('browser session saved', { file });
  } catch (error) {
    logger.warn('could not save browser session', { file, error: error.message });
  }
}

export async function createContext(browser, config, logger) {
  const storageState = await readStorageState(config.runtime.sessionFile, logger);

  // Present a plain desktop Chrome UA that matches the bundled engine version:
  // the default headless UA advertises "HeadlessChrome", which some front doors
  // reject, while a stale hard-coded version is its own fingerprint.
  const major = String(browser.version?.() ?? '').split('.')[0] || '141';

  const context = await browser.newContext({
    storageState,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: config.foxess.timezone || undefined,
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    ignoreHTTPSErrors: false,
  });
  context.setDefaultTimeout(config.foxess.navTimeoutMs);
  context.setDefaultNavigationTimeout(config.foxess.navTimeoutMs);
  return context;
}
