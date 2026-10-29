/**
 * Pure helpers that turn raw scraped blobs into `Alert` records and then reason
 * about them (severity, time window, stable identity, de-duplication).
 *
 * Everything in this file is synchronous and side-effect free so it is cheap to
 * unit test without a browser.
 */

import { createHash } from 'node:crypto';

/** Lower number == more severe. Used for sorting and for ALERT_MIN_SEVERITY. */
export const SEVERITY_RANK = { critical: 0, warning: 1, info: 2, unknown: 3 };

/**
 * @typedef {object} Alert
 * @property {string} id            Stable identity (derived from content).
 * @property {string} title         Human readable headline.
 * @property {string} [details]     Extra context, if the site provides any.
 * @property {'critical'|'warning'|'info'|'unknown'} severity
 * @property {string|null} occurredAt ISO timestamp, when the site exposes one.
 * @property {string|undefined} site
 * @property {string|undefined} device
 * @property {string|undefined} ref      Extra identity (e.g. `Inverter:26`).
 * @property {'active'|'history'} [scope]
 * @property {'api'|'network'|'dom'} source
 * @property {string} [url]         Page or API URL the record came from.
 * @property {string} [raw]         Raw payload (JSON string) for debugging.
 */

// Field names seen across FoxESS cloud views ("alarm", "fault", "message", "notice").
const TITLE_KEYS = [
  'alarmName',
  'alarmContent',
  'alarmMessage',
  'faultName',
  'faultContent',
  'errorMessage',
  'errorName',
  'eventName',
  'eventDescription',
  'noticeTitle',
  'msgContent',
  'messageContent',
  'content',
  'title',
  'message',
  'name',
  'description',
  'desc',
  'remark',
  'alarmType',
  'faultType',
  'eventType',
  'type',
];

const TIME_KEYS = [
  'occurTime',
  'occurredTime',
  'happenTime',
  'alarmTime',
  'faultTime',
  'eventTime',
  'createTime',
  'createdTime',
  'createdAt',
  'createDate',
  'startTime',
  'beginTime',
  'updateTime',
  'updateDate',
  'time',
  'timestamp',
  'date',
  'longTime',
];

const DEVICE_KEYS = ['deviceSN', 'devSN', 'deviceSn', 'sn', 'serialNumber', 'deviceNo', 'device'];
const SITE_KEYS = ['plantName', 'stationName', 'plantname', 'siteName', 'plant', 'station', 'site', 'groupName'];
const LEVEL_KEYS = ['alarmLevel', 'level', 'severity', 'alarmType', 'status', 'statusText', 'deviceType'];

const CRITICAL_WORDS = [
  'critical',
  'fatal',
  'emergency',
  'fault',
  'error',
  'failure',
  'failed',
  'over temperature',
  'overtemperature',
  'overvoltage',
  'undervoltage',
  'short circuit',
  'earth fault',
  'grid fault',
  'battery fault',
  '故障',
  '报警',
  '严重',
  '异常',
  '错误',
];
const WARNING_WORDS = ['warn', 'warning', 'caution', 'attention', 'abnormal', '告警', '警告', '注意', '预警'];
const INFO_WORDS = ['info', 'notice', 'notification', 'reminder', 'message', '提示', '通知', '消息'];

const DATE_LIKE = /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/;
const MIN_TIME = Date.UTC(2000, 0, 1);
const MAX_FUTURE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Counters some FoxESS views expose instead of a list (the unread badge next to
 * the notification bell). Deliberately narrow: a generic `total`/`count` field
 * is far too common to be a reliable "there are alerts" signal.
 */
const UNREAD_COUNT_KEYS = [
  'unReadNum',
  'unreadNum',
  'noReadNum',
  'unReadCount',
  'unreadCount',
  'noReadCount',
  'msgNum',
  'msgCount',
  'messageCount',
  'noticeCount',
  'notifyCount',
  'alarmCount',
  'alarmNum',
  'unread',
  'unRead',
];

function pick(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value === null || value === undefined) continue;
    const text = typeof value === 'object' ? '' : String(value).trim();
    if (text) return text;
  }
  return undefined;
}

