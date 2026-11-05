// ============================================================
//  Satap — Cloudflare Pages Function (advanced mode)
//
//  /c/KODE untuk kartu AKTIF -> dibalas 302 langsung ke formulir
//  ulasan Google, tanpa memuat JS apa pun di HP pelanggan.
//  Kartu belum aktif / tidak ketemu / error -> disajikan halaman
//  aktivasi (aset /c) TANPA mengubah URL di address bar, supaya
//  c.html masih bisa membaca kodenya dari path.
//
//  Catatan: Cloudflare Pages memakai pretty URL, jadi aset HTML
//  diakses lewat "/c" (bukan "/c.html" yang akan di-308).
//
//  Env (Cloudflare Pages > Settings > Environment variables):
//    SUPABASE_URL       contoh: https://xxxx.supabase.co
//    SUPABASE_ANON_KEY  publishable key (aman, dipakai browser juga)
// ============================================================

const CODE_RE = /^\/c\/([A-Za-z0-9]{4,12})\/?$/;
const ACTIVATION_ASSET = '/c';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Halaman aktivasi tidak boleh di-cache. Header di-set eksplisit karena
    // _headers tidak ikut terpasang pada response yang dibangun worker.
    const serveActivation = async () => {
      const res = await env.ASSETS.fetch(new Request(new URL(ACTIVATION_ASSET, url.origin), request));
      const headers = new Headers(res.headers);
      headers.set('Cache-Control', 'no-store');
      headers.delete('content-length');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return env.ASSETS.fetch(request);
    }

    const match = url.pathname.match(CODE_RE);
    if (!match) return env.ASSETS.fetch(request);

    const code = match[1].toUpperCase();
    const api = (env.SUPABASE_URL || '').replace(/\/+$/, '');
    const key = env.SUPABASE_ANON_KEY;

    // Tanpa konfigurasi, jangan blokir apa pun.
    if (!api || !key) return serveActivation();

    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    };

    try {
      const res = await fetch(`${api}/rest/v1/rpc/public_card`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ p_code: code }),
        signal: AbortSignal.timeout(2500),
      });

      if (res.ok) {
        const card = await res.json();
        const target = card && card.reviewUrl;

        if (
          card &&
          card.status === 'active' &&
          typeof target === 'string' &&
          target.startsWith('https://search.google.com/')
        ) {
          // Hitung tap di latar belakang; jangan pernah menahan redirect.
          ctx.waitUntil(
            fetch(`${api}/rest/v1/rpc/track_scan`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ p_code: code }),
              signal: AbortSignal.timeout(2000),
            }).catch(() => {})
          );
          return new Response(null, {
            status: 302,
            headers: { Location: target, 'Cache-Control': 'no-store' },
          });
        }
      }
    } catch {
      // jaringan/DB bermasalah -> tampilkan halaman aktivasi apa adanya
    }

    return serveActivation();
  },
};
