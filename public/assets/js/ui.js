// Helper UI yang dipakai semua halaman.
import { CONFIG } from './config.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Tampilkan satu "view" (section[data-view]) dan sembunyikan sisanya.
export function setView(name) {
  $$('[data-view]').forEach((el) => { el.hidden = el.dataset.view !== name; });
  window.scrollTo({ top: 0 });
}

// Tampilkan satu langkah (div[data-step]) di dalam view aktif.
export function setStep(name) {
  $$('[data-step]').forEach((el) => { el.hidden = el.dataset.step !== name; });
}

export function toast(msg, type = 'ok') {
  let t = $('#toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = `toast toast-${type} show`;
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2800);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* abaikan */ }
    ta.remove();
    return ok;
  }
}

export const debounce = (fn, ms = 300) => {
  let h;
  return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
};

// Tombol "sedang proses": nonaktifkan + ganti teks, lalu kembalikan.
export function busy(btn, on, text) {
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    if (text) btn.textContent = text;
  } else {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
  }
}

export const fmtNum = (n) => new Intl.NumberFormat('id-ID').format(n ?? 0);
export const fmtDate = (ms) =>
  ms ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)) : '—';

// URL publik kartu = isi chip NFC / QR code.
export const cardUrl = (code) => `${location.origin}${CONFIG.CARD_PATH}${code}`;

// Ambil kode kartu dari /c/KODE (produksi) atau ?c=KODE (dev lokal tanpa rewrite).
export function getCodeFromUrl() {
  const m = location.pathname.match(/\/c\/([^/?#]+)/);
  const raw = m ? decodeURIComponent(m[1]) : new URLSearchParams(location.search).get('c');
  return raw ? raw.trim().toUpperCase() : null;
}

// WhatsApp: nomor dari config, dengan draft pesan yang sudah terisi.
const waNumber = () => String(CONFIG.SUPPORT_WA).replace(/\D/g, '');
export const waLink = (text) => {
  const base = `https://wa.me/${waNumber()}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
};

// Draft untuk calon pembeli — tinggal isi titik-titiknya.
export const waOrder = () =>
  waLink(
    'Halo Satap, saya mau pesan kartu ulasan Google.\n\n' +
    'Nama usaha: \n' +
    'Kota: \n' +
    'Jumlah kartu: \n\n' +
    'Terima kasih.'
  );

// Draft untuk pemilik kartu yang butuh bantuan.
export const waHelp = (code) =>
  waLink(
    'Halo Satap, saya butuh bantuan soal kartu ulasan.\n\n' +
    (code ? `Kode kartu: ${code}\n` : '') +
    'Kendala: '
  );

export function mountDemoBar() {
  if (!CONFIG.DEMO_MODE) return;
  const d = document.createElement('div');
  d.className = 'demo-bar';
  d.textContent = 'MODE DEMO · data hanya tersimpan di browser ini';
  document.body.prepend(d);
  $$('[data-demo-only]').forEach((el) => { el.hidden = false; });
}

// Pesan error ramah untuk pengguna awam (tanpa istilah teknis).
export function friendlyError(err) {
  switch (err?.code) {
    case 'wrong-pin': return 'PIN salah. Cek lagi angka di bagian belakang kartu.';
    case 'locked': return 'Terlalu banyak percobaan. Coba lagi 15 menit lagi.';
    case 'not-found': return 'Kartu tidak ditemukan.';
    case 'blocked': return 'Kartu ini dinonaktifkan. Silakan hubungi kami.';
    case 'already-active': return 'Kartu ini sudah aktif. Gunakan menu Kelola kartu untuk mengubahnya.';
    case 'invalid': return 'Data belum lengkap. Coba pilih tokonya lagi.';
    case 'invalid-place': return 'Toko itu tidak ditemukan di Google. Coba cari dan pilih ulang.';
    case 'network': return 'Koneksi bermasalah. Cek internet lalu coba lagi.';
    case 'bad-login': return 'Email atau kata sandi salah.';
    case 'not-admin':
    case 'permission-denied': return 'Akun ini tidak punya akses admin.';
    case 'config': return 'Konfigurasi belum diisi (lihat config.js).';
    default: return 'Terjadi kendala. Coba lagi sebentar lagi.';
  }
}
