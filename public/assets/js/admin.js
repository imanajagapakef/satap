// Admin: buat batch kartu, ekspor CSV untuk encoding NFC, pantau & blokir kartu.
import { CONFIG } from './config.js';
import { db } from './db.js';
import { $, esc, setView, toast, copyText, busy, friendlyError, fmtNum, fmtDate, cardUrl, mountDemoBar } from './ui.js';

mountDemoBar();

let cards = [];
let lastBatch = null; // { rows:[{code,url,pin}], label }

const STATUS = {
  active: ['Aktif', 'badge-ok'],
  inactive: ['Belum aktif', 'badge-idle'],
  blocked: ['Diblokir', 'badge-bad'],
};

// ---------- CSV ----------
// Catatan kompatibilitas Excel:
//  - pemisah ";" + baris "sep=;"  -> Excel (locale Indonesia MAUPUN English) memecah kolom dengan benar
//  - BOM UTF-8                    -> nama bisnis beraksen tidak rusak
//  - kolom teks ditulis ="..."    -> angka seperti PIN 042299 tetap tampil 6 digit (nol depan tidak hilang)
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csvText = (v) => `="${String(v ?? '').replace(/"/g, '')}"`;
const CSV_SEP = ';';

function download(filename, headers, rows, opts = {}) {
  const textCols = opts.text || [];
  const line = (cells) => cells.join(CSV_SEP);
  const body = [
    `sep=${CSV_SEP}`,
    line(headers.map(csvCell)),
    ...rows.map((r) => line(r.map((v, i) => (textCols.includes(headers[i]) ? csvText(v) : csvCell(v))))),
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF' + body + '\r\n'], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 10);
const STATUS_CSV = { active: 'Aktif', inactive: 'Belum aktif', blocked: 'Diblokir' };

// ---------- tabel ----------
function filtered() {
  const q = $('#f-q').value.trim().toLowerCase();
  const st = $('#f-status').value;
  return cards.filter(
    (c) => (!st || c.status === st) && (!q || `${c.code} ${c.businessName} ${c.batch}`.toLowerCase().includes(q))
  );
}

function renderStats() {
  $('#s-total').textContent = fmtNum(cards.length);
  $('#s-active').textContent = fmtNum(cards.filter((c) => c.status === 'active').length);
  $('#s-idle').textContent = fmtNum(cards.filter((c) => c.status === 'inactive').length);
  $('#s-scans').textContent = fmtNum(cards.reduce((n, c) => n + (c.scanCount || 0), 0));
}

function renderRows() {
  const rows = filtered();
  $('#a-empty').hidden = rows.length > 0;
  $('#a-rows').innerHTML = rows
    .map((c) => {
      const [label, cls] = STATUS[c.status] || STATUS.inactive;
      return `<tr>
        <td><span class="chip">${esc(c.code)}</span></td>
        <td><span class="badge ${cls}">${label}</span></td>
        <td>${c.businessName ? `<strong>${esc(c.businessName)}</strong><div class="muted small">${esc(c.address)}</div>` : '<span class="muted">—</span>'}</td>
        <td class="num">${fmtNum(c.scanCount)}</td>
        <td class="small">${esc(c.batch || '—')}<div class="muted">${fmtDate(c.createdAt)}</div></td>
        <td class="actions">
          <button class="btn btn-sm btn-ghost" data-act="copy" data-code="${esc(c.code)}">Salin URL</button>
          <button class="btn btn-sm btn-ghost" data-act="reset" data-code="${esc(c.code)}">Reset PIN</button>
          <button class="btn btn-sm btn-ghost" data-act="block" data-code="${esc(c.code)}">${c.status === 'blocked' ? 'Buka blokir' : 'Blokir'}</button>
        </td>
      </tr>`;
    })
    .join('');
}

function renderBatches() {
  const sel = $('#r-batch');
  if (!sel) return;
  const prev = sel.value;
  const labels = [...new Set(cards.map((c) => c.batch).filter(Boolean))].sort();
  sel.innerHTML = labels.length
    ? labels.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join('')
    : '<option value="">(belum ada batch)</option>';
  if (labels.includes(prev)) sel.value = prev;
}

async function refresh() {
  cards = await db.adminListCards();
  renderStats();
  renderRows();
  renderBatches();
}

$('#f-q').addEventListener('input', renderRows);
$('#f-status').addEventListener('change', renderRows);

$('#a-rows').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const code = btn.dataset.code;
  if (btn.dataset.act === 'copy') {
    toast((await copyText(cardUrl(code))) ? 'URL kartu disalin' : 'Gagal menyalin');
    return;
  }
  if (btn.dataset.act === 'reset') {
    if (!confirm(`Reset PIN kartu ${code}?\n\nPIN lama langsung tidak berlaku.`)) return;
    busy(btn, true, '...');
    try {
      const made = await db.adminResetPins({ codes: [code] });
      const pin = (made[0] && made[0].pin) || '—';
      showPins($('#r-result'), $('#r-result-text'), code, made, `PIN baru untuk ${code}: ${pin}`);
      toast('PIN direset');
      $('#r-result').scrollIntoView({ block: 'center' });
    } catch (e2) {
      toast(friendlyError(e2), 'err');
    } finally {
      busy(btn, false);
    }
    return;
  }
  const card = cards.find((c) => c.code === code);
  const block = card.status !== 'blocked';
  if (!confirm(block ? `Blokir kartu ${code}? Pelanggan yang tap akan melihat pesan "kartu dinonaktifkan".` : `Buka blokir kartu ${code}?`)) return;
  busy(btn, true, '…');
  try {
    await db.adminSetBlocked(code, block);
    await refresh();
    toast(block ? 'Kartu diblokir' : 'Blokir dibuka');
  } catch (e2) {
    toast(friendlyError(e2), 'err');
    busy(btn, false);
  }
});

