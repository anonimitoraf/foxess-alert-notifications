/**
 * Notification policy: decide which alerts deserve an email right now.
 *
 * Kept separate from the entrypoint so it can be unit tested without starting
 * the scheduler.
 */

/**
 * @param {object} params
 * @param {import('./alerts.js').Alert[]} params.alerts  All alerts inside the lookback window.
 * @param {import('./alerts.js').Alert[]} params.newAlerts Alerts never seen before this run.
 * @param {boolean} params.isFirstRun No successful run has completed yet.
 * @param {object} params.config Loaded configuration (only `alerts` is read).
 * @returns {import('./alerts.js').Alert[]} alerts to put in the email
 */
export function selectNotifications({ alerts, newAlerts, isFirstRun, config }) {
  const { notifyMode, notifyOnFirstRun } = config.alerts ?? {};

  // "all": re-send the current state of the world on every run (useful as a
  // heartbeat, or while tuning selectors).
  if (notifyMode === 'all') return alerts;

  // First ever run: the site may already contain a backlog. NOTIFY_ON_FIRST_RUN
  // decides whether that backlog is worth an email or should only be recorded.
  if (isFirstRun) return notifyOnFirstRun ? alerts : [];

  return newAlerts;
}

/**
 * Applies MAX_ALERTS_PER_EMAIL and reports how many were omitted.
 */
export function capAlerts(alerts, max) {
  const capped = alerts.slice(0, Math.max(1, max));
  return { alerts: capped, truncated: Math.max(0, alerts.length - capped.length) };
}
