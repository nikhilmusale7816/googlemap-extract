# Google Maps Business Scraper

Local web tool. Input business type + location. Scrapes Google Maps for name, phone, website, rating, reviews, address. Visits each website to extract emails. Exports CSV/JSON. Live results via SSE.

## Stack

- **Runtime**: Node.js 20+ (tested on 22.14)
- **Server**: Express
- **Scraping**: puppeteer-extra + stealth plugin (bundled Chromium)
- **HTML parse**: cheerio (email hunt on websites)
- **HTTP**: axios
- **CSV**: json2csv
- **Location autocomplete**: OpenStreetMap Nominatim (free, no key)
- **Email send**: nodemailer (SMTP), multer (image upload), html-to-text (plain-text alt)
- **Editor**: Quill 2.0 (CDN, rich text with image upload)
- **Frontend**: Vanilla HTML + Alpine.js (CDN) + Tailwind (CDN play). Zero build step.
- **Storage**: In-memory + JSON cache files in `cache/`. Uploaded images in `public/uploads/`.

No paid APIs. No DB. No Docker.

## File Layout

```
gmap/
├── CLAUDE.md                  # this file
├── package.json
├── server.js                  # Express + SSE + routes
├── scraper/
│   ├── browser.js             # singleton Puppeteer browser
│   ├── mapsScraper.js         # Google Maps search + extract
│   ├── emailHunter.js         # axios + cheerio email scrape
│   └── locationSuggest.js     # Nominatim location autocomplete
├── public/
│   ├── index.html             # UI shell
│   ├── app.js                 # frontend logic, SSE, export, copy
│   └── styles.css             # custom CSS, fonts, grid texture
└── cache/                     # per-search JSON dumps
```

## Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Static UI |
| GET | `/api/suggest?q=...` | Location suggestions (Nominatim) |
| GET | `/api/scrape?type=...&location=...&limit=...&emails=1` | SSE stream of business records |
| POST | `/api/export` | CSV/JSON download of provided rows |
| POST | `/api/email/verify` | Verify SMTP credentials |
| POST | `/api/email/upload-image` | Multipart upload, returns `/uploads/<sha1>.<ext>` |
| POST | `/api/email/send` | SSE stream of per-recipient send progress |

## Record Shape

```json
{
  "id": "stable-hash",
  "name": "Acme Plumbing",
  "phone": "+1 555 123 4567",
  "website": "https://acme.example",
  "email": "info@acme.example",
  "rating": 4.6,
  "reviews": 128,
  "address": "123 Pipe St, Springfield",
  "category": "Plumber",
  "mapsUrl": "https://www.google.com/maps/place/..."
}
```

## Run

```bash
npm install
node server.js
# open http://localhost:3000
```

First `npm install` downloads bundled Chromium (~170MB). One-time.

## Design Notes (UI)

- Aesthetic: cartographic / OSINT terminal. Deep ink background, warm amber accent, cyan signal accent.
- Display font: **Fraunces** (variable serif, distinctive).
- Mono font: **JetBrains Mono**.
- Layout: split — sticky control panel left, live results right. Monospace data, ASCII-style rating bars.
- Live SSE updates fill rows progressively. Email column shows skeleton until hunter finishes.

## Email Send Flow

1. User opens "Mail" button → drawer slides in from right.
2. Enters SMTP creds (host/port/secure/user/pass) → "Verify connection" hits `/api/email/verify`.
3. Picks From name/email/reply-to; ticks recipients (only rows with non-empty email selectable).
4. Subject + Quill body with token support: `{{name}} {{first_name}} {{phone}} {{website}} {{category}} {{city}} {{address}} {{email}}`.
5. Inline images: paste/upload through Quill toolbar → POST `/api/email/upload-image` → embedded `<img src="/uploads/...">` → on send, rewritten to CID inline attachments by `mail/sender.js`.
6. Throttle slider (default 4.5s, ±25% jitter per send).
7. Test send: single rendered email to user's own address using first selected row's tokens.
8. Live progress: SSE events `start | sent | failed | skipped | done` update drawer feed.
9. Log written to `cache/sent_<timestamp>.json`. SMTP password never persisted server-side.

Auto-appended: unsubscribe footer + `List-Unsubscribe` / `List-Unsubscribe-Post` headers + plain-text alt (deliverability).

## Anti-Block

- `puppeteer-extra-plugin-stealth` masks headless markers.
- Random delay 400–1200ms between card interactions.
- Auto-handle Google consent page (Reject all / Accept all).
- Single shared browser across requests (lighter).
- Email hunt: pool of 5 concurrent fetches with 8s timeout.
- Captcha detection → stream error to UI.

## Legal

Google Maps ToS forbids scraping. Personal/local use only. Do not host publicly.

## Caveman Mode

Active in this session. Code/commits stay normal English. Free-text user-facing replies compressed.
