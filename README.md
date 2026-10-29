# foxess-alert-notifications

Checks a [FoxESS Cloud](https://www.foxesscloud.com) account for alerts and emails you when something
is wrong. Talks to the same HTTPS API the web app uses — **no browser, no scraping** — and falls back to
a headless-browser mode only if you ask for it.

```
┌────────────┐   HTTPS (signed)   ┌────────────────────┐   new alerts    ┌───────┐   ┌──────────┐
│ scheduler  │ ─────────────────► │ foxesscloud.com API│ ──────────────► │ dedupe│ ─► │ SMTP      │
│ (interval) │  login → plants    │  /dew/w/v0/...     │   (state.json)  │ email │   │ mailbox   │
└────────────┘     → alarms       └────────────────────┘                 └───────┘   └──────────┘
```

A check takes about **1.5 seconds** and the container image is **~180MB** (Node only).

---

## Quick start (Docker)

```bash
git clone <this repo> && cd foxess-alert-notifications

cp .env.example .env
$EDITOR .env            # FOXESS_USERNAME, FOXESS_PASSWORD, SMTP_*, MAIL_TO

docker compose up -d --build
docker compose logs -f
```

See the result without sending any mail:

```bash
docker compose run --rm -e DRY_RUN=true -e LOG_LEVEL=debug \
  foxess-alerts node src/index.js --once
```

Configuration is validated at startup; a missing `MAIL_TO` or `SMTP_HOST` fails immediately with a
message naming the variable. The container runs as uid `1000`; if you replace the named volume with a
bind mount, create it with `mkdir -p ./data && sudo chown 1000:1000 ./data`.

### Run once a day instead of polling

```cron
0 7 * * * docker run --rm --env-file /srv/foxess/.env -v foxess-data:/data foxess-alert-notifications:latest node src/index.js --once
```

---

## How the API works (reverse engineered, verified live)

The site at `www.foxesscloud.com` is a Vue SPA (`FOX_CLOUD_WEB_2_0`) that talks to these endpoints:

| Purpose | Request | Notes |
| --- | --- | --- |
| Login | `POST /foxess/biz/auth/login` | `{ account, password: md5(password) }` → `result.token` |
| Login (US stack) | `POST /basic/v0/user/login` | `{ user, password: md5(password), type: 1, verification: 1 }` — used automatically if the first returns 404; US accounts also need `FOXESS_BASE_URL=https://us.foxesscloud.com` |
| Session check | `GET /basic/w/v0/user/info` | cheap way to validate a token |
| Plants | `POST /dew/w/v0/plant/list` | `{ page, size, fuzzyCondition, status: 0, exportFlag: false }` |
| Active alarms | `POST /dew/w/v0/plant/alarm` | `{ plantID }` → `result.alarmList`, `result.alarmCount` |
| Alarm history | `POST /dew/w/v0/plant/historyAlarm` | `{ plantID, begin:{year,month,day}, end:{…}, realtimeFlag: false }` |

Every call carries the headers the SPA sends: `lang`, `token`, `timezone`, `platform`,
`X-Auth-Platform: FOX_CLOUD_WEB_2_0`, `dt`, `timestamp` and `signature`.

Things worth knowing (all verified against the live API):

* **The password is sent as an unsalted MD5** of the plaintext. That is the site's own scheme, not a
  choice made here — treat tokens like passwords.
* **The `signature` header is currently not validated.** A garbage value, a missing value and a
  timestamp from 1970 all return `errno: 0`. Only the token is checked (`41819 Unauthorized` when it is
  missing). We still generate a correct signature, byte-identical to the browser's, by running the
  site's own WASM module (`/v2/js/signature.js` + `signature.wasm`, cached under `SIGNER_CACHE_DIR`), so
  the tool keeps working if that is ever enforced. `FOXESS_SIGNATURE=off` skips the download.
* **History queries silently return nothing for wide ranges.** The web UI caps its date picker at 14
  days; the API behaves the same way. `listHistoryAlarms` therefore walks the range in ≤14-day windows
  (`FOXESS_HISTORY_CHUNK_DAYS`) and merges the results.
* **Timestamps are plant-local with a display suffix**, e.g. `2026-07-08 13:30:37 AEST`. Those
  abbreviations are ambiguous (`AEST`/`AEDT`, three different `CST`s), so the suffix is ignored and the
  wall clock is interpreted in the plant's IANA timezone from `plant/list`.
* Alarm records look like this: `{ device, severity, code, msg, category, date, recoveryDate }`; the
  alert identity is `plant + device + category + code + date`, so the same fault seen in both the active
  and the history view is emailed once.

---

## What gets emailed

`FOXESS_ALERT_SCOPE` decides what counts as an alert:

| Value | Meaning |
| --- | --- |
| `active` | Only faults that are happening right now (never aged out, even if the start date is old) |
| `history` | Faults that occurred within `ALERT_LOOKBACK_HOURS`, including ones that already recovered |
| `both` *(default)* | Union of the two; duplicates collapse |

`state.json` records every alert identity ever emailed, so with the default `NOTIFY_MODE=new` a
30-minute poll sends an inverter fault **once** rather than 48 times a day. `NOTIFY_MODE=all` re-sends
the current state on every run (useful as a heartbeat).

Emails contain a severity summary, one row per alert (time, plant, device, category, code, recovery
time) and a link to the alarm view. Severity comes from the site's level field when present, otherwise
from the message (`Fault`/`Error` → critical, `Warning` → warning, `Notice` → info) and defaults to
`unknown` — which is **not** dropped, because a fault we cannot classify is still a fault.

---

## Configuration

Everything is read from the environment. Defaults in brackets.

### FoxESS account

| Variable | Description |
| --- | --- |
| `FOXESS_USERNAME` | Account e-mail / username |
| `FOXESS_PASSWORD` | Account password (hashed with MD5 before sending, like the site does) |
| `FOXESS_MODE` | [`api`] `api` (HTTP) or `browser` (headless Chromium fallback) |
| `FOXESS_BASE_URL` | [`https://www.foxesscloud.com`] |
| `FOXESS_TOKEN` | Optional: use an existing token instead of logging in |
| `FOXESS_PLANT_IDS` | Optional: only check these plants (ids or names, comma separated) |
| `FOXESS_ALERT_SCOPE` | [`both`] `active`, `history` or `both` |
| `FOXESS_HISTORY_CHUNK_DAYS` | [`14`] History window size (the API rejects wider ranges) |
| `FOXESS_LANG` | [`en`] `lang` header and signature input |
| `FOXESS_TIMEZONE` | Optional: fallback zone when a plant does not report one |
| `FOXESS_SIGNATURE` | [`auto`] `auto` = run the site's WASM signer, `off` = placeholder signature |
| `API_TIMEOUT_MS` | [`30000`] Per-request timeout |

### Email

| Variable | Description |
| --- | --- |
| `MAIL_TO` | Comma separated recipients |
| `MAIL_CC` | Optional carbon copies |
| `SMTP_HOST`, `SMTP_PORT` | SMTP server, port defaults to `587` |
| `SMTP_SECURE` | Implicit TLS; defaults to `true` when the port is `465` |
| `SMTP_REQUIRE_TLS` | Force STARTTLS [`false`] |
| `SMTP_REJECT_UNAUTHORIZED` | Verify the server certificate [`true`] |
| `SMTP_USER`, `SMTP_PASS` | SMTP credentials (omit for an open relay) |
| `MAIL_FROM` | Sender; defaults to `SMTP_USER` |
| `MAIL_SUBJECT_PREFIX` | [`[FoxESS]`] |
| `MAIL_TRANSPORT` | [`smtp`] or `json` — writes `.json`/`.html` files to `MAIL_JSON_DIR` |

### Scheduling

| Variable | Description |
| --- | --- |
| `POLL_INTERVAL_MINUTES` | [`30`] Delay between checks |
| `POLL_JITTER_SECONDS` | [`30`] Random extra delay so restarts do not synchronise |
| `RUN_ONCE` | [`false`] Check once and exit |
| `MAX_ATTEMPTS` | [`3`] Attempts per check before it counts as failed |
| `RETRY_BACKOFF_MS` | [`5000`] Linear backoff between attempts |
| `HEALTH_PORT` | [`8080`] HTTP `/health` endpoint, `0` disables it |

### Notification policy

| Variable | Description |
| --- | --- |
| `NOTIFY_MODE` | [`new`] `new` = unseen alerts only, `all` = everything on every run |
| `ALERT_LOOKBACK_HOURS` | [`24`] History window (active alarms ignore it). `0` = no limit |
| `ALERT_MIN_SEVERITY` | [`unknown`] `critical`, `warning`, `info` or `unknown` |
| `NOTIFY_ON_FIRST_RUN` | [`true`] On a fresh `state.json`, email the current backlog |
| `NOTIFY_ON_EMPTY` | [`false`] Send an "all clear" email when nothing is wrong |
| `NOTIFY_ON_ERROR` | [`true`] Email when the check fails (bad password, API change, ...) |
| `ERROR_NOTIFY_COOLDOWN_HOURS` | [`6`] Do not repeat failure emails more often than this |
| `MAX_ALERTS_PER_EMAIL` | [`50`] Truncate long lists (the email says how many were omitted) |
| `STATE_RETENTION_DAYS` | [`30`] Forget alert identities not seen for this long |

### Runtime

| Variable | Description |
| --- | --- |
| `STATE_FILE` | [`./data/state.json`] De-duplication memory and last-run status |
| `SESSION_FILE` | [`./data/session.json`] Browser mode cookies |
| `SIGNER_CACHE_DIR` | [`./data/signer`] Cached `signature.js` / `signature.wasm` |
| `LOG_LEVEL` | [`info`] `debug`, `info`, `warn`, `error`, `silent` |
| `DRY_RUN` | [`false`] Render and log the email instead of sending it |

---

## Browser fallback (`FOXESS_MODE=browser`)

The original implementation drove the real site with Playwright. It is kept as an escape hatch in case
the API contract changes:

```bash
docker build --build-arg WITH_BROWSER=true -t foxess-alert-notifications:browser .
FOXESS_MODE=browser docker compose up -d
```

In this mode the scraper logs in through the UI (robust selector fallbacks), visits
`FOXESS_ALERTS_ROUTES` and extracts alerts from the JSON the page fetches plus the rendered tables. It
costs a few seconds and a few hundred MB of RAM per check, but it survives API-only changes.

Browser-specific settings: `HEADLESS`, `FOXESS_ALERTS_ROUTES`, `FOXESS_LOGIN_ROUTE`,
`FOXESS_PAGE_ACTIONS` (JSON DSL to fill filters and click before scraping), `ALERT_RESPONSE_URL_REGEX`,
`PAGE_SETTLE_MS`, `DEBUG` / `DEBUG_DIR` (dumps screenshot, HTML, API payloads and parsed tables).

---

## Troubleshooting

**`401` / `41807` wrong username or password** — the credentials are rejected (the current login
endpoint reports it as `errno: 401`, the older one as `41807`). Check `FOXESS_USERNAME` /
`FOXESS_PASSWORD`; the password is sent as an MD5 hash, exactly like the web app.

**`40257 Parameters do not meet expectations`** — the request hit the US login stack with the wrong
host. Set `FOXESS_BASE_URL=https://us.foxesscloud.com`.

**`41819 Unauthorized`** — the token is missing/expired. With credentials configured the client re-logs
in automatically and retries once; if it persists, the account may need an interactive login (2FA).

**No alerts but the site shows some** — check `FOXESS_ALERT_SCOPE` and `ALERT_LOOKBACK_HOURS`. History
is queried in ≤14-day windows; `active` shows only currently open faults. `LOG_LEVEL=debug` prints every
request's plant, window and row count.

**Emails repeat the same alert** — `state.json` must be writable and persistent (a Docker volume). The
worker refuses to start if it cannot write there, because without it every poll would re-send.

**Fewer bodies than expected** — `MAX_ALERTS_PER_EMAIL` truncates the list; the email states how many
were omitted.

**`/health` returns 503** — the last check failed; the JSON body contains the error. The worker keeps
running and retries on the next interval.

---

## Development

```bash
npm install          # playwright is optional; skip with: npm ci --omit=optional
npm test             # 95 tests: time/zone maths, API client, mapping, policy, state, email, CLI e2e
```

The test suite runs the real API client against a fake FoxESS server (`test/fixtures/apiServer.js`) and
the browser mode against a fake SPA (`test/fixtures/server.js`); nothing talks to the real site.

```
src/
  index.js              entrypoint: CLI flags, scheduler, retries, health endpoint
  config.js             environment parsing + validation
  time.js               plant-timezone parsing (AEST/AEDT/CST are ambiguous)
  alerts.js             normalization: severity, identity, windowing, de-duplication
  policy.js             notification policy (new/all, first run, truncation)
  state.js              state.json: seen alerts, run history
  mailer.js             nodemailer transport (smtp | json)
  email/template.js     HTML/text rendering (pure, escaped)
  health.js             /health JSON endpoint
  api/
    client.js           login, plants, active/history alarms, token refresh
    signature.js        the site's WASM signer (cached, degrades to placeholder)
    map.js              alarm record -> Alert
    collect.js          api mode orchestration
  scraper/              browser mode (Playwright): login, extract, scrape
test/                   unit tests + two end-to-end suites with local fixtures
```

Verified against the live API on 2026-10-26: login endpoint, token handling, plant list, active alarms
and chunked history all return `errno: 0`, and `signature` values match the browser byte for byte.