function stringify(value) {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

/**
 * Title candidates must be human readable. FoxESS DTOs often carry numeric
 * discriminators (`type: 2`, `alarmType: 1`) which must never become a subject.
 */
function pickTitle(record) {
  for (const key of TITLE_KEYS) {
    const text = stringify(record?.[key]);
    if (!text) continue;
    if (/^[-+]?\d+(\.\d+)?$/.test(text)) continue;
    if (text.length < 2) continue;
    if (!/[a-z\u4e00-\u9fff]/i.test(text)) continue;
    return text;
  }
  return undefined;
}

/**
 * Turns an arbitrary timestamp-ish value into a Date.
 * Handles epoch seconds/milliseconds, ISO strings, `YYYY-MM-DD HH:mm:ss` and
 * `YYYY年MM月DD日 HH:mm` (FoxESS renders Chinese dates for zh locales).
 */
export function parseWhen(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const ms = value > 1e11 ? value : value * 1000;
    const date = new Date(ms);
    return isPlausibleDate(date) ? date : null;
  }
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (!raw) return null;

  if (/^\d{10}$/.test(raw) || /^\d{13}$/.test(raw)) {
    return parseWhen(Number(raw));
  }

  // 2026年10月25日 10:22:33 -> 2026-10-25 10:22:33
  const normalized = raw
    .replace(/年/g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, ' ')
    .replace(/(\d{1,2})\/(\d{1,2})\/(\d{4})/, '$3-$2-$1')
    .replace(/\s+/g, ' ')
    .trim();

  const isoish = normalized.replace(/^(\d{4}-\d{1,2}-\d{1,2}) (\d{1,2}:\d{2}(?::\d{2})?)/, '$1T$2');

  for (const candidate of [isoish, normalized, raw]) {
    const time = Date.parse(candidate);
    if (!Number.isNaN(time)) {
      const date = new Date(time);
      if (isPlausibleDate(date)) return date;
    }
  }
  return null;
}

function isPlausibleDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  if (date.getTime() < MIN_TIME) return false;
  if (date.getTime() > Date.now() + MAX_FUTURE_MS) return false;
  return true;
}

/** Best-effort severity classification from an explicit level plus free text. */
export function normalizeSeverity(levelValue, text = '') {
  const level = levelValue === null || levelValue === undefined ? '' : String(levelValue).toLowerCase().trim();
  const haystack = `${level} ${String(text).toLowerCase()}`;

  if (/^(4|fatal|critical|emergency|major)$/.test(level)) return 'critical';
  if (/^(3|error|fault)$/.test(level)) return 'critical';
  if (/^(2|warn|warning|minor)$/.test(level)) return 'warning';
  if (/^(1|info|notice|notification|normal)$/.test(level)) return 'info';

  if (CRITICAL_WORDS.some((word) => haystack.includes(word))) return 'critical';
  if (WARNING_WORDS.some((word) => haystack.includes(word))) return 'warning';
  if (INFO_WORDS.some((word) => haystack.includes(word))) return 'info';
  return 'unknown';
}

export function severityRank(severity) {
  return SEVERITY_RANK[severity] ?? SEVERITY_RANK.unknown;
}

/** Stable, content derived identifier so the same alert never emails twice. */
export function alertId(alert) {
  const occurred = alert.occurredAt ? new Date(alert.occurredAt).toISOString() : '';
  const key = [alert.site ?? '', alert.device ?? '', alert.title ?? '', occurred, alert.ref ?? '']
    .map((part) => String(part).toLowerCase().replace(/\s+/g, ' ').trim())
    .join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function looksLikeAlertObject(object) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return false;
  if (!pickTitle(object)) return false;
  const hasTime = TIME_KEYS.some((key) => parseWhen(object[key]));
  const hasIdentity = DEVICE_KEYS.some((key) => stringify(object[key])) || SITE_KEYS.some((key) => stringify(object[key]));
  return hasTime || hasIdentity;
}

/** Maps one raw record (API JSON object or DOM row) into an `Alert`. */
export function toAlert(record, { source = 'network', url } = {}) {
  if (!looksLikeAlertObject(record)) return null;

  const title = pickTitle(record);
  if (!title) return null;

  const timeValue = TIME_KEYS.map((key) => record[key]).find((value) => parseWhen(value));
  const occurred = parseWhen(timeValue);
  const level = pick(record, LEVEL_KEYS);
  const details = [pick(record, ['description', 'desc', 'remark', 'alarmContent', 'faultContent', 'msgContent'])]
    .filter((value) => value && value !== title)
    .join(' ');

  const alert = {
    title: title.replace(/\s+/g, ' ').trim().slice(0, 300),
    details: details ? details.replace(/\s+/g, ' ').trim().slice(0, 800) : undefined,
    severity: normalizeSeverity(level, `${title} ${level ?? ''}`),
    occurredAt: occurred ? occurred.toISOString() : null,
    site: pick(record, SITE_KEYS),
    device: pick(record, DEVICE_KEYS),
    source,
    url,
    raw: source === 'network' ? safeJson(record) : undefined,
  };

  alert.id = alertId(alert);
  return alert;
}

