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
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
function download(filename, headers, rows) {
  const csv = [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 10);

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
          <button class="btn btn-sm btn-ghost" data-act="block" data-code="${esc(c.code)}">${c.status === 'blocked' ? 'Buka blokir' : 'Blokir'}</button>
        </td>
      </tr>`;
    })
    .join('');
}

async function refresh() {
  cards = await db.adminListCards();
  renderStats();
  renderRows();
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
    `satap-kartu-${stamp()}.csv`,
    ['kode', 'url', 'status', 'bisnis', 'alamat', 'scan', 'batch', 'dibuat'],
    filtered().map((c) => [c.code, cardUrl(c.code), c.status, c.businessName, c.address, c.scanCount, c.batch, new Date(c.createdAt).toISOString()])
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
    lastBatch = { label, rows: made.map((m) => ({ code: m.code, url: cardUrl(m.code), pin: m.pin })) };
    $('#g-result-text').textContent = `${made.length} kartu berhasil dibuat.`;
    $('#g-result').hidden = false;
    await refresh();
  } catch (e2) {
    err.textContent = friendlyError(e2);
  } finally {
    busy(btn, false);
  }
});

$('#g-download').addEventListener('click', () => {
  if (!lastBatch) return;
  const slug = (lastBatch.label || 'batch').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'batch';
  download(`satap-${slug}-${stamp()}.csv`, ['kode', 'url', 'pin'], lastBatch.rows.map((r) => [r.code, r.url, r.pin]));
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
