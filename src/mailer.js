/**
 * Email transport.
 *
 * `MAIL_TRANSPORT=smtp` sends through nodemailer, `MAIL_TRANSPORT=json` writes
 * the rendered message to disk (handy for local runs and integration tests).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nodemailer from 'nodemailer';

export function createMailer(config, logger) {
  const { mail } = config;
  let transporter = null;
  let jsonCounter = 0;

  function getTransporter() {
    if (transporter) return transporter;
    transporter = nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      requireTLS: mail.requireTls,
      auth: mail.user ? { user: mail.user, pass: mail.pass } : undefined,
      tls: mail.rejectUnauthorized ? undefined : { rejectUnauthorized: false },
      connectionTimeout: 30_000,
      greetingTimeout: 20_000,
      socketTimeout: 60_000,
    });
    return transporter;
  }

  async function sendJson({ subject, text, html }) {
    const dir = mail.jsonDir;
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = join(dir, `${stamp}-${++jsonCounter}`);
    await writeFile(`${base}.json`, JSON.stringify({ to: mail.to, cc: mail.cc, from: mail.from, subject, text }, null, 2));
    await writeFile(`${base}.html`, html ?? '', 'utf8');
    logger.info('email written to disk', { path: `${base}.{json,html}` });
    return { messageId: base, transport: 'json' };
  }

  return {
    async send({ subject, text, html }) {
      if (mail.transport === 'json') return sendJson({ subject, text, html });

      const info = await getTransporter().sendMail({
        from: mail.from,
        to: mail.to,
        cc: mail.cc.length ? mail.cc : undefined,
        subject,
        text,
        html,
      });
      logger.info('email sent', { messageId: info.messageId, accepted: info.accepted?.length ?? 0 });
      return info;
    },

    async verify() {
      if (mail.transport === 'json') {
        logger.info('mail transport: json (no SMTP verification needed)', { dir: mail.jsonDir });
        return true;
      }
      await getTransporter().verify();
      logger.info('SMTP connection verified', { host: mail.host, port: mail.port });
      return true;
    },

    close() {
      transporter?.close?.();
      transporter = null;
    },
  };
}
