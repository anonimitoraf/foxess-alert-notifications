/**
 * Timezone-aware timestamp handling.
 *
 * FoxESS returns plant-local timestamps with a *display* timezone name, e.g.
 *
 *     "2026-07-08 13:30:37 AEST"
 *
 * `AEST`/`CEST`/`CST` are ambiguous (AEST is +10, AEDT is +11; "CST" is three
 * different zones worldwide), so we ignore the suffix and interpret the wall
 * clock in the plant's IANA timezone, which the API gives us per plant.
 */

const formatterCache = new Map();

function formatterFor(timeZone) {
  const key = timeZone || 'UTC';
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: key,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(key, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone) {
  if (!timeZone) return false;
  try {
    formatterFor(timeZone).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Milliseconds the given zone is ahead of UTC at that instant. */
function zoneOffsetMs(date, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Converts a wall-clock time in `timeZone` to the matching UTC instant.
 * The offset is computed twice so DST transitions resolve correctly.
 */
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone = 'UTC') {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = zoneOffsetMs(new Date(naive), timeZone);
  let utc = naive - offset;
  const corrected = zoneOffsetMs(new Date(utc), timeZone);
  if (corrected !== offset) {
    offset = corrected;
    utc = naive - offset;
  }
  return new Date(utc);
}

const DATETIME_RE =
  /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3})\d*)?)?\s*(Z|[+-]\d{2}:?\d{2})?/i;

/**
 * Parses a FoxESS timestamp. Numeric offsets and `Z` win; otherwise the value
 * is interpreted in `timeZone` (plant timezone). Trailing zone abbreviations
 * such as `AEST` are ignored on purpose.
 *
 * @returns {Date|null}
 */
export function parseZonedDateTime(value, timeZone = 'UTC') {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;

  const match = DATETIME_RE.exec(value.trim());
  if (!match) return null;

  const [, year, month, day, hour, minute, second, ms, offset] = match;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour ?? 0),
    minute: Number(minute ?? 0),
    second: Number(second ?? 0),
  };
  if (
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.day > 31 ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59
  ) {
    return null;
  }

  // Reject impossible calendar dates ("2026-02-31") instead of rolling over.
  const daysInMonth = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
  if (parts.day > daysInMonth) return null;

  const millis = ms ? Number(ms.padEnd(3, '0')) : 0;

  if (offset && offset.toUpperCase() === 'Z') {
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, millis));
  }

  if (offset) {
    const sign = offset.startsWith('-') ? -1 : 1;
    const digits = offset.slice(1).replace(':', '');
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2, 4) || 0);
    const utc =
      Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, millis) -
      sign * (hours * 60 + minutes) * 60_000;
    return new Date(utc);
  }

  const date = zonedTimeToUtc(parts, isValidTimeZone(timeZone) ? timeZone : 'UTC');
  date.setUTCMilliseconds(millis);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Formats an instant as `YYYY-MM-DD HH:mm:ss` in the given zone. */
export function formatInZone(date, timeZone = 'UTC') {
  const d = date instanceof Date ? date : new Date(date);
  const parts = formatterFor(isValidTimeZone(timeZone) ? timeZone : 'UTC').formatToParts(d);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/** `{ year, month, day }` triple as FoxESS expects it (strings, zero padded). */
export function datePartsInZone(date, timeZone = 'UTC') {
  const [year, month, day] = formatInZone(date, timeZone).slice(0, 10).split('-');
  return { year, month, day };
}