$('#a-export').addEventListener('click', () => {
  download(
    `satap-daftar-kartu-${stamp()}.csv`,
    ['no', 'kode', 'url', 'status', 'bisnis', 'alamat', 'tap', 'batch', 'dibuat'],
    filtered().map((c, i) => [
      i + 1, c.code, cardUrl(c.code), STATUS_CSV[c.status] || c.status,
      c.businessName, c.address, c.scanCount, c.batch, fmtDate(c.createdAt),
    ])
  );
});

// ---------- generate batch ----------
$('#gen-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#g-error');
  err.textContent = '';
  const count = Math.floor(Number($('#g-count').value));
  const label = $('#g-label').value.trim();
  if (!(count >= 1 && count <= 500)) { err.textContent = 'Jumlah kartu antara 1 sampai 500.'; return; }

  const btn = $('#g-btn');
  busy(btn, true, 'Membuat…');
  try {
    const made = await db.adminGenerateBatch({ count, label });
    showPins($('#g-result'), $('#g-result-text'), label, made, `${made.length} kartu berhasil dibuat.`);
    await refresh();
  } catch (e2) {
    err.textContent = friendlyError(e2);
  } finally {
    busy(btn, false);
  }
});

// Simpan hasil (untuk CSV) dan tampilkan di kotak hasil.
function showPins(boxEl, textEl, label, made, text) {
  lastBatch = { label, rows: made.map((m) => ({ code: m.code, url: cardUrl(m.code), pin: m.pin })) };
  textEl.textContent = text;
  boxEl.hidden = false;
}

function downloadLastBatch() {
  if (!lastBatch) return;
  const slug = (lastBatch.label || 'batch').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'batch';
  download(
    `satap-${slug}-${stamp()}.csv`,
    ['no', 'kode', 'url', 'pin'],
    lastBatch.rows.map((r, i) => [i + 1, r.code, r.url, r.pin]),
    { text: ['pin'] }
  );
}

$('#g-download').addEventListener('click', downloadLastBatch);
$('#r-download').addEventListener('click', downloadLastBatch);

// ---------- reset PIN ----------
$('#reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#r-error');
  err.textContent = '';
  $('#r-result').hidden = true;

  const batch = $('#r-batch').value;
  if (!batch) { err.textContent = 'Belum ada batch untuk direset.'; return; }
  if (!confirm(`Reset PIN SEMUA kartu di batch "${batch}"?\n\nPIN lama langsung tidak berlaku, termasuk yang sudah dicetak.`)) return;

  const btn = $('#r-btn');
  busy(btn, true, 'Mereset...');
  try {
    const made = await db.adminResetPins({ batch });
    showPins($('#r-result'), $('#r-result-text'), batch, made, `${made.length} PIN berhasil direset (batch "${batch}").`);
    toast(`${made.length} PIN direset`);
    await refresh();
  } catch (e2) {
    err.textContent = friendlyError(e2);
  } finally {
    busy(btn, false);
  }
});

// ---------- login ----------
async function openApp() {
  setView('loading');
  try {
    await refresh();
    setView('app');
  } catch (e) {
    setView('login');
    $('#al-error').textContent = friendlyError(e);
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#al-error');
  err.textContent = '';
  const btn = $('#al-btn');
  busy(btn, true, 'Masuk…');
  try {
    await db.adminLogin($('#al-email').value.trim(), $('#al-pass').value);
    $('#al-pass').value = '';
    await openApp();
  } catch (e2) {
    err.textContent = friendlyError(e2);
  } finally {
    busy(btn, false);
  }
});

$('#a-logout').addEventListener('click', async () => {
  await db.adminLogout();
  lastBatch = null;
  $('#g-result').hidden = true;
  setView('login');
});

(async function boot() {
  $('#al-email-row').hidden = CONFIG.DEMO_MODE; // demo cukup sandi
  setView('loading');
  try {
    if (await db.adminSession()) return openApp();
  } catch { /* lanjut ke login */ }
  setView('login');
}());
