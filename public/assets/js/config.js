// ============================================================
//  SATAP — KONFIGURASI
//  Semua yang perlu Anda isi ada di file ini.
// ============================================================

export const CONFIG = {
  // true  = jalan lokal tanpa server (data disimpan di browser, untuk coba UI/UX)
  // false = pakai Supabase + Google Places sungguhan
  DEMO_MODE: false,

  BRAND: { name: 'Satap', tagline: 'Tap kartunya, ulasan masuk.' },

  // Nomor WhatsApp bantuan, format internasional tanpa "+" (contoh: 6281234567890)
  SUPPORT_WA: '6289637873386',

  // Supabase Dashboard > Project Settings > API
  // anonKey (publishable) AMAN dipakai di browser — dilindungi RLS.
  SUPABASE: {
    url: 'https://hgoexsrivadbtngydnon.supabase.co',
    anonKey: 'sb_publishable_mKY_7cXC6Q5XL63P0djnvw_UZZVyedc',
  },

  // Google Cloud Console > APIs & Services > "Places API (New)" > Credentials.
  // WAJIB dibatasi: HTTP referrer = domain Anda, API restriction = Places API (New).
  PLACES_API_KEY: 'AIzaSyDF7u0DRiQgJ-0Ou3J2658M9dR64fQ3f4E',

  // Path publik kartu (harus cocok dengan "rewrites" di _redirects)
  CARD_PATH: '/c/',

  // Panjang PIN kartu
  PIN_LENGTH: 6,
};

export const isPlaceholder = (v) =>
  !v || String(v).startsWith('ISI_') || String(v).startsWith('YOUR_');
