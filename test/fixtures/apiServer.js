/**
 * A fake FoxESS Cloud web API for tests.
 *
 * Mirrors the endpoints the real client uses, including pagination, token
 * handling, alarm filtering by date range (so history chunking is exercised)
 * and request recording for assertions.
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const md5 = (value) => createHash('md5').update(String(value)).digest('hex');

const TOKEN = 'biz-web-11111111-2222-3333-4444-555555555555';

export function alarm(overrides = {}) {
  return {
    device: '60KBEXAMPLE00001',
    severity: '--',
    code: '26',
    msg: 'Grid Voltage Fault',
    category: 'Inverter',
    date: '2026-07-08 13:30:37 AEST',
    recoveryDate: '2026-07-08 13:36:37 AEST',
    ...overrides,
  };
}

export async function startApiServer(options = {}) {
  const {
    username = 'owner@example.com',
    password = 'secret',
    userInfo = { email: username, name: 'Owner' },
    plants = [{ plantID: 'plant-1', plantName: 'Home Roof', timezone: 'Australia/Melbourne' }],
    activeAlarms = {},
    historyAlarms = {},
    refreshedToken = null,
    failPaths = {},
    ignoreDateFilter = false,
    plantDetails = {},
  } = options;

  const state = {
    requests: [],
    loginCalls: 0,
    historyCalls: 0,
    failNextAuth: false,
    token: TOKEN,
  };

  const send = (res, status, payload, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(payload));
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : null);
        } catch {
          resolve(null);
        }
      });
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = req.method === 'POST' ? await readBody(req) : null;
    state.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });

    if (url.pathname === '/foxess/biz/auth/login' || url.pathname === '/basic/v0/user/login') {
      state.loginCalls += 1;
      const account = body?.account ?? body?.user;
      const passwordOk = body?.password === md5(password);
      if (account !== username || !passwordOk) {
        send(res, 200, { errno: 41807, msg: 'Wrong user name or password' });
        return;
      }
      send(res, 200, { errno: 0, msg: 'Operation successful', result: { token: TOKEN } });
      return;
    }

    if (url.pathname.startsWith('/c/') || url.pathname.startsWith('/dew/') || url.pathname.startsWith('/basic/')) {
      const token = req.headers.token;
      if (state.failNextAuth) {
        state.failNextAuth = false;
        send(res, 200, { errno: 41819, msg: 'Unauthorized' });
        return;
      }
      if (token !== state.token) {
        send(res, 200, { errno: 41819, msg: 'Unauthorized' });
        return;
      }
    }

    if (failPaths[url.pathname]) {
      send(res, 200, { errno: failPaths[url.pathname].errno, msg: failPaths[url.pathname].msg });
      return;
    }

    if (url.pathname === '/basic/w/v0/user/info') {
      send(res, 200, { errno: 0, msg: 'Operation successful', result: userInfo });
      return;
    }

    if (url.pathname === '/dew/w/v0/plant/list') {
      const page = Number(body?.page ?? 1);
      const size = Number(body?.size ?? 20);
      const slice = plants.slice((page - 1) * size, page * size);
      send(
        res,
        200,
        {
          errno: 0,
          msg: 'Operation successful',
          result: { total: plants.length, data: slice },
        },
        refreshedToken ? { 'refreshed-token': refreshedToken } : {},
      );
      return;
    }

    if (url.pathname === '/dew/w/v0/plant/detail') {
      // Real responses nest the plant under result.info; `plant/list` has no timezone.
      const plantID = url.searchParams.get('plantID');
      const plant = plants.find((entry) => (entry.plantID ?? entry.id) === plantID);
      if (!plant) {
        send(res, 200, { errno: 40004, msg: 'Plant not found' });
        return;
      }
      const info =
        plantDetails[plantID] ??
        { plantId: plantID, plantName: plant.plantName ?? plant.name, timezone: plant.timezone };
      send(res, 200, { errno: 0, msg: 'Operation successful', result: { info } });
      return;
    }

    if (url.pathname === '/dew/w/v0/plant/alarm') {
      const plantID = body?.plantID;
      const alarms = activeAlarms[plantID] ?? [];
      send(res, 200, {
        errno: 0,
        msg: 'Operation successful',
        result: { alarmCount: alarms.length, alarmList: alarms, display: alarms.length > 0, updateTime: '2026-10-26 10:00:00 AEDT' },
      });
      return;
    }

    if (url.pathname === '/dew/w/v0/plant/historyAlarm') {
      state.historyCalls += 1;
      const plantID = body?.plantID;
      const begin = `${body?.begin?.year}-${body?.begin?.month}-${body?.begin?.day}`;
      const end = `${body?.end?.year}-${body?.end?.month}-${body?.end?.day}`;
      const alarms = (historyAlarms[plantID] ?? []).filter((entry) => {
        if (ignoreDateFilter) return true;
        const day = String(entry.date).slice(0, 10);
        return day >= begin && day <= end;
      });
      send(res, 200, {
        errno: 0,
        msg: 'Operation successful',
        result: { alarmCount: alarms.length, alarmList: alarms },
      });
      return;
    }

    send(res, 404, { errno: 40400, msg: `Unknown endpoint ${url.pathname}` });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    token: TOKEN,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
