/**
 * Login flow.
 *
 * FoxESS Cloud is a Vue/Vuex SPA (`element-ui` inputs) behind a hash router and
 * a WASM request signer. Rather than re-implementing that signer we drive the
 * real UI, exactly like a human would.
 *
 * The site markup is not contractual, so every step uses an ordered list of
 * candidate selectors and falls back to structural heuristics (first visible
 * text input before the password field, Enter key submit, ...).
 */

const USERNAME_SELECTORS = [
  'input[autocomplete="username"]',
  'input[name="username"]',
  'input[name="userName"]',
  'input[name="account"]',
  'input[name="email"]',
  'input[name="user"]',
  'input[id="username"]',
  'input[id="userName"]',
  'input[id*="user" i]',
  'input[type="email"]',
  'input[type="tel"]',
  'input[placeholder*="mail" i]',
  'input[placeholder*="account" i]',
  'input[placeholder*="user" i]',
  'input[placeholder*="邮箱"]',
  'input[placeholder*="账号"]',
  'input[placeholder*="用户名"]',
];

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name*="pass" i]',
  'input[id*="pass" i]',
  'input[autocomplete="current-password"]',
];

const SUBMIT_SELECTORS = [
  'form button[type="submit"]',
  'button[type="submit"]',
  '.login-form button',
  '.el-form button.el-button--primary',
  'button.el-button--primary',
  '.login-btn',
  '[class*="login"] button',
  'button:has-text("Log in")',
  'button:has-text("Login")',
  'button:has-text("Sign in")',
  'button:has-text("Sign In")',
  'button:has-text("登录")',
  'button:has-text("登 录")',
];

const LOGGED_IN_URL = /\/(bus|plant|device|index|dashboard|overview|user\/center)/i;
const LOGIN_URL = /login|signin|sign-in/i;

/** Evaluates login markers in the page (token in storage, or a non-login shell). */
export async function detectSession(page) {
  try {
    return await page.evaluate(() => {
      const out = { token: null, user: null, onLoginRoute: /login|signin|sign-in/i.test(window.location.href) };
      try {
        const candidates = ['token', 'Token', 'access_token', 'accessToken', 'Authorization'];
        for (const key of candidates) {
          const value = window.localStorage.getItem(key);
          if (value) {
            out.token = value;
            break;
          }
        }
        const rawUser = window.localStorage.getItem('userInfo') || window.localStorage.getItem('user');
        if (rawUser) out.user = rawUser.slice(0, 120);
        out.hasApp = Boolean(
          document.querySelector('#app')?.childElementCount ||
            document.querySelector('#root')?.childElementCount ||
            document.querySelector('.el-container, .el-menu, .app-main, [class*="layout"]'),
        );
      } catch {
        /* storage can throw in some contexts */
      }
      const cookies = document.cookie || '';
      out.hasCookie = /(session|token|sid)=/i.test(cookies);
      return out;
    });
  } catch {
    return { token: null, user: null, onLoginRoute: true, hasApp: false, hasCookie: false };
  }
}

export async function isLoggedIn(page) {
  const session = await detectSession(page);
  if (!session.onLoginRoute && (session.token || session.hasCookie) && session.hasApp) return true;
  if (session.token && !session.onLoginRoute) return true;
  return false;
}

async function fillFirst(page, selectors, value, logger) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) === 0) continue;
      if (!(await locator.isVisible().catch(() => false))) continue;
      await locator.click({ timeout: 5_000 }).catch(() => {});
      await locator.fill(value, { timeout: 10_000 });
      logger.debug('filled field', { selector });
      return selector;
    } catch (error) {
      logger.debug('selector failed', { selector, error: error.message });
    }
  }
  return null;
}

/** Last resort: fill the visible text input that sits next to the password field. */
async function fillUsernameByPosition(page, value, logger) {
  const inputs = page.locator('input:visible');
  const count = await inputs.count();
  let passwordIndex = -1;
  for (let i = 0; i < count; i += 1) {
    const type = (await inputs.nth(i).getAttribute('type')) ?? 'text';
    if (type === 'password') {
      passwordIndex = i;
      break;
    }
  }
  const limit = passwordIndex === -1 ? count : passwordIndex;
  for (let i = 0; i < limit; i += 1) {
    const input = inputs.nth(i);
    const type = (await input.getAttribute('type')) ?? 'text';
    if (!['text', 'email', 'tel', ''].includes(type)) continue;
    await input.fill(value).catch(() => {});
    const actual = await input.inputValue().catch(() => '');
    if (actual === value) {
      logger.debug('filled username by position', { index: i });
      return true;
    }
  }
  return false;
}

