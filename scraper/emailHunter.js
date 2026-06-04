import axios from 'axios';
import * as cheerio from 'cheerio';

const BAD_DOMAINS = [
  'sentry.io', 'wixpress.com', 'example.com', 'example.org', 'domain.com',
  'godaddy.com', 'cloudflare.com', 'gstatic.com', 'googleusercontent.com',
  'youremail.com', 'email.com', 'test.com'
];
const BAD_EXT = /\.(png|jpg|jpeg|gif|svg|webp|ico|css|js)$/i;
const EMAIL_RE = /(?<![a-zA-Z0-9._%+-])[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,12}(?![a-zA-Z0-9])/g;
const WA_LINK_RE = /(?:wa\.me|api\.whatsapp\.com\/send|web\.whatsapp\.com\/send|whatsapp\.com\/send|chat\.whatsapp\.com)[^\s"'<>)]*/gi;
const WA_PHONE_RE = /(?:wa\.me\/|phone=|\/send\/?\?phone=)\+?(\d{7,15})/gi;
const CONTACT_PATHS = ['', '/contact', '/contact-us', '/contacts', '/about', '/about-us', '/impressum'];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export async function huntContacts(websiteUrl, { timeout = 8000 } = {}) {
  if (!websiteUrl) return { emails: [], whatsapp: [], whatsappSeen: false };
  let base;
  try { base = new URL(websiteUrl); } catch { return { emails: [], whatsapp: [], whatsappSeen: false }; }

  const tries = CONTACT_PATHS.map((p) => new URL(p, base).toString());
  const results = await Promise.allSettled(tries.map((u) => fetchContacts(u, timeout)));
  const emails = new Set();
  const waNumbers = new Set();
  let waSeen = false;

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const e of r.value.emails) emails.add(e);
    for (const n of r.value.whatsapp) waNumbers.add(n);
    if (r.value.whatsappSeen) waSeen = true;
  }
  return {
    emails: Array.from(emails).slice(0, 5),
    whatsapp: Array.from(waNumbers).slice(0, 4),
    whatsappSeen: waSeen
  };
}

export async function findEmails(websiteUrl, opts) {
  const out = await huntContacts(websiteUrl, opts);
  return out.emails;
}

async function fetchContacts(url, timeout) {
  try {
    const res = await axios.get(url, {
      timeout,
      maxRedirects: 4,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
      responseType: 'text'
    });
    const html = res.data;
    if (typeof html !== 'string') return { emails: [], whatsapp: [], whatsappSeen: false };
    const $ = cheerio.load(html);
    const emails = new Set();
    const whatsapp = new Set();
    let whatsappSeen = false;

    $('a[href^="mailto:"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.replace(/^mailto:/i, '').split('?')[0].trim();
      if (m && isValidEmail(m)) emails.add(m.toLowerCase());
    });

    $('a[href]').each((_, el) => {
      const href = ($(el).attr('href') || '').toLowerCase();
      if (WA_LINK_RE.test(href)) {
        whatsappSeen = true;
        const numMatches = [...href.matchAll(WA_PHONE_RE)];
        for (const m of numMatches) whatsapp.add(normalizePhone(m[1]));
      }
      WA_LINK_RE.lastIndex = 0;
      WA_PHONE_RE.lastIndex = 0;
    });

    $('script, style, noscript, svg').remove();
    const chunks = [];
    $('*').contents().each((_, n) => {
      if (n.type === 'text' && n.data) chunks.push(n.data);
    });
    const stripped = html.replace(/<[^>]+>/g, ' ');
    chunks.push(stripped);

    for (const chunk of chunks) {
      const normalized = chunk.replace(/\s+/g, ' ').replace(/[<>"']/g, ' ');
      const matches = normalized.match(EMAIL_RE) || [];
      for (const m of matches) {
        const cleaned = m.toLowerCase();
        if (isValidEmail(cleaned)) emails.add(cleaned);
      }
    }

    const waInText = stripped.match(WA_LINK_RE) || [];
    if (waInText.length) whatsappSeen = true;
    for (const link of waInText) {
      const numMatches = [...link.matchAll(WA_PHONE_RE)];
      for (const m of numMatches) whatsapp.add(normalizePhone(m[1]));
      WA_PHONE_RE.lastIndex = 0;
    }
    if (!whatsappSeen && /\bwhats?app\b/i.test(stripped)) whatsappSeen = true;

    return {
      emails: Array.from(emails),
      whatsapp: Array.from(whatsapp),
      whatsappSeen
    };
  } catch {
    return { emails: [], whatsapp: [], whatsappSeen: false };
  }
}

function normalizePhone(digits) {
  return digits.replace(/[^\d]/g, '');
}

function isValidEmail(e) {
  if (!e || e.length > 80) return false;
  if (BAD_EXT.test(e)) return false;
  const at = e.lastIndexOf('@');
  if (at < 1) return false;
  const domain = e.slice(at + 1).toLowerCase();
  if (BAD_DOMAINS.some((b) => domain === b || domain.endsWith('.' + b))) return false;
  if (/^([0-9a-f]{2}){4,}/i.test(e)) return false;
  return true;
}
