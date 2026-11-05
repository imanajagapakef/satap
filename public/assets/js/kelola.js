// Dashboard pemilik: masuk pakai kode kartu + PIN, lihat statistik, ganti bisnis.
import { CONFIG } from './config.js';
import { db } from './db.js';
import { mountPicker } from './picker.js';
import {
  $, esc, setView, setStep, toast, copyText, busy, friendlyError,
  fmtNum, fmtDate, cardUrl, getCodeFromUrl, mountDemoBar, waHelp,
} from './ui.js';

mountDemoBar();

const SKEY = 'ulasin_owner';
let session = null; // { code, pin }
let card = null;
let pendingPlace = null;
let picker;

const bizHtml = (name, address) =>
  `<span class="biz-pin" aria-hidden="true"><svg class="ic"><use href="/assets/icons.svg#map-pin"></use></svg></span><div><strong>${esc(name)}</strong><div class="muted small">${esc(address)}</div></div>`;

// ---------- dashboard ----------
function renderDash() {
  $('#d-code').textContent = card.code;
  $('#d-help').href = waHelp(card.code);

  const badge = $('#d-badge');
  const map = { active: ['Aktif', 'badge-ok'], inactive: ['Belum aktif', 'badge-idle'], blocked: ['Dinonaktifkan', 'badge-bad'] };
  const [label, cls] = map[card.status] || map.inactive;
  badge.textContent = label;
  badge.className = `badge ${cls}`;

  $('#d-title').textContent = card.status === 'active' ? card.businessName : 'Kartu Anda';
  $('#d-inactive').hidden = card.status !== 'inactive';
  $('#d-blocked').hidden = card.status !== 'blocked';
  $('#d-active').hidden = card.status !== 'active';

  $('#d-activate').href = `/c.html?c=${encodeURIComponent(card.code)}`;

  if (card.status === 'active') {
    $('#d-scans').textContent = fmtNum(card.scanCount);
    $('#d-last').textContent = card.lastScanAt ? `Terakhir di-tap: ${fmtDate(card.lastScanAt)}` : 'Belum ada yang tap.';
    $('#d-biz').innerHTML = bizHtml(card.businessName, card.address);
    $('#d-test').href = card.reviewUrl;
    $('#d-cardurl').textContent = cardUrl(card.code);
  }
  setView('dash');
}

async function login(code, pin) {
  card = await db.verifyOwner(code, pin);
  session = { code, pin };
  try { sessionStorage.setItem(SKEY, JSON.stringify(session)); } catch { /* abaikan */ }
  // TODO(logic): simpan PIN di sessionStorage hanya untuk kemudahan scaffold.
  // Di produksi, tukar PIN dengan token sesi singkat dari Cloud Function.
  renderDash();
}

function logout() {
  session = null;
  card = null;
  try { sessionStorage.removeItem(SKEY); } catch { /* abaikan */ }
  $('#login-pin').value = '';
  setView('login');
}

$('#login-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('#login-pin').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, CONFIG.PIN_LENGTH); });

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#login-code').value.trim();
  const pin = $('#login-pin').value.trim();
  const err = $('#login-error');
  err.textContent = '';
  if (!code) { err.textContent = 'Isi kode kartu dulu ya.'; return; }
  if (pin.length !== CONFIG.PIN_LENGTH) { err.textContent = `PIN terdiri dari ${CONFIG.PIN_LENGTH} angka.`; return; }
  const btn = $('#login-btn');
  busy(btn, true, 'Memeriksa…');
  try {
    await login(code, pin);
  } catch (e2) {
    err.textContent = friendlyError(e2);
  } finally {
    busy(btn, false);
  }
});

$('#d-logout').addEventListener('click', logout);

$('#d-copy-review').addEventListener('click', async () => {
  toast((await copyText(card.reviewUrl)) ? 'Link ulasan disalin' : 'Gagal menyalin', 'ok');
});
$('#d-copy-card').addEventListener('click', async () => {
  toast((await copyText(cardUrl(card.code))) ? 'Link kartu disalin' : 'Gagal menyalin', 'ok');
});

// ---------- ganti bisnis ----------
function startChange() {
  pendingPlace = null;
  picker.reset();
  setStep('pick');
  setView('change');
  picker.focus();
}

picker = mountPicker($('#c-picker'), {
  label: 'Nama bisnis baru',
  onSelect: (p) => {
    pendingPlace = p;
    $('#c-biz').innerHTML = bizHtml(p.name, p.address);
    $('#c-error').textContent = '';
    setStep('confirm');
  },
});

$('#d-change').addEventListener('click', startChange);
$('#c-cancel').addEventListener('click', renderDash);
$('#c-no').addEventListener('click', startChange);

$('#c-yes').addEventListener('click', async () => {
  const btn = $('#c-yes');
  $('#c-error').textContent = '';
  busy(btn, true, 'Menyimpan…');
  try {
    card = await db.updateTarget({ code: session.code, pin: session.pin, place: pendingPlace });
    renderDash();
    toast('Tujuan ulasan sudah diganti');
  } catch (e) {
    $('#c-error').textContent = friendlyError(e);
  } finally {
    busy(btn, false);
  }
});

// ---------- start ----------
(async function boot() {
  const fromUrl = getCodeFromUrl();
  if (fromUrl) $('#login-code').value = fromUrl;

  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(SKEY) || 'null'); } catch { /* abaikan */ }

  if (saved?.code && saved?.pin && (!fromUrl || fromUrl === saved.code)) {
    setView('loading');
    try { await login(saved.code, saved.pin); return; } catch { /* sesi kedaluwarsa -> form login */ }
  }
  setView('login');
  (fromUrl ? $('#login-pin') : $('#login-code')).focus();
})();