async function clickSubmit(page, logger) {
  for (const selector of SUBMIT_SELECTORS) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) === 0) continue;
      if (!(await locator.isVisible().catch(() => false))) continue;
      const enabled = await locator.isEnabled().catch(() => false);
      if (!enabled) continue;
      await locator.click({ timeout: 10_000 });
      logger.debug('clicked submit', { selector });
      return true;
    } catch (error) {
      logger.debug('submit selector failed', { selector, error: error.message });
    }
  }
  logger.debug('no submit button found, pressing Enter');
  await page.keyboard.press('Enter').catch(() => {});
  return true;
}

async function readErrorMessage(page) {
  const candidates = [
    '.el-message--error',
    '.el-message',
    '[class*="toast"]',
    '[class*="error-msg"]',
    '[class*="errorTip"]',
    '.el-alert__title',
    '[role="alert"]',
  ];
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) === 0) continue;
      const text = (await locator.innerText({ timeout: 2_000 })).trim();
      if (text) return text.replace(/\s+/g, ' ').slice(0, 300);
    } catch {
      /* ignore */
    }
  }
  return null;
}

class LoginError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LoginError';
    this.details = details;
  }
}

/**
 * Logs in if the current session is not already authenticated.
 * Returns `{ loggedIn: boolean, reused: boolean, usernameSelector?, submitVia? }`.
 */
export async function ensureLoggedIn(page, config, logger) {
  const { foxess } = config;

  await page.goto(foxess.loginUrl, { waitUntil: 'domcontentloaded', timeout: foxess.navTimeoutMs });

  // Give the SPA a moment: a valid session redirects away from /#/login.
  await page.waitForTimeout(1_500);
  if (await isLoggedIn(page)) {
    logger.info('existing session is still valid, skipping login');
    return { loggedIn: true, reused: true };
  }

  // If we landed somewhere that is not a login form, the app may simply have
  // restored a session on a different route.
  const hasPasswordField = (await page.locator('input[type="password"]').count()) > 0;
  if (!hasPasswordField) {
    await page.waitForSelector('input[type="password"]', { timeout: 15_000 }).catch(() => {});
  }

  const stillNoPassword = (await page.locator('input[type="password"]').count()) === 0;
  if (stillNoPassword) {
    if (await isLoggedIn(page)) return { loggedIn: true, reused: true };
    throw new LoginError(
      'Login form not found: no password input appeared on the login page. ' +
        'Set DEBUG=true to capture a screenshot + HTML dump and check FOXESS_LOGIN_ROUTE.',
      { url: page.url() },
    );
  }

  logger.info('logging in', { url: page.url(), username: config.foxess.username });
  const usernameSelector = await fillFirst(page, USERNAME_SELECTORS, foxess.username, logger);
  if (!usernameSelector) {
    const ok = await fillUsernameByPosition(page, foxess.username, logger);
    if (!ok) throw new LoginError('Could not locate the username field on the login page.', { url: page.url() });
  }

  const passwordSelector = await fillFirst(page, PASSWORD_SELECTORS, foxess.password, logger);
  if (!passwordSelector) throw new LoginError('Could not locate the password field on the login page.', { url: page.url() });

  await clickSubmit(page, logger);

  const deadline = Date.now() + foxess.loginTimeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);

    if (await isLoggedIn(page)) {
      logger.info('login successful', { url: page.url() });
      return { loggedIn: true, reused: false, usernameSelector, passwordSelector };
    }

    const error = await readErrorMessage(page);
    if (error) {
      throw new LoginError(`Login rejected by FoxESS Cloud: ${error}`, { url: page.url() });
    }
  }

  const onLogin = LOGIN_URL.test(page.url());
  throw new LoginError(
    onLogin
      ? 'Login timed out: still on the login page after submitting credentials. ' +
        'Check FOXESS_USERNAME/FOXESS_PASSWORD, or whether the account requires 2FA/CAPTCHA.'
      : 'Login timed out waiting for the authenticated app to load.',
    { url: page.url(), matchesLoggedInUrl: LOGGED_IN_URL.test(page.url()) },
  );
}

export { LoginError };
