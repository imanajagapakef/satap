// ============================================================
//  DATA LAYER — satu-satunya file yang bicara ke database.
//  Halaman (card.js / kelola.js / admin.js) hanya memanggil `db.*`.
//
//  DEMO_MODE=true  -> localStorage (tanpa server, untuk coba UI)
//  DEMO_MODE=false -> Supabase (baca via RPC) + Supabase Auth (admin)
//
//  Semua tulis & cek PIN lewat RPC Postgres (security definer).
//  Client tidak pernah menulis langsung ke tabel (lihat supabase/migrations).
// ============================================================
import { CONFIG, isPlaceholder } from './config.js';
import { reviewUrlFor } from './places.js';

export class SatapError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const okCode = (c) => /^[A-Z0-9]{4,12}$/.test(c || '');
const okPlace = (p) => p && /^[A-Za-z0-9_-]{6,200}$/.test(p.placeId || '') && !!p.name;

// ---- konversi timestamp Postgres (ISO) -> milidetik untuk UI --------------
const tsToMs = (v) => (v ? Date.parse(v) : null);

// ---- bentuk data yang dikirim ke UI --------------------------------------
// public : boleh dibaca siapa pun yang tahu kodenya (dipakai halaman redirect)
// owner  : setelah PIN benar
// admin  : khusus admin
const publicView = (c) => ({
  code: c.code, status: c.status,
  businessName: c.business_name ?? c.businessName ?? '',
  address: c.address || '',
  placeId: c.place_id ?? c.placeId ?? '',
  reviewUrl: c.review_url ?? c.reviewUrl ?? '',
});
const ownerView = (c) => ({
  ...publicView(c),
  scanCount: c.scan_count ?? c.scanCount ?? 0,
  lastScanAt: c.last_scan_at !== undefined ? tsToMs(c.last_scan_at) : (c.lastScanAt ?? null),
  activatedAt: c.activated_at !== undefined ? tsToMs(c.activated_at) : (c.activatedAt ?? null),
});
// RPC owner_json() sudah mengirim camelCase, jadi dipakai apa adanya.
const adminView = (c) => ({ ...ownerView(c), createdAt: tsToMs(c.created_at ?? c.createdAt), batch: c.batch || '' });

const placeFields = (place) => ({
  placeId: place.placeId,
  businessName: place.name,
  address: place.address || '',
  reviewUrl: reviewUrlFor(place.placeId),
});

// ---- util acak ------------------------------------------------------------
const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // tanpa 0/O/1/I agar tidak salah baca
export function randomCode(len = 6) {
  const a = new Uint32Array(len);
  crypto.getRandomValues(a);
  return [...a].map((n) => ALPHA[n % ALPHA.length]).join('');
}
export function randomPin(len = CONFIG.PIN_LENGTH) {
  const a = new Uint32Array(len);
  crypto.getRandomValues(a);
  return [...a].map((n) => n % 10).join('');
}
const randomSalt = () => {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
};
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================
//  1) DEMO (localStorage)
// ============================================================
const KEY = 'ulasin_demo_v1';
const DEMO_ACTIVE = { placeId: 'DEMO_PLACE_2', name: 'Kopi Senja', address: 'Jl. Dago No. 45, Bandung' };

async function makeCard(code, pin, extra = {}) {
  const salt = randomSalt();
  return { code, status: 'inactive', salt, pinHash: await sha256(salt + pin), scanCount: 0, createdAt: Date.now(), ...extra };
}

async function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* data rusak -> seed ulang */ }
  const s = { cards: {} };
  s.cards.DEMO01 = await makeCard('DEMO01', '123456');
  s.cards.DEMO02 = await makeCard('DEMO02', '654321', {
    status: 'active', ...placeFields(DEMO_ACTIVE),
    scanCount: 87, activatedAt: Date.now() - 864e5 * 3, lastScanAt: Date.now() - 36e5,
  });
  write(s);
  return s;
}
function write(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage penuh/diblokir */ }
}
function need(s, code) {
  const c = okCode(code) ? s.cards[code] : null;
  if (!c) throw new SatapError('not-found');
  return c;
}
async function checkPin(c, pin) {
  if (c.status === 'blocked') throw new SatapError('blocked');
  if ((await sha256(c.salt + String(pin))) !== c.pinHash) throw new SatapError('wrong-pin');
}

