# Satap — kartu NFC/QR ulasan Google

Kartu NFC/QR yang sekali tap langsung membuka formulir ulasan Google toko. Tema hangat untuk UMKM, tanpa build step: HTML + CSS + JavaScript (ES modules).

- **Database & backend**: Supabase (Postgres + RPC + Auth)
- **Hosting**: Cloudflare Pages (+ `_worker.js` untuk redirect kilat)
- **Pencarian bisnis**: Google Places API (New)

## Struktur

```
public/                       <- Cloudflare Pages (root statis)
  index.html                  landing page
  harga.html                  halaman harga
  c.html                      /c/{kode}: aktivasi 3 langkah | error
  kelola.html                 dashboard pemilik (kode kartu + PIN)
  admin.html                  admin: buat batch, ekspor CSV, blokir
  404.html
  _worker.js                  redirect 302 milidetik untuk kartu aktif
  _redirects                  jaring pengaman /c/* -> /c
  _headers                    no-store untuk halaman kartu
  assets/css/style.css        gaya dasar + design token (semua halaman)
  assets/css/upgrade.css      lapisan desain khusus landing & harga
  assets/img/favicon.svg      ikon tab
  assets/img/logo.png         (opsional) logo — otomatis dipakai kalau ada
  assets/js/
    config.js                 <- SEMUA KONFIGURASI & API KEY ada di sini
    db.js                     <- data layer (demo localStorage | Supabase)
    places.js                 pencarian bisnis (Google Places API New)
    picker.js                 komponen "cari nama bisnis"
    ui.js                     helper (toast, view, copy, pesan error ramah)
    card.js kelola.js admin.js landing.js
supabase/
  migrations/                 skema + RLS + RPC (sumber kebenaran backend)
    0001_ulasin.sql              tabel + RLS + RPC dasar
    0002_fix_pin_lockout.sql     lockout PIN yang benar
    0003_fix_grants.sql          cabut grant berlebih
    0004_fix_grants_public.sql   cabut EXECUTE default dari PUBLIC
    0005_scan_rate_limit.sql     (dibatalkan oleh 0006)
    0006_simple_scan_count.sql   hitung tap apa adanya
    0007_verify_place_id.sql     verifikasi Place ID ke Google + private_config
```

## 1. Coba sekarang (mode demo, tanpa server)

Ubah `DEMO_MODE: true` di `public/assets/js/config.js`, lalu:

```bash
python -m http.server 3000 --directory public     # atau: npx serve public
```

| Halaman | URL | Data demo |
|---|---|---|
| Aktivasi | `/c.html?c=DEMO01` | PIN `123456` |
| Redirect | `/c.html?c=DEMO02` | kartu aktif (Kopi Senja) |
| Kelola | `/kelola.html` | `DEMO02` / `654321` |
| Admin | `/admin.html` | sandi `admin` |

Di produksi alamat kartu adalah `/c/KODE` (ditangani `_worker.js`). Di server statis biasa pakai `?c=KODE`.

Reset data demo: hapus localStorage key `ulasin_demo_v1`.

## 2. Arsitektur backend (Supabase)

Semua tulis & cek PIN lewat **RPC Postgres `security definer`**. Client tidak pernah menulis langsung ke tabel.

| RPC | Akses | Kegunaan |
|---|---|---|
| `public_card(code)` | anon | baca 1 kartu |
| `verify_owner(code,pin)` | anon | cek PIN pemilik |
| `activate_card(...)` | anon | aktivasi kartu (verifikasi Place ID dulu) |
| `update_target(...)` | anon | ganti bisnis tujuan (verifikasi Place ID dulu) |
| `track_scan(code)` | anon | hitung tap (hanya kartu aktif) |
| `generate_batch(count,label)` | admin | buat batch kartu + PIN |
| `set_card_blocked(code,bool)` | admin | blokir / buka blokir |

- PIN disimpan sebagai **bcrypt** (`pgcrypto`) di `card_secrets` — tabel tanpa RLS policy = tertutup total untuk client.
- Lockout 15 menit setelah 5 kali PIN salah.
- URL ulasan dibuat **di server** dari Place ID.
- **Place ID diverifikasi ke Google Places (Details)** lewat `places_lookup()`. Nama & alamat yang disimpan diambil dari Google, bukan dari client.
- RPC yang mengembalikan `{ ok:false, reason }` (bukan raise) supaya update penghitung gagal-PIN tidak ikut ter-rollback.
- API key untuk `places_lookup()` disimpan di tabel `private_config` (RLS aktif, tanpa policy).

## 3. Setup Supabase (sekali saja)

