// Komponen "cari nama bisnis" — dipakai di aktivasi (c.html) dan ganti bisnis (kelola.html).
import { $, esc, debounce } from './ui.js';
import { searchBusinesses, newSessionToken } from './places.js';

let uid = 0;

export function mountPicker(root, { onSelect, label = 'Nama bisnis Anda' }) {
  const id = `picker-${++uid}`;
  root.innerHTML = `
    <label class="label" for="${id}">${esc(label)}</label>
    <div class="search">
      <input id="${id}" class="input" type="search" autocomplete="off" autocapitalize="words"
             spellcheck="false" inputmode="search" placeholder="Contoh: Warung Bu Tini Bandung"
             aria-controls="${id}-list" />
      <span class="spinner search-spin" hidden aria-hidden="true"></span>
    </div>
    <p class="hint">Ketik nama toko lalu pilih dari daftar. Belum ketemu? Tambahkan nama kota.</p>
    <ul class="results" id="${id}-list" aria-label="Hasil pencarian"></ul>
    <p class="empty" role="status" hidden></p>`;

  const input = $('input', root);
  const spin = $('.search-spin', root);
  const list = $('.results', root);
  const empty = $('.empty', root);
  let token = newSessionToken();
  let seq = 0;
  let results = [];

  function showEmpty(msg) {
    empty.textContent = msg;
    empty.hidden = false;
  }

  function render(items) {
    if (!items.length) {
      showEmpty('Belum ketemu. Coba tambahkan nama kota atau jalan, misalnya “Warung Bu Tini Bandung”.');
      return;
    }
    list.innerHTML = items
      .map(
        (p, i) => `
      <li>
        <button type="button" class="result" data-i="${i}">
          <span class="result-pin" aria-hidden="true"><svg class="ic"><use href="/assets/icons.svg#map-pin"></use></svg></span>
          <span class="result-text"><strong>${esc(p.name)}</strong><span class="muted small">${esc(p.address)}</span></span>
        </button>
      </li>`
      )
      .join('');
  }

  const run = debounce(async () => {
    const q = input.value.trim();
    const mine = ++seq;
    list.innerHTML = '';
    empty.hidden = true;
    if (q.length < 3) { spin.hidden = true; return; }
    spin.hidden = false;
    try {
      results = await searchBusinesses(q, token);
      if (mine === seq) render(results);
    } catch {
      if (mine === seq) showEmpty('Pencarian sedang bermasalah. Cek internet lalu coba lagi.');
    } finally {
      if (mine === seq) spin.hidden = true;
    }
  }, 350);

  input.addEventListener('input', run);

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.result');
    if (!btn) return;
    const place = results[Number(btn.dataset.i)];
    if (!place) return;
    token = newSessionToken();
    onSelect(place);
  });

  return {
    reset() { input.value = ''; list.innerHTML = ''; empty.hidden = true; results = []; seq++; },
    focus() { input.focus(); },
  };
}