function safeJson(value) {
  try {
    const text = JSON.stringify(value);
    return text && text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  } catch {
    return undefined;
  }
}

/**
 * Recursively walks an API payload looking for arrays of alert-shaped records.
 * FoxESS wraps everything in `{ errno, result: { data: [...] } }`, but list
 * endpoints are inconsistent, so we search instead of hard-coding a path.
 */
export function extractAlertsFromPayload(payload, { url } = {}) {
  const found = [];
  const seenObjects = new WeakSet();
  const seenAlerts = new Set();

  const visit = (node, depth) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      const records = node.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
      if (records.length && records.length === node.length) {
        for (const record of records) {
          const alert = toAlert(record, { source: 'network', url });
          if (alert && !seenAlerts.has(alert.id)) {
            seenAlerts.add(alert.id);
            found.push(alert);
          }
        }
        if (found.length && records.some(looksLikeAlertObject)) return;
      }
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      if (seenObjects.has(node)) return;
      seenObjects.add(node);
      for (const value of Object.values(node)) visit(value, depth + 1);
    }
  };

  visit(payload, 0);
  return found;
}

/** Merges alerts captured from several network responses and DOM tables. */
export function dedupeAlerts(alerts) {
  const byId = new Map();
  for (const alert of alerts) {
    const existing = byId.get(alert.id);
    if (!existing) {
      byId.set(alert.id, alert);
      continue;
    }
    // Prefer the richer record (structured API payloads beat rendered tables).
    const score = (a) =>
      ({ api: 3, network: 2, dom: 0 }[a.source] ?? 0) + (a.severity !== 'unknown' ? 1 : 0) + (a.occurredAt ? 1 : 0);
    if (score(alert) > score(existing)) byId.set(alert.id, alert);
  }
  return [...byId.values()];
}

export function sortAlerts(alerts) {
  return [...alerts].sort((a, b) => {
    const bySeverity = severityRank(a.severity) - severityRank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    const aTime = a.occurredAt ? Date.parse(a.occurredAt) : 0;
    const bTime = b.occurredAt ? Date.parse(b.occurredAt) : 0;
    return bTime - aTime;
  });
}

/** Drops records older than `lookbackHours` (0 disables the window entirely). */
export function filterByWindow(alerts, { now = new Date(), lookbackHours = 24 } = {}) {
  if (!lookbackHours || lookbackHours <= 0) {
    return { recent: [...alerts], ignored: [] };
  }
  const cutoff = now.getTime() - lookbackHours * 60 * 60 * 1000;
  const recent = [];
  const ignored = [];
  for (const alert of alerts) {
    if (!alert.occurredAt) {
      recent.push(alert); // unknown timestamp: keep it, de-duplication protects us
      continue;
    }
    const time = Date.parse(alert.occurredAt);
    if (Number.isNaN(time) || time >= cutoff) recent.push(alert);
    else ignored.push(alert);
  }
  return { recent, ignored };
}

export function filterBySeverity(alerts, minSeverity = 'info') {
  const threshold = severityRank(minSeverity);
  return alerts.filter((alert) => severityRank(alert.severity) <= threshold);
}

export function summarize(alerts) {
  const bySeverity = { critical: 0, warning: 0, info: 0, unknown: 0 };
  for (const alert of alerts) {
    bySeverity[alert.severity] = (bySeverity[alert.severity] ?? 0) + 1;
  }
  const devices = new Set(alerts.map((alert) => alert.device).filter(Boolean));
  const sites = new Set(alerts.map((alert) => alert.site).filter(Boolean));
  return { total: alerts.length, bySeverity, devices: devices.size, sites: sites.size };
}

