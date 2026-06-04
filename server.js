import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import crypto from 'crypto';
import { Parser } from 'json2csv';

import { scrapeMaps } from './scraper/mapsScraper.js';
import { huntContacts } from './scraper/emailHunter.js';
import { suggestLocations } from './scraper/locationSuggest.js';
import { closeBrowser } from './scraper/browser.js';
import { verifyTransport, sendBatch } from './mail/sender.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const CACHE_DIR = path.join(__dirname, 'cache');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
await fs.mkdir(CACHE_DIR, { recursive: true });
await fs.mkdir(UPLOADS_DIR, { recursive: true });

const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const h = crypto.createHash('sha1').update(file.originalname + Date.now() + Math.random()).digest('hex').slice(0, 16);
    const ext = (path.extname(file.originalname) || '.png').toLowerCase();
    cb(null, `${h}${ext}`);
  }
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('only image files allowed'));
  }
});

app.get('/api/suggest', async (req, res) => {
  const q = (req.query.q || '').toString();
  const items = await suggestLocations(q);
  res.json({ items });
});

app.get('/api/scrape', async (req, res) => {
  const type = (req.query.type || '').toString().trim();
  const location = (req.query.location || '').toString().trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 40, 120);
  const wantEmails = req.query.emails !== '0';

  if (!type || !location) {
    res.status(400).json({ error: 'type and location required' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const collected = [];
  send('start', { type, location, limit, wantEmails });

  const emailQueue = [];
  let activeEmail = 0;
  const EMAIL_POOL = 5;

  const drainEmail = () => {
    while (activeEmail < EMAIL_POOL && emailQueue.length) {
      const rec = emailQueue.shift();
      activeEmail++;
      huntContacts(rec.website)
        .then((out) => {
          rec.email = out.emails[0] || '';
          rec.emails = out.emails;
          rec.whatsapp = out.whatsapp;
          rec.whatsappConfirmed = out.whatsappSeen || matchesPhone(rec.phone, out.whatsapp);
          send('contacts', {
            id: rec.id,
            email: rec.email,
            emails: out.emails,
            whatsapp: out.whatsapp,
            whatsappConfirmed: rec.whatsappConfirmed
          });
        })
        .catch(() => {})
        .finally(() => {
          activeEmail--;
          drainEmail();
        });
    }
  };

  function matchesPhone(phone, waNumbers) {
    if (!phone || !waNumbers || !waNumbers.length) return false;
    const d = phone.replace(/[^\d]/g, '');
    if (d.length < 7) return false;
    const tail = d.slice(-8);
    return waNumbers.some((w) => w.endsWith(tail));
  }

  try {
    await scrapeMaps({
      query: type,
      location,
      limit,
      signal: controller.signal,
      onResult: (rec) => {
        collected.push(rec);
        send('result', rec);
        if (wantEmails && rec.website) {
          emailQueue.push(rec);
          drainEmail();
        }
      }
    });

    await waitUntil(() => activeEmail === 0 && emailQueue.length === 0, 25000);

    const fname = `cache_${Date.now()}_${hash(type + location)}.json`;
    await fs.writeFile(path.join(CACHE_DIR, fname), JSON.stringify({ type, location, results: collected }, null, 2));

    send('done', { count: collected.length, cache: fname });
  } catch (err) {
    send('error', { message: String(err && err.message || err) });
  } finally {
    res.end();
  }
});

app.post('/api/export', (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  const format = (req.body && req.body.format) || 'csv';
  if (!rows.length) {
    res.status(400).json({ error: 'no rows' });
    return;
  }

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="businesses.json"');
    res.send(JSON.stringify(rows, null, 2));
    return;
  }

  const fields = ['name', 'phone', 'email', 'website', 'rating', 'reviews', 'address', 'category', 'mapsUrl'];
  try {
    const parser = new Parser({ fields });
    const csv = parser.parse(rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="businesses.csv"');
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/email/verify', async (req, res) => {
  const smtp = req.body && req.body.smtp;
  if (!smtp || !smtp.host || !smtp.user || !smtp.pass) {
    res.status(400).json({ ok: false, error: 'host, user, pass required' });
    return;
  }
  const out = await verifyTransport(smtp);
  res.json(out);
});

app.post('/api/email/upload-image', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      res.status(400).json({ error: String(err.message || err) });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'no file' });
      return;
    }
    res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname, size: req.file.size });
  });
});

app.post('/api/email/send', async (req, res) => {
  const body = req.body || {};
  const { smtp, from, replyTo, subject, html, rows, delayMs, testTo } = body;

  if (!smtp || !smtp.host || !smtp.user || !smtp.pass) {
    res.status(400).json({ error: 'smtp host/user/pass required' });
    return;
  }
  if (!subject || !html) {
    res.status(400).json({ error: 'subject and html required' });
    return;
  }
  if (!testTo && (!Array.isArray(rows) || !rows.length)) {
    res.status(400).json({ error: 'rows required when no testTo' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const out = await sendBatch({
      smtp,
      from,
      replyTo,
      subject,
      html,
      rows: rows || [],
      delayMs: parseInt(delayMs, 10) || 4500,
      testTo: testTo || '',
      signal: controller.signal,
      onEvent: send
    });

    const logName = `sent_${Date.now()}_${hash((from?.email || smtp.user) + subject)}.json`;
    await fs.writeFile(path.join(CACHE_DIR, logName), JSON.stringify(out.log, null, 2));

    send('done', { sent: out.sent, failed: out.failed, skipped: out.skipped, logFile: logName });
  } catch (err) {
    send('error', { message: String(err && err.message || err) });
  } finally {
    res.end();
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, t: Date.now() }));

function hash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
}

function waitUntil(fn, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (fn()) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 200);
    };
    tick();
  });
}

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`gmap-scraper listening on http://localhost:${PORT}`);
});

const shutdown = async () => {
  console.log('Shutting down...');
  server.close();
  await closeBrowser();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
