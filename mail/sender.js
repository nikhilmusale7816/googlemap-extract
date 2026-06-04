import nodemailer from 'nodemailer';
import { convert as htmlToText } from 'html-to-text';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_DIR = path.join(__dirname, '..', 'public', 'uploads');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function buildTransport(smtp) {
  const port = parseInt(smtp.port, 10) || 587;
  const secure = smtp.secure === true || smtp.secure === 'true' || port === 465;
  return nodemailer.createTransport({
    host: smtp.host,
    port,
    secure,
    auth: { user: smtp.user, pass: smtp.pass },
    connectionTimeout: 15000,
    greetingTimeout: 12000,
    socketTimeout: 30000
  });
}

export async function verifyTransport(smtp) {
  const t = buildTransport(smtp);
  try {
    await t.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    t.close();
  }
}

export function renderTokens(input, row) {
  if (!input) return '';
  const name = row.name || '';
  const firstName = (name.split(/[\s,]+/)[0] || '').trim();
  const city = extractCity(row.address || '');
  const map = {
    name,
    first_name: firstName,
    phone: row.phone || '',
    website: row.website || '',
    category: row.category || '',
    city,
    address: row.address || '',
    email: row.email || ''
  };
  return String(input).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k) => {
    const key = k.toLowerCase();
    return map[key] != null ? map[key] : '';
  });
}

function extractCity(addr) {
  if (!addr) return '';
  const parts = addr.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 3];
  if (parts.length === 2) return parts[0];
  return parts[0] || '';
}

export async function inlineImagesToCid(html) {
  const attachments = [];
  let idx = 0;
  const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  const replaced = await replaceAsync(html, re, async (match, src) => {
    if (!src.startsWith('/uploads/')) return match;
    const filename = path.basename(src);
    const filepath = path.join(UPLOADS_DIR, filename);
    try {
      await fs.access(filepath);
    } catch {
      return match;
    }
    idx++;
    const cid = `img${idx}@gmap.local`;
    attachments.push({ filename, path: filepath, cid });
    return match.replace(/src\s*=\s*["'][^"']+["']/i, `src="cid:${cid}"`);
  });
  return { html: replaced, attachments };
}

async function replaceAsync(str, regex, asyncFn) {
  const promises = [];
  str.replace(regex, (match, ...args) => {
    promises.push(asyncFn(match, ...args));
    return match;
  });
  const data = await Promise.all(promises);
  return str.replace(regex, () => data.shift());
}

function appendUnsubscribeFooter(html, fromEmail) {
  const domain = (fromEmail || '').split('@')[1] || 'local';
  const link = `mailto:unsubscribe@${domain}?subject=Unsubscribe`;
  const footer = `
<hr style="border:none;border-top:1px solid #ccc;margin:24px 0 12px"/>
<p style="font-family:sans-serif;font-size:11px;color:#888;line-height:1.5">
  You received this because we found your business listed publicly. To opt out, reply with "unsubscribe" or click
  <a href="${link}" style="color:#888">here</a>.
</p>`;
  return html + footer;
}

function unsubscribeHeader(fromEmail) {
  const domain = (fromEmail || '').split('@')[1] || 'local';
  return `<mailto:unsubscribe@${domain}?subject=Unsubscribe>`;
}

export async function sendBatch({
  smtp,
  from,
  replyTo,
  subject,
  html,
  rows,
  delayMs = 4500,
  testTo = '',
  signal,
  onEvent
}) {
  const transport = buildTransport(smtp);
  const fromAddr = from && from.email ? (from.name ? `"${from.name}" <${from.email}>` : from.email) : smtp.user;
  const replyAddr = replyTo || from?.email || smtp.user;
  const listUnsubHdr = unsubscribeHeader(from?.email || smtp.user);

  let sent = 0, failed = 0, skipped = 0;
  const log = { sentAt: new Date().toISOString(), subject, from: fromAddr, sent: [], failed: [], skipped: [] };

  const targets = testTo
    ? [{ ...(rows[0] || {}), email: testTo, _test: true }]
    : rows;

  onEvent('start', { total: targets.length, testMode: !!testTo });

  try {
    for (let i = 0; i < targets.length; i++) {
      if (signal && signal.aborted) break;
      const row = targets[i];

      if (!row.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
        skipped++;
        log.skipped.push({ id: row.id, email: row.email || '', reason: 'invalid email' });
        onEvent('skipped', { id: row.id, reason: 'invalid email' });
        continue;
      }

      const renderedSubject = renderTokens(subject, row);
      const renderedHtmlRaw = renderTokens(html, row);
      const { html: renderedHtmlCid, attachments } = await inlineImagesToCid(renderedHtmlRaw);
      const finalHtml = appendUnsubscribeFooter(renderedHtmlCid, from?.email || smtp.user);
      const text = htmlToText(finalHtml, { wordwrap: 100, selectors: [{ selector: 'img', format: 'skip' }] });

      try {
        const info = await transport.sendMail({
          from: fromAddr,
          to: row.email,
          replyTo: replyAddr,
          subject: renderedSubject,
          html: finalHtml,
          text,
          attachments,
          headers: {
            'List-Unsubscribe': listUnsubHdr,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            'X-Mailer': 'gmap-local/1.0'
          }
        });
        sent++;
        log.sent.push({ id: row.id, email: row.email, messageId: info.messageId });
        onEvent('sent', { id: row.id, email: row.email, messageId: info.messageId });
      } catch (e) {
        failed++;
        const msg = String(e && e.message || e);
        log.failed.push({ id: row.id, email: row.email, error: msg });
        onEvent('failed', { id: row.id, email: row.email, error: msg });
      }

      if (i < targets.length - 1) {
        const jitter = delayMs * (0.75 + Math.random() * 0.5);
        const start = Date.now();
        while (Date.now() - start < jitter) {
          if (signal && signal.aborted) break;
          await sleep(150);
        }
      }
    }
  } finally {
    transport.close();
  }

  return { sent, failed, skipped, log };
}
