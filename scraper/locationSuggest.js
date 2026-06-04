import axios from 'axios';

const cache = new Map();
const TTL_MS = 60 * 60 * 1000;

export async function suggestLocations(query) {
  const q = (query || '').trim();
  if (q.length < 2) return [];
  const key = q.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.t < TTL_MS) return cached.v;

  try {
    const { data } = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q, format: 'json', limit: 8, addressdetails: 1 },
      headers: {
        'User-Agent': 'gmap-scraper-local/1.0 (local use)',
        'Accept-Language': 'en'
      },
      timeout: 7000
    });
    const out = (data || []).map((d) => ({
      label: d.display_name,
      short: shortLabel(d),
      lat: d.lat,
      lon: d.lon,
      type: d.type
    }));
    cache.set(key, { t: Date.now(), v: out });
    return out;
  } catch (e) {
    return [];
  }
}

function shortLabel(d) {
  const a = d.address || {};
  const parts = [
    a.city || a.town || a.village || a.hamlet || a.suburb || a.neighbourhood,
    a.state,
    a.country
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : d.display_name;
}
