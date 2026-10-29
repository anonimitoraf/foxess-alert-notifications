/**
 * Email rendering. Pure functions only: no transport, no filesystem.
 */

import { summarize } from '../alerts.js';

const MAX_RAW_ROWS = 3;

const SEVERITY_META = {
  critical: { label: 'Critical', color: '#b91c1c', background: '#fef2f2', icon: '✖' },
  warning: { label: 'Warning', color: '#b45309', background: '#fffbeb', icon: '⚠' },
  info: { label: 'Info', color: '#1d4ed8', background: '#eff6ff', icon: 'ℹ' },
  unknown: { label: 'Alert', color: '#475569', background: '#f8fafc', icon: '•' },
};

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateTime(iso, timezone) {
  if (!iso) return 'unknown time';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export function buildSubject({ alerts, prefix = '[FoxESS]', home = 'FoxESS' } = {}) {
  const { total, bySeverity } = summarize(alerts);
  const parts = [];
  if (bySeverity.critical) parts.push(`${bySeverity.critical} critical`);
  if (bySeverity.warning) parts.push(`${bySeverity.warning} warning`);
  const others = total - bySeverity.critical - bySeverity.warning;
  if (others > 0) parts.push(`${others} other`);
  const countLabel = total === 1 ? '1 alert' : `${total} alerts`;
  return `${prefix} ${countLabel}${parts.length ? ` (${parts.join(', ')})` : ''} on ${home}`.replace(/\s+/g, ' ').trim();
}

/**
 * @param {object} params
 * @param {import('../alerts.js').Alert[]} params.alerts Alerts to render.
 * @param {{label: string, url: string}[]} [params.sources]
 * @param {string} [params.checkTime] ISO timestamp of the check.
 * @param {string} [params.timezone]
 * @param {number} [params.truncated] number of alerts omitted by MAX_ALERTS_PER_EMAIL
 */
export function buildEmail({ alerts, sources = [], checkTime = new Date().toISOString(), timezone, truncated = 0, home = 'FoxESS' }) {
  const summary = summarize(alerts);
  const subject = buildSubject({ alerts, home });

  const lines = [
    `${summary.total} alert${summary.total === 1 ? '' : 's'} found on ${home}.`,
    '',
    `Critical: ${summary.bySeverity.critical}   Warning: ${summary.bySeverity.warning}   Info: ${summary.bySeverity.info}   Other: ${summary.bySeverity.unknown}`,
    '',
  ];

  for (const alert of alerts) {
    lines.push(
      `- [${alert.severity.toUpperCase()}] ${formatDateTime(alert.occurredAt, alert.timezone || timezone)} — ${alert.title}`,
    );
    const meta = [alert.site && `site: ${alert.site}`, alert.device && `device: ${alert.device}`].filter(Boolean);
    if (meta.length) lines.push(`  ${meta.join(' · ')}`);
    if (alert.details && alert.details !== alert.title) lines.push(`  ${alert.details}`);
  }

  if (truncated > 0) {
    lines.push('', `… and ${truncated} more alert${truncated === 1 ? '' : 's'} not listed (see the dashboard).`);
  }

  lines.push('', `Checked at ${formatDateTime(checkTime, timezone)}`);
  if (sources.length) lines.push(`Source: ${sources.map((source) => source.url).join(', ')}`);

  return { subject, text: lines.join('\n'), html: renderHtml({ alerts, summary, checkTime, timezone, truncated, sources, home }) };
}

function renderHtml({ alerts, summary, checkTime, timezone, truncated, sources, home }) {
  const rows = alerts
    .map((alert) => {
      const meta = SEVERITY_META[alert.severity] ?? SEVERITY_META.unknown;
      const extra = [alert.site && `Site: ${escapeHtml(alert.site)}`, alert.device && `Device: ${escapeHtml(alert.device)}`]
        .filter(Boolean)
        .join(' · ');
      const details =
        alert.details && alert.details !== alert.title && alert.details.length > 0
          ? `<div style="margin-top:6px;color:#475569;font-size:13px;line-height:1.45;">${escapeHtml(
              alert.details.slice(0, 500),
            )}</div>`
          : '';
      return `<tr>
        <td style="padding:12px 10px;border-bottom:1px solid #e2e8f0;white-space:nowrap;vertical-align:top;font-size:13px;color:#334155;">${escapeHtml(
          formatDateTime(alert.occurredAt, alert.timezone || timezone),
        )}</td>
        <td style="padding:12px 10px;border-bottom:1px solid #e2e8f0;vertical-align:top;">
          <span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${meta.color};background:${meta.background};">${meta.icon} ${meta.label}</span>
          <div style="margin-top:6px;font-size:14px;font-weight:600;color:#0f172a;line-height:1.4;">${escapeHtml(alert.title)}</div>
          ${extra ? `<div style="margin-top:4px;font-size:12px;color:#64748b;">${extra}</div>` : ''}
          ${details}
        </td>
      </tr>`;
    })
    .join('');

  const stat = (label, value, color) =>
    `<td style="padding:0 6px;"><div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;text-align:center;">
      <div style="font-size:22px;font-weight:700;color:${color};line-height:1.1;">${value}</div>
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin-top:4px;">${label}</div>
    </div></td>`;

  const footerSources = sources.length
    ? `<p style="margin:8px 0 0;font-size:12px;color:#64748b;">Source pages: ${sources
        .map((source) => `<a href="${escapeHtml(source.url)}" style="color:#1d4ed8;">${escapeHtml(source.url)}</a>`)
        .join(' · ')}</p>`
    : '';

  const truncatedNote =
    truncated > 0
      ? `<p style="margin:16px 0 0;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:13px;color:#92400e;">${truncated} more alert${
          truncated === 1 ? '' : 's'
        } not shown. Open the dashboard for the full list.</p>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(buildSubject({ alerts, home }))}</title>
</head>
<body style="margin:0;padding:24px 12px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:720px;margin:0 auto;">
    <tr>
      <td style="padding:0 0 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-size:19px;font-weight:700;color:#0f172a;">${escapeHtml(home)} alerts</td>
            <td align="right" style="font-size:12px;color:#64748b;">${escapeHtml(formatDateTime(checkTime, timezone))}</td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -6px 16px;">
          <tr>
            ${stat('Total', summary.total, '#0f172a')}
            ${stat('Critical', summary.bySeverity.critical, SEVERITY_META.critical.color)}
            ${stat('Warning', summary.bySeverity.warning, SEVERITY_META.warning.color)}
            ${stat('Info', summary.bySeverity.info, SEVERITY_META.info.color)}
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <thead>
            <tr style="background:#f8fafc;">
              <th align="left" style="padding:10px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;border-bottom:1px solid #e2e8f0;">When</th>
              <th align="left" style="padding:10px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;border-bottom:1px solid #e2e8f0;">Alert</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 4px 0;">
        ${truncatedNote}
        <p style="margin:8px 0 0;font-size:12px;color:#64748b;">
          Sent by foxess-alert-notifications. Nothing in this email is actionable from here — open the FoxESS Cloud dashboard to acknowledge or clear alarms.
        </p>
        ${footerSources}
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * A one-off "is my mail configuration working" message. Deliberately includes the
 * settings that matter, so the email itself doubles as a configuration report.
 */
export function buildTestEmail({ config, checkTime = new Date().toISOString(), timezone } = {}) {
  const rows = [
    ['Mode', config.foxess.mode],
    ['FoxESS host', config.foxess.baseUrl],
    ['Alert scope', config.foxess.mode === 'api' ? config.api.scope : config.foxess.routes.join(', ')],
    ['History window', `${config.alerts.lookbackHours} h`],
    ['Poll interval', `${Math.round(config.schedule.intervalMs / 60_000)} min`],
    ['Notification mode', config.alerts.notifyMode],
    ['Transport', config.mail.transport === 'json' ? `json → ${config.mail.jsonDir}` : `${config.mail.host}:${config.mail.port}${config.mail.secure ? ' (implicit TLS)' : ''}`],
    ['From', config.mail.from],
    ['To', config.mail.to.join(', ')],
    ['Sent at', formatDateTime(checkTime, timezone)],
  ];

  const subject = `${config.mail.subjectPrefix} test email — email delivery works`.replace(/\s+/g, ' ').trim();
  const text = [
    'This is a test email from foxess-alert-notifications.',
    '',
    'If you can read this, SMTP is configured correctly and real alerts will arrive',
    'from the same sender address.',
    '',
    ...rows.map(([label, value]) => `${`${label}:`.padEnd(20)} ${value}`),
    '',
    'No alerts were checked and no state was modified by this test.',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;">
    <tr><td style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:22px;">
      <p style="margin:0 0 4px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#16a34a;font-weight:700;">✓ Test successful</p>
      <h1 style="margin:0 0 12px;font-size:19px;color:#0f172a;">Email delivery works</h1>
      <p style="margin:0 0 18px;font-size:14px;color:#334155;line-height:1.5;">
        If you can read this, SMTP is configured correctly and real FoxESS alerts will arrive from the same sender address.
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;">
        ${rows
          .map(
            ([label, value]) =>
              `<tr><td style="padding:6px 0;color:#64748b;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
                   <td style="padding:6px 0;color:#0f172a;font-weight:600;">${escapeHtml(value)}</td></tr>`,
          )
          .join('')}
      </table>
      <p style="margin:18px 0 0;padding-top:14px;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;">
        No alerts were checked and no state was modified by this test.
      </p>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

export function buildErrorEmail({ error, checkTime = new Date().toISOString(), timezone, home = 'FoxESS', attempts = 1 }) {
  const message = error?.message ? String(error.message) : String(error);
  const stack = error?.stack ? String(error.stack).split('\n').slice(0, 12).join('\n') : '';
  const subject = `[FoxESS] Alert check failed on ${home}`;

  const text = [
    `The FoxESS alert check failed${attempts > 1 ? ` after ${attempts} attempts` : ''}.`,
    '',
    message,
    stack ? `\n${stack}` : '',
    '',
    `Checked at ${formatDateTime(checkTime, timezone)}`,
  ]
    .filter(Boolean)
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px 12px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;">
    <tr><td style="background:#fff;border:1px solid #fecaca;border-left:4px solid #b91c1c;border-radius:12px;padding:20px;">
      <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#b91c1c;">Alert check failed</p>
      <p style="margin:0 0 14px;font-size:13px;color:#334155;">${escapeHtml(
        `The FoxESS alert check failed${attempts > 1 ? ` after ${attempts} attempts` : ''}.`,
      )}</p>
      <pre style="margin:0;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;color:#0f172a;white-space:pre-wrap;word-break:break-word;">${escapeHtml(
        message,
      )}</pre>
      ${
        stack
          ? `<pre style="margin:12px 0 0;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:11px;color:#64748b;white-space:pre-wrap;word-break:break-word;">${escapeHtml(
              stack,
            )}</pre>`
          : ''
      }
      <p style="margin:14px 0 0;font-size:12px;color:#64748b;">Checked at ${escapeHtml(formatDateTime(checkTime, timezone))}</p>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

export { MAX_RAW_ROWS };