const demo = {
  async getCard(code) {
    await sleep(250);
    const s = await read();
    const c = okCode(code) ? s.cards[code] : null;
    return c ? publicView(c) : null;
  },
  async trackScan(code) {
    const s = await read();
    const c = s.cards[code];
    if (!c || c.status !== 'active') return;
    c.scanCount = (c.scanCount || 0) + 1;
    c.lastScanAt = Date.now();
    write(s);
  },
  async verifyOwner(code, pin) {
    await sleep(300);
    const s = await read();
    const c = need(s, code);
    await checkPin(c, pin);
    return ownerView(c);
  },
  async activateCard({ code, pin, place }) {
    await sleep(400);
    const s = await read();
    const c = need(s, code);
    await checkPin(c, pin);
    if (c.status === 'active') throw new SatapError('already-active');
    if (!okPlace(place)) throw new SatapError('invalid');
    Object.assign(c, placeFields(place), { status: 'active', activatedAt: Date.now() });
    write(s);
    return ownerView(c);
  },
  async updateTarget({ code, pin, place }) {
    await sleep(400);
    const s = await read();
    const c = need(s, code);
    await checkPin(c, pin);
    if (c.status !== 'active' || !okPlace(place)) throw new SatapError('invalid');
    Object.assign(c, placeFields(place));
    write(s);
    return ownerView(c);
  },

  // --- admin (demo: sandi = "admin") ---
  async adminLogin(_email, password) {
    await sleep(300);
    if (password !== 'admin') throw new SatapError('bad-login');
    sessionStorage.setItem('ulasin_demo_admin', '1');
  },
  async adminSession() { return sessionStorage.getItem('ulasin_demo_admin') === '1'; },
  async adminLogout() { sessionStorage.removeItem('ulasin_demo_admin'); },
  async adminListCards() {
    const s = await read();
    return Object.values(s.cards).sort((a, b) => b.createdAt - a.createdAt).map(adminView);
  },
  async adminGenerateBatch({ count, label }) {
    await sleep(300);
    const n = Math.floor(Number(count));
    if (!(n >= 1 && n <= 500)) throw new SatapError('invalid');
    const s = await read();
    const out = [];
    while (out.length < n) {
      const code = randomCode();
      if (s.cards[code]) continue;
      const pin = randomPin();
      s.cards[code] = await makeCard(code, pin, { batch: label || '' });
      out.push({ code, pin });
    }
    write(s);
    return out;
  },
  async adminResetPins({ codes = null, batch = null }) {
    const s = await read();
    const list = Object.values(s.cards).filter((c) =>
      codes && codes.length ? codes.includes(c.code) : batch ? c.batch === batch : false
    );
    if (!list.length) throw new SatapError('not-found');
    const out = [];
    for (const c of list) {
      const pin = randomPin();
      c.salt = randomSalt();
      c.pinHash = await sha256(c.salt + pin);
      out.push({ code: c.code, pin });
    }
    write(s);
    return out;
  },
  async adminSetBlocked(code, blocked) {
    const s = await read();
    const c = need(s, code);
    c.status = blocked ? 'blocked' : c.placeId ? 'active' : 'inactive';
    write(s);
  },
};

