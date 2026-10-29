import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEmail, buildErrorEmail, buildSubject, buildTestEmail, escapeHtml } from '../src/email/template.js';

const alerts = [
  {
    id: 'b2',
    title: 'Grid Loss',
    severity: 'critical',
    occurredAt: '2026-10-25T10:00:00.000Z',
    site: 'Home Roof',
    device: 'SN-0001',
    details: 'Grid voltage out of range',
  },
  {
    id: 'a1',
    title: 'Battery Low Temperature',
    severity: 'warning',
    occurredAt: '2026-10-25T09:00:00.000Z',
    site: 'Home Roof',
    device: 'SN-0001',
  },
  {
    id: 'c1',
    title: 'Firmware available',
    severity: 'info',
    occurredAt: '2026-10-24T09:00:00.000Z',
  },
];

test('buildSubject summarizes counts by severity', () => {
  assert.equal(buildSubject({ alerts }), '[FoxESS] 3 alerts (1 critical, 1 warning, 1 other) on FoxESS');
  assert.equal(buildSubject({ alerts: [] }), '[FoxESS] 0 alerts on FoxESS');
  assert.equal(buildSubject({ alerts: [alerts[0]], prefix: '[Solar]' }), '[Solar] 1 alert (1 critical) on FoxESS');
});

test('buildEmail renders every alert in both text and html', () => {
  const { subject, text, html } = buildEmail({
    alerts,
    sources: [{ label: 'alarm', url: 'https://www.foxesscloud.com/#/bus/alarm' }],
    checkTime: '2026-10-25T12:00:00.000Z',
    timezone: 'UTC',
  });

  assert.match(subject, /3 alerts/);
  for (const alert of alerts) {
    assert.ok(text.includes(alert.title), `text should mention ${alert.title}`);
    assert.ok(html.includes(alert.title), `html should mention ${alert.title}`);
  }
  assert.match(text, /Critical: 1\s+Warning: 1\s+Info: 1\s+Other: 0/);
  assert.ok(text.includes('https://www.foxesscloud.com/#/bus/alarm'));
  assert.ok(html.includes('CRITICAL') || html.includes('Critical'));
  assert.ok(html.startsWith('<!DOCTYPE html>'));
});

test('buildEmail escapes untrusted content', () => {
  const hostile = {
    id: 'x',
    title: '<script>alert("xss")</script>',
    severity: 'critical',
    occurredAt: null,
    details: '"><img src=x onerror=alert(1)>',
  };
  const { html, text } = buildEmail({ alerts: [hostile], timezone: 'UTC' });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;img'), 'markup must be neutralised into entities');
  assert.ok(!html.includes('<img'), 'no live img tag may survive escaping');
  assert.ok(text.includes('<script>'), 'plain text keeps the raw characters, that is fine');
});

test('each alert is rendered in its own plant timezone', () => {
  const { text } = buildEmail({
    alerts: [
      {
        id: 'tz',
        title: 'Grid Voltage Fault',
        severity: 'critical',
        occurredAt: '2026-07-08T03:30:37.000Z',
        timezone: 'Australia/Melbourne',
      },
      {
        id: 'tz2',
        title: 'Battery Fault',
        severity: 'critical',
        occurredAt: '2026-07-08T03:30:37.000Z',
        timezone: 'Europe/Madrid',
      },
    ],
    timezone: 'UTC',
    checkTime: '2026-10-26T00:00:00.000Z',
  });

  // Zone *labels* differ per ICU build ("GMT+10" vs "CEST"), the wall clock does not.
  assert.match(text, /13:30:37 \S+ — Grid Voltage Fault/, 'Melbourne is +10 in July');
  assert.match(text, /05:30:37 \S+ — Battery Fault/, 'Madrid is +2 in July');
  assert.ok(!text.includes('03:30:37'), 'nothing is rendered in raw UTC');
});

test('buildEmail mentions truncated alerts', () => {
  const { text, html } = buildEmail({ alerts: [alerts[0]], truncated: 7, timezone: 'UTC' });
  assert.match(text, /and 7 more alerts/);
  assert.match(html, /7 more alerts/);
});

test('escapeHtml covers the five dangerous characters', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
});

test('buildErrorEmail includes the message and stack', () => {
  const error = new Error('Login timed out');
  error.stack = 'Error: Login timed out\n    at login (login.js:1:1)';
  const { subject, text, html } = buildErrorEmail({ error, attempts: 3, timezone: 'UTC' });
  assert.match(subject, /Alert check failed/);
  assert.match(text, /failed after 3 attempts/);
  assert.match(text, /Login timed out/);
  assert.ok(html.includes('Login timed out'));
});

test('the test email reports the active configuration', () => {
  const config = {
    foxess: { mode: 'api', baseUrl: 'https://www.foxesscloud.com', routes: ['/bus/alarm'] },
    api: { scope: 'both' },
    alerts: { lookbackHours: 24, notifyMode: 'new' },
    schedule: { intervalMs: 30 * 60_000 },
    mail: {
      transport: 'smtp',
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      from: 'alerts@example.com',
      to: ['me@example.com'],
      subjectPrefix: '[FoxESS]',
      jsonDir: './outbox',
    },
  };

  const { subject, text, html } = buildTestEmail({ config, checkTime: '2026-10-26T06:00:00.000Z', timezone: 'UTC' });

  assert.match(subject, /test email/);
  assert.match(text, /smtp\.example\.com:587/);
  assert.match(text, /scope:\s+both/);
  assert.match(text, /min/);
  assert.match(text, /No alerts were checked/);
  assert.ok(html.includes('Email delivery works'));
  assert.ok(html.includes('me@example.com'));
});
