import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

let browserPromise = null;

export async function getBrowser() {
  if (browserPromise) return browserPromise;
  browserPromise = puppeteer.launch({
    headless: 'new',
    defaultViewport: { width: 1366, height: 850 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--lang=en-US,en'
    ]
  });
  const browser = await browserPromise;
  browser.on('disconnected', () => { browserPromise = null; });
  return browser;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch {}
  browserPromise = null;
}

export async function newPage() {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  return page;
}

export async function acceptConsentIfPresent(page) {
  try {
    const consentSelectors = [
      'button[aria-label*="Accept all" i]',
      'button[aria-label*="Reject all" i]',
      'form[action*="consent"] button',
      'button:has-text("I agree")'
    ];
    for (const sel of consentSelectors) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click().catch(() => {});
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
        return true;
      }
    }
  } catch {}
  return false;
}
