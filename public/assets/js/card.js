// Halaman /c/{kode}: redirect (kartu aktif) ATAU aktivasi (kartu belum aktif) ATAU error.
import { CONFIG } from './config.js';
import { db } from './db.js';
import { mountPicker } from './picker.js';
import { $, $$, esc, setView, setStep, busy, friendlyError, getCodeFromUrl, mountDemoBar, waLink } from './ui.js';

mountDemoBar();

const code = getCodeFromUrl();
const state = { pin: '', place: null };
let picker;

// ---------- error page ----------
const ERRORS = {
  'no-code': { icon: '🧐', title: 'Alamat kartu tidak lengkap', text: 'Coba tap atau scan ulang kartunya.' },
  'not-found': { icon: '🙈', title: 'Kartu tidak dikenali', text: 'Kode kartu ini tidak ada di sistem kami. Periksa lagi kartunya atau hubungi kami.' },
  blocked: { icon: '⛔', title: 'Kartu dinonaktifkan', text: 'Kartu ini sedang tidak bisa dipakai. Silakan hubungi pemilik kartu atau kami.' },
  network: { icon: '📶', title: 'Koneksi bermasalah', text: 'Cek internet Anda lalu coba lagi.', retry: true },
  unknown: { icon: '😅', title: 'Ada kendala', text: 'Kami belum bisa membuka kartu ini. Coba lagi sebentar lagi.', retry: true },
};

function showError(kind) {
  const e = ERRORS[kind] || ERRORS.unknown;
  $('#err-icon').textContent = e.icon;
  $('#err-title').textContent = e.title;
  $('#err-text').textContent = e.text;
  $('#err-retry').hidden = !e.retry;
  $('#err-help').hidden = kind === 'network';
  $('#err-help').href = waLink();
  setView('error');
}

// ---------- redirect (kartu aktif) ----------
async function doRedirect(card) {
  // Pertahanan: hanya izinkan tujuan ke Google.
  if (!String(card.reviewUrl).startsWith('https://search.google.com/')) return showError('unknown');

  setView('redirect');
  const link = $('#redirect-link');
  link.href = card.reviewUrl;

  if (CONFIG.DEMO_MODE) {
    // Di demo kita tidak benar-benar pindah (Place ID palsu), cukup tunjukkan tujuannya.
    $('#demo-note').hidden = false;
    $('#demo-url').textContent = card.reviewUrl;
    link.hidden = false;
    db.trackScan(code).catch(() => {});
    return;
  }

  // Hitung scan, tapi jangan tunggu lebih dari 400ms agar redirect tetap cepat.
  await Promise.race([db.trackScan(code).catch(() => {}), new Promise((r) => setTimeout(r, 400))]);
  location.replace(card.reviewUrl);
  setTimeout(() => { link.hidden = false; }, 3000); // cadangan kalau redirect tertahan
}

// ---------- aktivasi (kartu belum aktif) ----------
const STEP_NUM = { pin: 1, search: 2, confirm: 3 };

function goStep(name) {
  setStep(name);
  const n = STEP_NUM[name];
  $('#steps').hidden = !n;
  $$('#steps li').forEach((li, i) => {
    li.classList.toggle('is-active', i === n - 1);
    li.classList.toggle('is-done', i < n - 1);
    if (i === n - 1) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  window.scrollTo({ top: 0 });
}

function bizHtml(p) {
  return `<span class="biz-pin" aria-hidden="true">📍</span>
          <div><strong>${esc(p.name || p.businessName)}</strong><div class="muted small">${esc(p.address)}</div></div>`;
}

function startActivation(card) {
  $('#card-code').textContent = card.code;
  const pinInput = $('#pin');
  pinInput.maxLength = CONFIG.PIN_LENGTH;
  $('#pin-lead').textContent = `Masukkan PIN ${CONFIG.PIN_LENGTH} angka yang tertera di bagian belakang kartu.`;

  picker = mountPicker($('#picker'), {
    onSelect: (p) => {
      state.place = p;
      $('#confirm-biz').innerHTML = bizHtml(p);
      $('#confirm-error').textContent = '';
      goStep('confirm');
    },
  });

  goStep('pin');
  setView('activate');
  pinInput.focus();
}

$('#pin').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, CONFIG.PIN_LENGTH);
});

$('#pin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pin = $('#pin').value.trim();
  const err = $('#pin-error');
  err.textContent = '';
  if (pin.length !== CONFIG.PIN_LENGTH) { err.textContent = `PIN terdiri dari ${CONFIG.PIN_LENGTH} angka.`; return; }

  const btn = $('#pin-next');
  busy(btn, true, 'Memeriksa…');
  try {
    await db.verifyOwner(code, pin); // cek PIN lebih awal supaya salah PIN ketahuan di langkah 1
    state.pin = pin;
    goStep('search');
    picker.focus();
  } catch (e2) {
    err.textContent = friendlyError(e2);
  } finally {
    busy(btn, false);
  }
});

$('#search-back').addEventListener('click', () => goStep('pin'));

$('#confirm-no').addEventListener('click', () => {
  picker.reset();
  goStep('search');
  picker.focus();
});

$('#confirm-yes').addEventListener('click', async () => {
  const btn = $('#confirm-yes');
  const err = $('#confirm-error');
  err.textContent = '';
  busy(btn, true, 'Mengaktifkan…');
  try {
    const card = await db.activateCard({ code, pin: state.pin, place: state.place });
    $('#done-name').textContent = card.businessName;
    $('#done-test').href = card.reviewUrl;
    $('#done-manage').href = `/kelola.html?c=${encodeURIComponent(code)}`;
    goStep('done');
  } catch (e2) {
    err.textContent = friendlyError(e2);
  } finally {
    busy(btn, false);
  }
});

$('#err-retry').addEventListener('click', boot);

// ---------- start ----------
async function boot() {
  if (!code) return showError('no-code');
  setView('loading');
  try {
    const card = await db.getCard(code);
    if (!card) return showError('not-found');
    if (card.status === 'blocked') return showError('blocked');
    if (card.status === 'active') return doRedirect(card);
    startActivation(card);
  } catch (e) {
    showError(e?.code === 'network' ? 'network' : 'unknown');
  }
}

boot();
