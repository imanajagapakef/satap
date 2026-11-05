-- ============================================================
-- Ulasin 0007 — verifikasi Place ID ke Google Places (Details)
--
--   Sebelumnya client bisa mengirim placeId sembarang. Sekarang
--   activate_card / update_target memverifikasi placeId ke Google
--   lewat `http` extension (sync HTTP dari Postgres), lalu memakai
--   NAMA & ALAMAT kanonik dari Google — bukan dari client.
--
--   Butuh: extension http (sudah diinstal di 0007 ini) dan
--   Places API key yang bisa dipanggil dari server (tanpa
--   Application restriction / HTTP referrer).
-- ============================================================

create extension if not exists http with schema extensions;

-- ---------- konfigurasi rahasia (tidak bisa dibaca client) ----------
create table if not exists public.private_config (
  key   text primary key,
  value text not null
);

alter table public.private_config enable row level security;
-- SENGAJA tanpa policy -> hanya bisa dibaca security definer function.

revoke all on public.private_config from public;
revoke all on public.private_config from anon, authenticated;

-- GANTI nilai ini dengan key khusus server kalau nanti key browser
-- sudah dibatasi HTTP referrer (key referrer-restricted tidak bisa
-- dipanggil dari server).
insert into public.private_config (key, value)
values ('places_api_key', 'AIzaSyDF7u0DRiQgJ-0Ou3J2658M9dR64fQ3f4E')
on conflict (key) do nothing;

-- ---------- lookup ke Google Places (Details, API New) ----------
create or replace function public.places_lookup(p_place_id text)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $fn$
declare
  v_key  text;
  v_res  extensions.http_response;
  v_body jsonb;
begin
  if p_place_id is null or p_place_id !~ '^[A-Za-z0-9_-]{6,200}$' then
    return null;
  end if;

  select value into v_key from public.private_config where key = 'places_api_key';
  if v_key is null or v_key = '' then
    return null;
  end if;

  -- jangan menggantung kalau Google lambat
  begin
    perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '5');
  exception when others then
    null;
  end;

  begin
    v_res := extensions.http((
      'GET',
      'https://places.googleapis.com/v1/places/' || p_place_id || '?languageCode=id&regionCode=ID',
      array[
        extensions.http_header('X-Goog-Api-Key', v_key),
        extensions.http_header('X-Goog-FieldMask', 'id,displayName,formattedAddress')
      ],
      null,
      null
    )::extensions.http_request);
  exception when others then
    return null;
  end;

  if v_res.status is distinct from 200 then
    return null;
  end if;

  begin
    v_body := v_res.content::jsonb;
  exception when others then
    return null;
  end;

  if coalesce(v_body -> 'displayName' ->> 'text', '') = '' then
    return null;
  end if;

  return jsonb_build_object(
    'placeId', coalesce(v_body ->> 'id', p_place_id),
    'name',    (v_body -> 'displayName' ->> 'text'),
    'address', coalesce(v_body ->> 'formattedAddress', '')
  );
end
$fn$;

revoke all on function public.places_lookup(text) from public;
revoke all on function public.places_lookup(text) from anon, authenticated;

-- ---------- aktivasi: verifikasi dulu, baru simpan ----------
create or replace function public.activate_card(
  p_code text, p_pin text, p_place_id text, p_name text default '', p_address text default ''
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $fn$
declare
  v     jsonb;
  c     public.cards;
  info  jsonb;
  v_url text;
begin
  v := public.check_owner(p_code, p_pin);
  if not (v ->> 'ok')::boolean then
    return jsonb_build_object('ok', false, 'reason', v ->> 'reason');
  end if;

  if (v -> 'card' ->> 'status') = 'active' then
    return jsonb_build_object('ok', false, 'reason', 'already-active');
  end if;

  -- p_name / p_address dari client sengaja DIABAIKAN.
  info := public.places_lookup(trim(coalesce(p_place_id, '')));
  if info is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid-place');
  end if;

  v_url := 'https://search.google.com/local/writereview?placeid=' || (info ->> 'placeId');

  update public.cards
     set place_id      = info ->> 'placeId',
         business_name = left(info ->> 'name', 200),
         address       = left(coalesce(info ->> 'address', ''), 300),
         review_url    = v_url,
         status        = 'active',
         activated_at  = now()
   where code = upper(trim(coalesce(p_code, '')))
   returning * into c;

  return jsonb_build_object('ok', true, 'card', public.owner_json(c));
end
$fn$;

-- ---------- ganti tujuan: verifikasi juga ----------
create or replace function public.update_target(
  p_code text, p_pin text, p_place_id text, p_name text default '', p_address text default ''
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $fn$
declare
  v     jsonb;
  c     public.cards;
  info  jsonb;
  v_url text;
begin
  v := public.check_owner(p_code, p_pin);
  if not (v ->> 'ok')::boolean then
    return jsonb_build_object('ok', false, 'reason', v ->> 'reason');
  end if;

  if (v -> 'card' ->> 'status') <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  info := public.places_lookup(trim(coalesce(p_place_id, '')));
  if info is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid-place');
  end if;

  v_url := 'https://search.google.com/local/writereview?placeid=' || (info ->> 'placeId');

  update public.cards
     set place_id      = info ->> 'placeId',
         business_name = left(info ->> 'name', 200),
         address       = left(coalesce(info ->> 'address', ''), 300),
         review_url    = v_url
   where code = upper(trim(coalesce(p_code, '')))
   returning * into c;

  return jsonb_build_object('ok', true, 'card', public.owner_json(c));
end
$fn$;

grant execute on function public.activate_card(text, text, text, text, text) to anon, authenticated;
grant execute on function public.update_target(text, text, text, text, text) to anon, authenticated;