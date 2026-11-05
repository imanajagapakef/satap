// Pencarian bisnis (Google Places API (New) - Autocomplete) + pembuat link ulasan.
import { CONFIG, isPlaceholder } from './config.js';

export const reviewUrlFor = (placeId) =>
  `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;

// Satu "session token" per sesi pencarian (sampai user memilih hasil) supaya biaya Google lebih hemat.
export const newSessionToken = () => crypto.randomUUID();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEMO_PLACES = [
  { placeId: 'DEMO_PLACE_1', name: 'Warung Bu Tini', address: 'Jl. Merdeka No. 12, Bandung' },
  { placeId: 'DEMO_PLACE_2', name: 'Kopi Senja', address: 'Jl. Dago No. 45, Bandung' },
  { placeId: 'DEMO_PLACE_3', name: 'Bengkel Jaya Motor', address: 'Jl. Ahmad Yani No. 8, Surabaya' },
  { placeId: 'DEMO_PLACE_4', name: 'Salon Cantik Alami', address: 'Jl. Pemuda No. 21, Semarang' },
  { placeId: 'DEMO_PLACE_5', name: 'Toko Kelontong Berkah', address: 'Jl. Melati No. 3, Tanjung Pinang' },
  { placeId: 'DEMO_PLACE_6', name: 'Laundry Wangi Express', address: 'Jl. Sudirman No. 77, Medan' },
  { placeId: 'DEMO_PLACE_7', name: 'Apotek Sehat Sentosa', address: 'Jl. Gajah Mada No. 15, Jakarta' },
];

export async function searchBusinesses(query, sessionToken) {
  const q = query.trim();
  if (q.length < 3) return [];

  if (CONFIG.DEMO_MODE || isPlaceholder(CONFIG.PLACES_API_KEY)) {
    await sleep(350);
    const needle = q.toLowerCase();
    return DEMO_PLACES.filter((p) => `${p.name} ${p.address}`.toLowerCase().includes(needle));
  }

  // TODO(logic): batasi hasil ke bisnis saja (includedPrimaryTypes) / bias lokasi ke Indonesia bila perlu.
  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': CONFIG.PLACES_API_KEY },
    body: JSON.stringify({ input: q, languageCode: 'id', regionCode: 'ID', sessionToken }),
  });
  if (!res.ok) throw new Error(`Places API ${res.status}`);
  const data = await res.json();

  return (data.suggestions || [])
    .filter((s) => s.placePrediction)
    .map((s) => {
      const p = s.placePrediction;
      return {
        placeId: p.placeId,
        name: p.structuredFormat?.mainText?.text || p.text?.text || '',
        address: p.structuredFormat?.secondaryText?.text || '',
      };
    });
}