/** Convenience: full pipeline used by the scraper and by tests. */
export function normalizeAlerts({ payloads = [], rows = [] }, { now = new Date(), lookbackHours = 24 } = {}) {
  // De-duplicate per source first so diagnostics report distinct alerts rather
  // than "records captured" (the same list is fetched on every page visit).
  const fromNetwork = dedupeAlerts(
    payloads.flatMap(({ payload, url }) => extractAlertsFromPayload(payload, { url })),
  );
  const fromDom = dedupeAlerts(rows.map((row) => rowToAlert(row)).filter(Boolean));
  const merged = sortAlerts(dedupeAlerts([...fromNetwork, ...fromDom]));
  const { recent, ignored } = filterByWindow(merged, { now, lookbackHours });
  return { alerts: recent, ignored, fromNetwork, fromDom };
}

/**
 * Converts an extracted table row (header label -> cell text) into an alert.
 * @param {{headers: string[], cells: string[], pageUrl?: string}} row
 */
export function rowToAlert(row) {
  const headers = row.headers ?? [];
  const cells = row.cells ?? [];
  if (!cells.length) return null;
  if (!cells.some((cell) => cell && cell.trim())) return null;

  const findIndex = (pattern) => headers.findIndex((header) => pattern.test(header));
  const timeIndex = findIndex(/time|date|日期|时间|发生/i);
  const siteIndex = findIndex(/plant|station|site|电站|场站|站点/i);
  const deviceIndex = findIndex(/\bsn\b|device|inverter|serial|设备|序列/i);
  const levelIndex = findIndex(/level|severity|grade|等级|级别/i);
  const titleIndex = findIndex(/alarm|fault|event|alert|message|notice|content|desc|name|type|告警|故障|事件|内容|名称/i);

  const textAt = (index) => (index >= 0 ? (cells[index] ?? '').trim() : '');

  let title = textAt(titleIndex);
  if (!title) {
    // Fall back to the longest cell that is not a timestamp / serial number.
    const candidates = cells.filter((cell) => cell && cell.length > 2 && !parseWhen(cell) && !/^[A-Z0-9-]{8,}$/.test(cell));
    title = candidates.sort((a, b) => b.length - a.length)[0] ?? cells[0];
  }
  if (!title) return null;

  let occurredAt = parseWhen(textAt(timeIndex));
  if (!occurredAt) {
    const dateCell = cells.find((cell) => DATE_LIKE.test(cell));
    occurredAt = parseWhen(dateCell);
  }

  const details = cells
    .filter((cell) => cell && cell !== title)
    .join(' · ')
    .slice(0, 800);

  const alert = {
    title: title.replace(/\s+/g, ' ').trim().slice(0, 300),
    details: details || undefined,
    severity: normalizeSeverity(textAt(levelIndex), `${title} ${textAt(levelIndex)}`),
    occurredAt: occurredAt ? occurredAt.toISOString() : null,
    site: textAt(siteIndex) || undefined,
    device: textAt(deviceIndex) || undefined,
    source: 'dom',
    url: row.pageUrl,
  };
  alert.id = alertId(alert);
  return alert;
}

/**
 * Walks an API payload looking for an "unread notifications" counter.
 * Returns the largest one found, e.g. `{ count: 3, key: 'unReadNum' }`.
 */
export function extractUnreadSignal(payload) {
  const found = [];
  const seen = new WeakSet();

  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (seen.has(node)) return;
    seen.add(node);
    for (const key of UNREAD_COUNT_KEYS) {
      const value = node[key];
      if (value === null || value === undefined || value === '') continue;
      const count = Number(value);
      if (Number.isFinite(count) && count >= 0) found.push({ count: Math.round(count), key });
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') visit(value, depth + 1);
    }
  };

  visit(payload, 0);
  if (!found.length) return null;
  return found.sort((a, b) => b.count - a.count)[0];
}

/**
 * Some accounts only get an unread badge, with the detail behind a menu we
 * cannot name. This builds an "alert" from the counter so the recipient still
 * learns that something happened, without inventing details.
 */
export function buildUnreadSignalAlert(signal, { url, now = new Date() } = {}) {
  const count = Number(signal?.count) || 0;
  const alert = {
    title: `Notification center reports ${count} unread ${count === 1 ? 'notification' : 'notifications'}`,
    details: 'No alert details could be scraped from the page; the unread counter was the only signal. Open the dashboard to see the full list.',
    severity: 'info',
    occurredAt: now.toISOString(),
    source: 'network',
    url,
    // Deliberately not content hashed: the identity is the count itself, so a
    // change in the number (a new notification arrived) produces one email.
    id: `unread-signal-${count}`,
  };
  return alert;
}