1. Buat project di [supabase.com](https://supabase.com).
2. Terapkan migrasi — lewat SQL Editor (jalankan isi `supabase/migrations/*.sql` berurutan) **atau** Supabase CLI:
   ```bash
   supabase link --project-ref <PROJECT_REF>
   supabase db push
   ```
3. Isi `public/assets/js/config.js`:
   - `SUPABASE.url` dan `SUPABASE.anonKey` (Project Settings > API)
   - `PLACES_API_KEY` (Google Cloud Console > aktifkan **Places API (New)** > API key.
     **Wajib dibatasi**: HTTP referrer = domain Anda, API restriction = Places API (New).)
   - `SUPPORT_WA`
   - ubah `DEMO_MODE` menjadi `false`
4. **Jadikan akun admin**: Authentication > Users > Add user (email + password),
   lalu jalankan di SQL Editor:
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'email-anda@contoh.com';
   ```
5. Buka `/admin`, buat batch, **unduh CSV (kode, URL, PIN)** — PIN hanya tampil sekali.
   Kalau CSV-nya hilang, pakai bagian **Reset PIN** di halaman admin (per batch atau per kartu):
   PIN baru dibuat dan ditampilkan sekali lagi, PIN lama langsung tidak berlaku.
   > Buka CSV-nya pakai Notepad / import-as-text, karena PIN bisa mulai dengan angka 0.
6. **Key untuk verifikasi server**: `places_lookup()` memanggil Google dari dalam Postgres,
   jadi butuh key yang **tidak** dibatasi HTTP referrer. Isi lewat SQL Editor:
   ```sql
   update public.private_config set value = 'KEY_SERVER_ANDA' where key = 'places_api_key';
   ```
   Key di `config.js` (browser) tetap dibatasi HTTP referrer; key server cukup dibatasi
   API restriction = Places API (New).

## 4. Deploy (Cloudflare Pages)

1. Push repo ini ke GitHub.
2. Cloudflare Dashboard > Workers & Pages > Create > Pages > Connect to Git.
3. Build command: **(kosong)** · Build output directory: **`public`**
4. Tambahkan **Environment variables** (Settings > Environment variables):
   - `SUPABASE_URL` = `https://<ref>.supabase.co`
   - `SUPABASE_ANON_KEY` = publishable key
5. Deploy. `public/_worker.js` otomatis aktif (advanced mode) — kartu aktif dibalas
   `302` langsung, tanpa memuat JS di HP pelanggan.
6. Setelah domain jadi (`*.pages.dev` atau domain sendiri), perbarui
   **HTTP referrer** pada Places API key agar hanya domain itu yang boleh.

> Uji worker lokal: `npx wrangler pages dev public` (butuh `.dev.vars`, lihat `.dev.vars.example`).

## 5. Alur & keputusan desain

- Kode kartu acak 6 karakter (tanpa 0/O/1/I), bukan berurutan. URL kartu: `https://domain-anda.com/c/X7KP2Q`.
- **Chip NFC dan QR code berisi URL yang sama persis.**
- PIN 6 angka dicetak di belakang kartu: dipakai untuk aktivasi dan ganti bisnis.
- Kartu **aktif** ditangani `public/_worker.js`: satu request ke Supabase lalu `302` ke
  `https://search.google.com/local/writereview?placeid=...`. Tidak ada JS di HP pelanggan.
- Kartu **belum aktif** disajikan halaman `/c` (aktivasi) tanpa mengubah URL, jadi `c.html`
  tetap bisa membaca kodenya dari path.
- Hitungan tap dikerjakan worker di latar belakang, sengaja **tanpa dedupe / batas harian**
  (permintaan pemilik: angka apa adanya).

## 6. Status TODO

Sudah dikerjakan:

1. Redirect milidetik → `public/_worker.js` (302 langsung).
2. Verifikasi Place ID → `places_lookup()` + `private_config`.
3. Landing page & halaman harga → `index.html`, `harga.html`.
4. Rate limit `track_scan` → sengaja **tidak** dipakai (permintaan pemilik).

Sisa yang masih terbuka:

1. **Sesi pemilik**: PIN masih disimpan di `sessionStorage` agar scaffold sederhana.
   Ganti dengan token sesi singkat kalau perlu.
2. **Verifikasi ulang berkala** Place ID (Place ID bisa berubah).
3. Halaman panduan "cara pakai kartu" dan halaman pesan/checkout.

## 7. Catatan NFC & kebijakan Google

- Chip NTAG213/215. Isi URL yang sama persis dengan QR code di kartu.
- Beri password/write-lock pada chip (NFC Tools > Other > Set password) dan simpan password per batch dengan aman. Jika hilang, chip tidak bisa ditulis ulang.
- **Jangan** menyaring ulasan (review gating: hanya mengarahkan pelanggan puas ke Google) dan jangan memberi imbalan untuk ulasan. Itu melanggar kebijakan Google dan ulasan bisa dihapus. Semua pelanggan harus diarahkan langsung ke formulir ulasan.