// ============================================================
//  2) REAL (Supabase)
//  - Baca kartu publik   : RPC public_card(code)
//  - Semua yang perlu PIN : RPC verify_owner / activate_card / update_target
//  - Admin                : Supabase Auth + RPC generate_batch / set_card_blocked
//  Definisi RPC ada di supabase/migrations/*.sql
// ============================================================
let sbPromise;
function supa() {
  sbPromise ??= (async () => {
    if (isPlaceholder(CONFIG.SUPABASE.url) || isPlaceholder(CONFIG.SUPABASE.anonKey)) {
      throw new SatapError('config');
    }
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.45.4');
    return createClient(CONFIG.SUPABASE.url, CONFIG.SUPABASE.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  })();
  return sbPromise;
}

function mapError(e) {
  if (e instanceof SatapError) return e;
  const msg = String(e?.message || e?.error_description || e || '');
  const code = String(e?.code || '');
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return new SatapError('bad-login');
  if (/email not confirmed/i.test(msg)) return new SatapError('bad-login');
  if (code === 'user_not_found') return new SatapError('bad-login');
  if (/failed to fetch|networkerror|load failed/i.test(msg) || e instanceof TypeError) return new SatapError('network');
  if (/forbidden|permission denied|row-level security/i.test(msg)) return new SatapError('permission-denied');
  if (/not found/i.test(msg)) return new SatapError('not-found');
  return new SatapError('unknown', msg);
}

// RPC kita mengembalikan { ok:false, reason } tanpa raise -> diterjemahkan di sini.
function unwrap(data) {
  if (!data || data.ok !== true) throw new SatapError((data && data.reason) || 'unknown');
  return data.card;
}

async function rpc(name, args) {
  const sb = await supa();
  const { data, error } = await sb.rpc(name, args);
  if (error) throw mapError(error);
  return data;
}

const real = {
  async getCard(code) {
    if (!okCode(code)) return null;
    const data = await rpc('public_card', { p_code: code });
    return data ? publicView(data) : null;
  },
  trackScan: async (code) => { await rpc('track_scan', { p_code: code }); },

  verifyOwner: async (code, pin) => unwrap(await rpc('verify_owner', { p_code: code, p_pin: pin })),
  activateCard: async ({ code, pin, place }) =>
    unwrap(await rpc('activate_card', {
      p_code: code, p_pin: pin,
      p_place_id: place?.placeId, p_name: place?.name, p_address: place?.address || '',
    })),
  updateTarget: async ({ code, pin, place }) =>
    unwrap(await rpc('update_target', {
      p_code: code, p_pin: pin,
      p_place_id: place?.placeId, p_name: place?.name, p_address: place?.address || '',
    })),

  // --- admin ---
  async adminLogin(email, password) {
    const sb = await supa();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw mapError(error);
    const { data: row, error: e2 } = await sb
      .from('admins').select('user_id').eq('user_id', data.user.id).maybeSingle();
    if (e2) { await sb.auth.signOut(); throw mapError(e2); }
    if (!row) { await sb.auth.signOut(); throw new SatapError('not-admin'); }
  },
  async adminSession() {
    const sb = await supa();
    const { data } = await sb.auth.getSession();
    const u = data?.session?.user;
    if (!u) return false;
    const { data: row } = await sb.from('admins').select('user_id').eq('user_id', u.id).maybeSingle();
    return !!row;
  },
  async adminLogout() {
    const sb = await supa();
    await sb.auth.signOut();
  },
  async adminListCards() {
    const sb = await supa();
    const { data, error } = await sb
      .from('cards').select('*').order('created_at', { ascending: false }).limit(500);
    if (error) throw mapError(error);
    return (data || []).map(adminView);
  },
  async adminGenerateBatch({ count, label }) {
    return await rpc('generate_batch', { p_count: Math.floor(Number(count)), p_label: label || '' });
  },
  async adminResetPins({ codes = null, batch = null }) {
    const data = await rpc('reset_card_pins', { p_codes: codes, p_batch: batch });
    if (!data || data.ok !== true) throw new UlasinError((data && data.reason) || 'unknown');
    return data.cards || [];
  },
  adminSetBlocked: async (code, blocked) => rpc('set_card_blocked', { p_code: code, p_blocked: !!blocked }),
};

export const db = CONFIG.DEMO_MODE ? demo : real;
