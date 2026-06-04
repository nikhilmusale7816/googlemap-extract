import { newPage, acceptConsentIfPresent, getBrowser } from './browser.js';

const FEED_SEL = 'div[role="feed"]';
const CARD_SEL = 'div[role="feed"] a.hfpxzc';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => sleep(min + Math.random() * (max - min));

export async function scrapeMaps({ query, location, limit = 60, onResult, signal }) {
  const search = `${query} in ${location}`.trim();
  const url = `https://www.google.com/maps/search/${encodeURIComponent(search)}/?hl=en`;

  const browser = await getBrowser();
  const listPage = await newPage();
  let stopped = false;
  const stop = () => { stopped = true; };
  if (signal) signal.addEventListener('abort', stop);

  let detailPage = null;
  const seen = new Set();
  let emitted = 0;

  try {
    await listPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await acceptConsentIfPresent(listPage);

    const feedAppeared = await listPage
      .waitForSelector(FEED_SEL, { timeout: 30000 })
      .then(() => true)
      .catch(() => false);

    if (!feedAppeared) {
      const single = await extractFromPlacePage(listPage);
      if (single) {
        const idMatch = listPage.url().match(/!1s([^!]+)!/);
        single.id = idMatch ? idMatch[1] : listPage.url();
        single.mapsUrl = listPage.url();
        if (onResult) onResult(single);
        emitted++;
      }
      return emitted;
    }

    detailPage = await newPage();

    let stalls = 0;
    while (!stopped && emitted < limit) {
      const hrefs = await listPage.$$eval(CARD_SEL, (els) =>
        els.map((el) => ({ href: el.getAttribute('href'), label: el.getAttribute('aria-label') || '' }))
      );

      let newCount = 0;
      for (const { href, label } of hrefs) {
        if (stopped || emitted < 0) break;
        if (emitted >= limit) break;
        if (!href) continue;
        const id = stableId(href);
        if (seen.has(id)) continue;
        seen.add(id);
        newCount++;

        const placeUrl = href.startsWith('http') ? href : `https://www.google.com${href}`;
        const record = await extractPlace(detailPage, placeUrl, label, id).catch(() => null);
        if (record && onResult) {
          onResult(record);
          emitted++;
        }
        await jitter(350, 800);
        if (emitted >= limit) break;
      }

      if (stopped || emitted >= limit) break;

      const grew = await scrollFeed(listPage);
      if (newCount === 0 && !grew) {
        stalls++;
        if (stalls >= 3) break;
      } else {
        stalls = 0;
      }
      await jitter(700, 1300);

      const end = await listPage.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (!feed) return false;
        const txt = feed.innerText || '';
        return /You've reached the end of the list/i.test(txt);
      });
      if (end) break;
    }
  } finally {
    if (signal) signal.removeEventListener('abort', stop);
    if (detailPage) await detailPage.close().catch(() => {});
    await listPage.close().catch(() => {});
  }

  return emitted;
}

async function scrollFeed(page) {
  return await page.evaluate(() => {
    const feed = document.querySelector('div[role="feed"]');
    if (!feed) return false;
    const before = feed.scrollHeight;
    feed.scrollTo({ top: feed.scrollHeight, behavior: 'instant' });
    return new Promise((resolve) => {
      setTimeout(() => {
        const after = feed.scrollHeight;
        resolve(after > before);
      }, 1200);
    });
  });
}

async function extractPlace(page, placeUrl, fallbackName, id) {
  try {
    await page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch {
    return null;
  }
  await acceptConsentIfPresent(page);
  await page.waitForSelector('h1', { timeout: 15000 }).catch(() => {});
  await jitter(450, 800);

  const data = await extractFromPlacePage(page).catch(() => null);
  if (!data) return null;
  if (!data.name && fallbackName) data.name = fallbackName.trim();
  if (!data.name) return null;
  return {
    id,
    name: data.name,
    phone: data.phone || '',
    website: data.website || '',
    email: '',
    rating: data.rating,
    reviews: data.reviews,
    address: data.address || '',
    category: data.category || '',
    mapsUrl: placeUrl
  };
}

async function extractFromPlacePage(page) {
  return await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    let name = h1 ? (h1.textContent || '').trim() : '';
    if (name === 'Results') name = '';
    if (!name) {
      const mains = document.querySelectorAll('div[role="main"]');
      for (const m of mains) {
        const al = (m.getAttribute('aria-label') || '').trim();
        if (al && al !== 'Results') { name = al; break; }
      }
    }

    let rating = null;
    let reviews = null;
    const ratingNum = document.querySelector('div.F7nice span[aria-hidden="true"]');
    if (ratingNum) {
      const r = parseFloat((ratingNum.textContent || '').replace(',', '.'));
      if (!isNaN(r)) rating = r;
    }
    if (rating === null) {
      const starsImg = document.querySelector('span[role="img"][aria-label*="star" i]');
      if (starsImg) {
        const m = (starsImg.getAttribute('aria-label') || '').match(/([\d.,]+)/);
        if (m) rating = parseFloat(m[1].replace(',', '.'));
      }
    }
    const reviewsLink = document.querySelector('button[aria-label*="reviews" i], button[aria-label*="review" i]');
    if (reviewsLink) {
      const lbl = reviewsLink.getAttribute('aria-label') || reviewsLink.textContent || '';
      const m = lbl.replace(/[,\s]/g, '').match(/(\d+)/);
      if (m) reviews = parseInt(m[1], 10);
    }
    if (reviews === null) {
      const rspan = document.querySelector('div.F7nice span[aria-label*="review" i]');
      if (rspan) {
        const m = (rspan.textContent || '').replace(/[^\d]/g, '');
        if (m) reviews = parseInt(m, 10);
      }
    }

    const catBtn = document.querySelector('button[jsaction*="category"]');
    const category = catBtn ? (catBtn.textContent || '').trim() : '';

    let phone = '';
    const phoneEl = document.querySelector('button[data-item-id^="phone"]');
    if (phoneEl) {
      const did = phoneEl.getAttribute('data-item-id') || '';
      phone = did.replace(/^phone:tel:/, '').trim();
      if (!phone) phone = (phoneEl.getAttribute('aria-label') || '').replace(/^Phone:\s*/i, '').trim();
    }

    let website = '';
    const webA = document.querySelector('a[data-item-id="authority"]');
    if (webA) website = webA.getAttribute('href') || '';
    if (!website) {
      const alt = document.querySelector('a[aria-label^="Website"]');
      if (alt) website = alt.getAttribute('href') || '';
    }

    let address = '';
    const addrBtn = document.querySelector('button[data-item-id="address"]');
    if (addrBtn) {
      address = (addrBtn.getAttribute('aria-label') || '').replace(/^Address:\s*/i, '').trim();
      if (!address) address = (addrBtn.textContent || '').trim();
    }

    return { name, rating, reviews, category, phone, website, address };
  });
}

function stableId(href) {
  const m = href.match(/!1s([^!]+)!/);
  if (m) return m[1];
  return href.split('?')[0];
}
