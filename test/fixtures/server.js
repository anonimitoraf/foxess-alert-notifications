/**
 * A miniature FoxESS-Cloud-shaped site used by the end-to-end test.
 *
 * It intentionally mimics the parts the scraper depends on:
 *  - a hash routed SPA that redirects away from /#/login when a token exists,
 *  - element-ui-ish markup (`#app` shell, inputs, submit button),
 *  - a signed-looking JSON endpoint (`/c/v0/alarm/query`) the page itself calls,
 *  - a rendered alarm table so the DOM fallback has something to read.
 */

import { createServer } from 'node:http';

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatLocal(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

export function buildAlarms(now = new Date()) {
  const minutesAgo = (minutes) => formatLocal(new Date(now.getTime() - minutes * 60_000));
  return [
    {
      alarmName: 'Grid Loss',
      deviceSN: 'SN-0001',
      plantName: 'Home Roof',
      occurTime: minutesAgo(35),
      level: 'Fault',
    },
    {
      alarmName: 'Battery Low Temperature',
      deviceSN: 'SN-0001',
      plantName: 'Home Roof',
      occurTime: minutesAgo(120),
      level: 'Warning',
    },
    // Outside the 24h lookback window: must never be emailed.
    {
      alarmName: 'Old Communication Lost',
      deviceSN: 'SN-0002',
      plantName: 'Home Roof',
      occurTime: minutesAgo(60 * 24 * 5),
      level: 'Fault',
    },
  ];
}

function renderLogin() {
  return `
    <div class="login-form">
      <h1>Sign in</h1>
      <form id="login-form">
        <input name="username" type="text" placeholder="Email" autocomplete="username" />
        <input name="password" type="password" placeholder="Password" autocomplete="current-password" />
        <button type="submit">Log in</button>
      </form>
    </div>`;
}

function renderApp() {
  return `
    <div class="app-shell">
      <h1>Welcome back</h1>
      <div id="alarm-container"><span class="el-table__empty-text">Loading…</span></div>
    </div>`;
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>FoxESS</title><style>body{font-family:sans-serif}</style></head>
<body>
<div id="app"></div>
<script>
  const app = document.getElementById('app');
  const token = () => localStorage.getItem('token');

  function render() {
    if (!token()) { app.innerHTML = ${JSON.stringify(renderLogin())}; wire(); return; }
    if (location.pathname === '/login') history.replaceState(null, '', '/bus/index');
    app.innerHTML = ${JSON.stringify(renderApp())};
    loadAlarms();
  }

  function wire() {
    const form = document.getElementById('login-form');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const res = await fetch('/c/v0/user/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', signature: 'fixture-signature' },
        body: JSON.stringify({ user: data.get('username'), password: data.get('password') }),
      });
      const body = await res.json();
      if (body.errno === 0) {
        localStorage.setItem('token', body.result.token);
        localStorage.setItem('lang', 'en');
        history.replaceState(null, '', '/bus/index');
        render();
      } else {
        const error = document.createElement('div');
        error.className = 'el-message el-message--error';
        error.textContent = body.msg;
        document.body.appendChild(error);
      }
    });
  }

  async function loadAlarms() {
    const container = document.getElementById('alarm-container');
    if (!container) return;
    const res = await fetch('/c/v0/alarm/query', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        token: token(),
        signature: 'fixture-signature',
      },
      body: JSON.stringify({ currentPage: 1, pageSize: 10 }),
    });
    const body = await res.json();
    const rows = (body.result && body.result.data) || [];
    if (!rows.length) { container.innerHTML = '<span class="el-table__empty-text">No Data</span>'; return; }
    const header = '<tr><th>Time</th><th>Site</th><th>Device</th><th>Alarm</th><th>Level</th></tr>';
    const bodyRows = rows
      .map((row) => '<tr>' + [row.occurTime, row.plantName, row.deviceSN, row.alarmName, row.level]
        .map((cell) => '<td><div class="cell">' + String(cell ?? '') + '</div></td>').join('') + '</tr>')
      .join('');
    container.innerHTML = '<div class="el-table"><div class="el-table__header-wrapper"><table><thead>' + header +
      '</thead></table></div><div class="el-table__body-wrapper"><table><tbody>' + bodyRows + '</tbody></table></div></div>';
  }

  window.addEventListener('hashchange', render);
  window.addEventListener('popstate', render);
  render();
</script>
</body>
</html>`;

export async function startFixtureServer({ port = 0, alarms } = {}) {
  const alarmRows = alarms ?? buildAlarms();
  const state = { loginAttempts: 0, alarmQueries: 0, lastCredentials: null };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/c/v0/user/login' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        state.loginAttempts += 1;
        try {
          state.lastCredentials = JSON.parse(raw);
        } catch {
          state.lastCredentials = null;
        }
        const credentials = state.lastCredentials ?? {};
        // `wrong` simulates a rejected password so the login error path is covered.
        const ok = Boolean(credentials.user && credentials.password) && credentials.password !== 'wrong';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            ok ? { errno: 0, result: { token: 'fixture-token' } } : { errno: 41808, msg: 'Invalid credentials' },
          ),
        );
      });
      return;
    }

    if (url.pathname === '/c/v0/alarm/query') {
      state.alarmQueries += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errno: 0, result: { currentPage: 1, pageSize: 10, total: alarmRows.length, data: alarmRows } }));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();

  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    alarms: alarmRows,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
