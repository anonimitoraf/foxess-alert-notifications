/**
 * Minimal dependency-free structured logger.
 *
 * Output is one line per record: `2026-10-25T04:24:34.123Z INFO  scraper message key=value`.
 * Kept small on purpose - a background worker does not need a logging framework.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function serialize(value) {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  }
  if (value === null || value === undefined) return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function formatFields(fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (!entries.length) return '';
  return ` ${entries.map(([k, v]) => `${k}=${serialize(v).replace(/\s*\n\s*/g, ' ')}`).join(' ')}`;
}

export function createLogger({ level = 'info', scope, bindings = {} } = {}) {
  const threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;

  const write = (lvl, message, fields) => {
    if (LEVELS[lvl] < threshold) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${
      scope ? `[${scope}] ` : ''
    }${message}${formatFields({ ...bindings, ...fields })}`;
    if (LEVELS[lvl] >= LEVELS.error) console.error(line);
    else if (LEVELS[lvl] >= LEVELS.warn) console.warn(line);
    else console.log(line);
  };

  const logger = {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (childScope, childBindings = {}) =>
      createLogger({
        level,
        scope: scope ? `${scope}:${childScope}` : childScope,
        bindings: { ...bindings, ...childBindings },
      }),
  };

  return logger;
}
