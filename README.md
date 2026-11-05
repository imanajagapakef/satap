# Ulasin — kartu NFC/QR ulasan Google

Kartu NFC/QR yang sekali tap langsung membuka formulir ulasan Google toko. Ini kerangka UI/UX (tema hangat UMKM) dengan data layer terpisah supaya logika mudah dilanjutkan.

Tanpa build step: HTML + CSS + JavaScript (ES modules) biasa.

- **Database & backend**: Supabase (Postgres + RPC + Auth)
- **Hosting**: Cloudflare Pages
- **Pencarian bisnis**: Google Places API (New)
- **SDK Supabase** dimuat dari CDN hanya saat `DEMO_MODE = false`

## Struktur

```
public/                       <- Cloudflare Pages (root statis)
  index.html                  landing sederhana (placeholder)
  c.html                      /c/{kode}: redirect | aktivasi 3 langkah | error
  kelola.html                 dashboard pemilik (kode kartu + PIN)
  admin.html                  admin: buat batch, ekspor CSV, blokir
  404.html
  _redirects                  rewrite /c/* -> /c.html
  assets/css/style.css        semua gaya + design token (warna di :root)
  assets/js/
    config.js                 <- SEMUA KONFIGURASI & API KEY ada di sini
    db.js                     <- data layer (demo localStorage | Supabase)
    places.js                 pencarian bisnis (Google Places API New)
    picker.js                 komponen "cari nama bisnis"
    ui.js                     helper (toast, view, copy, pesan error ramah)
    card.js kelola.js admin.js landing.js
supabase/
  migrations/                 skema + RLS + RPC (sumber kebenaran backend)
    0001_ulasin.sql
    0002_fix_pin_lockout.sql
    0003_fix_grants.sql
    0004_fix_grants_public.sql
```

## 1. Coba sekarang (mode demo, tanpa server)

Ubah `DEMO_MODE: true` di `public/assets/js/config.js`, lalu:

```bash
npx serve public        # atau: python -m http.server -d public 3000
```

| Halaman | URL | Data demo |
|---|---|---|
| Aktivasi | `/c.html?c=DEMO01` | PIN `123456` |
| Redirect | `/c.html?c=DEMO02` | kartu aktif (Kopi Senja) |
| Kelola | `/kelola.html` | `DEMO02` / `654321` |
| Admin | `/admin.html` | sandi `admin` |

Di produksi alamat kartu adalah `/c/KODE` (dibuatkan oleh `_redirects`). Di server statis biasa pakai `?c=KODE`.

Reset data demo: hapus localStorage key `ulasin_demo_v1`.

## 2. Arsitektur backend (Supabase)

Semua tulis & cek PIN lewat **RPC Postgres `security definer`**. Client tidak pernah menulis langsung ke tabel.

| RPC | Akses | Kegunaan |
|---|---|---|
| `public_card(code)` | anon | baca 1 kartu (halaman redirect) |
| `verify_owner(code,pin)` | anon | cek PIN pemilik |
| `activate_card(...)` | anon | aktivasi kartu |
| `update_target(...)` | anon | ganti bisnis tujuan |
| `track_scan(code)` | anon | hitung tap (hanya kartu aktif) |
| `generate_batch(count,label)` | admin | buat batch kartu + PIN |
| `set_card_blocked(code,bool)` | admin | blokir / buka blokir |

- PIN disimpan sebagai **bcrypt** (`pgcrypto`) di `card_secrets` — tabel ini tanpa RLS policy = tertutup total untuk client.
- Lockout 15 menit setelah 5 kali PIN salah.
- URL ulasan dibuat **di server** dari Place ID.
- RPC yang mengembalikan `{ ok:false, reason }` (bukan raise) supaya update penghitung gagal-PIN tidak ikut ter-rollback.

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
     **Wajib dibatasi**: HTTP referrer = domain Anda, API restriction = Places API (New). Pasang budget alert.)
   - `SUPPORT_WA`
   - ubah `DEMO_MODE` menjadi `false`
4. **Jadikan akun admin**: Authentication > Users > Add user (email + password),
   lalu jalankan di SQL Editor:
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'email-anda@contoh.com';
   ```
5. Buka `/admin`, buat batch, **unduh CSV (kode, URL, PIN)** — PIN hanya tampil sekali.

## 4. Deploy (Cloudflare Pages)

1. Push repo ini ke GitHub.
2. Cloudflare Dashboard > Workers & Pages > Create > Pages > Connect to Git.
3. Build command: **(kosong)** · Build output directory: **`public`**
4. Setelah domain jadi (`*.pages.dev` atau domain sendiri), perbarui
   **HTTP referrer** pada Places API key di Google Cloud agar hanya domain itu yang boleh.

## 5. Alur & keputusan desain

- Kode kartu acak 6 karakter (tanpa 0/O/1/I), bukan berurutan. URL kartu: `https://domain-anda.com/c/X7KP2Q`.
- PIN 6 angka dicetak di belakang kartu: dipakai untuk aktivasi dan ganti bisnis.
- Redirect memakai `location.replace` ke `https://search.google.com/local/writereview?placeid=...` dan hanya mau pindah ke domain Google tersebut.
- Hitung tap tidak menahan redirect lebih dari 400 ms.

## 6. Daftar TODO logika (cari `TODO(logic)`)

```bash
grep -rn "TODO(logic)\|TODO(next)" public
```

Yang paling penting:

1. **Kecepatan redirect**: saat ini redirect berjalan di browser (muat JS, baca DB, lalu pindah). Untuk milidetik, pindahkan `/c/**` ke Cloudflare Worker yang mengirim `302` langsung, dan hanya menyajikan `c.html` untuk kartu belum aktif.
2. **Sesi pemilik**: PIN sementara disimpan di `sessionStorage` agar scaffold sederhana. Ganti dengan token sesi singkat.
3. **Verifikasi Place ID** ke Places API (Details) sebelum disimpan, dan verifikasi ulang berkala.
4. **Rate limit `track_scan`** (App Check / Cloudflare Turnstile) agar tidak bisa di-spam.
5. Landing page, halaman harga/pesan, panduan "cara pakai kartu".

## 7. Catatan NFC & kebijakan Google

- Chip NTAG213/215. Isi URL yang sama persis dengan QR code di kartu.
- Beri password/write-lock pada chip (NFC Tools > Other > Set password) dan simpan password per batch dengan aman. Jika hilang, chip tidak bisa ditulis ulang.
- **Jangan** menyaring ulasan (review gating: hanya mengarahkan pelanggan puas ke Google) dan jangan memberi imbalan untuk ulasan. Itu melanggar kebijakan Google dan ulasan bisa dihapus. Semua pelanggan harus diarahkan langsung ke formulir ulasan.
