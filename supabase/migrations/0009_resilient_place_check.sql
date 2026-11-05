-- ============================================================
-- Ulasin 0009 — verifikasi Place ID yang tahan banting
--
--   Masalah: places_lookup() memakai key yang sama dengan browser.
--   Begitu key browser dibatasi HTTP referrer, panggilan dari server
--   ikut ditolak (403) dan SEMUA aktivasi gagal.
--
--   Solusi: bedakan jenis kegagalan.
--     - 404 / format salah   -> tolak (placeId memang tidak ada)
--     - 401/403 / jaringan   -> JANGAN blokir; pakai data dari client
--                               (placeId tetap divalidasi formatnya)
--
--   Jadi verifikasi tetap jalan selama key server tersedia, tapi
--   aktivasi tidak pernah mati hanya karena konfigurasi key.
-- ============================================================

create or replace function public.places_lookup_ex(p_place_id text)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $fn$
declare
  v_key  text;
  v_res  extensions.http_response;
  v_body jsonb;
  v_text text;
begin
  if p_place_id is null or p_place_id !~ '^[A-Za-z0-9_-]{6,200}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  select value into v_key from public.private_config where key = 'places_api_key';
  if v_key is null or v_key = '' then
    return jsonb_build_object('ok', false, 'error', 'config');
  end if;

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
    return jsonb_build_object('ok', false, 'error', 'unavailable');
  end;

  v_text := coalesce(v_res.content, '');

  if v_res.status is distinct from 200 then
    -- Google memakai status 400 untuk DUA hal berbeda, jadi dibedakan dari pesannya:
    --   "API key not valid"                  -> konfigurasi key bermasalah
    --   "provided Place ID ... is not valid" -> tempatnya memang tidak ada
    if v_text ilike '%API key%' then
      return jsonb_build_object('ok', false, 'error', 'auth');
    elsif v_text ilike '%Place ID%' then
      return jsonb_build_object('ok', false, 'error', 'not-found');
    elsif v_res.status in (401, 403) then
      return jsonb_build_object('ok', false, 'error', 'auth');
    elsif v_res.status in (400, 404) then
      return jsonb_build_object('ok', false, 'error', 'not-found');
    else
      return jsonb_build_object('ok', false, 'error', 'unavailable');
    end if;
  end if;

  begin
    v_body := v_text::jsonb;
  exception when others then
    return jsonb_build_object('ok', false, 'error', 'unavailable');
  end;

  if coalesce(v_body -> 'displayName' ->> 'text', '') = '' then
    return jsonb_build_object('ok', false, 'error', 'not-found');
  end if;

  return jsonb_build_object('ok', true, 'place', jsonb_build_object(
    'placeId', coalesce(v_body ->> 'id', p_place_id),
    'name',    (v_body -> 'displayName' ->> 'text'),
    'address', coalesce(v_body ->> 'formattedAddress', '')
  ));
end
$fn$;

revoke all on function public.places_lookup_ex(text) from public;
revoke all on function public.places_lookup_ex(text) from anon, authenticated;

-- ---------- aktivasi ----------
create or replace function public.activate_card(
  p_code text, p_pin text, p_place_id text, p_name text default '', p_address text default ''
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $fn$
declare
  v      jsonb;
  look   jsonb;
  c      public.cards;
  v_place text := trim(coalesce(p_place_id, ''));
  v_name  text := left(trim(coalesce(p_name, '')), 200);
  v_addr  text := left(trim(coalesce(p_address, '')), 300);
  v_url   text;
begin
  v := public.check_owner(p_code, p_pin);
  if not (v ->> 'ok')::boolean then
    return jsonb_build_object('ok', false, 'reason', v ->> 'reason');
  end if;
  if (v -> 'card' ->> 'status') = 'active' then
    return jsonb_build_object('ok', false, 'reason', 'already-active');
  end if;

  look := public.places_lookup_ex(v_place);

  if (look ->> 'ok')::boolean then
    v_place := look -> 'place' ->> 'placeId';
    v_name  := left(look -> 'place' ->> 'name', 200);
    v_addr  := left(coalesce(look -> 'place' ->> 'address', ''), 300);
  elsif (look ->> 'error') in ('not-found', 'invalid') then
    return jsonb_build_object('ok', false, 'reason', 'invalid-place');
  else
    -- key dibatasi / Google tidak bisa dihubungi: jangan blokir aktivasi
    if v_place !~ '^[A-Za-z0-9_-]{6,200}$' or v_name = '' then
      return jsonb_build_object('ok', false, 'reason', 'invalid');
    end if;
  end if;

  v_url := 'https://search.google.com/local/writereview?placeid=' || v_place;

  update public.cards
     set place_id      = v_place,
         business_name = v_name,
         address       = v_addr,
         review_url    = v_url,
         status        = 'active',
         activated_at  = now()
   where code = upper(trim(coalesce(p_code, '')))
   returning * into c;

  return jsonb_build_object('ok', true, 'card', public.owner_json(c));
end
$fn$;

-- ---------- ganti tujuan ----------
create or replace function public.update_target(
  p_code text, p_pin text, p_place_id text, p_name text default '', p_address text default ''
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $fn$
declare
  v      jsonb;
  look   jsonb;
  c      public.cards;
  v_place text := trim(coalesce(p_place_id, ''));
  v_name  text := left(trim(coalesce(p_name, '')), 200);
  v_addr  text := left(trim(coalesce(p_address, '')), 300);
  v_url   text;
begin
  v := public.check_owner(p_code, p_pin);
  if not (v ->> 'ok')::boolean then
    return jsonb_build_object('ok', false, 'reason', v ->> 'reason');
  end if;
  if (v -> 'card' ->> 'status') <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  look := public.places_lookup_ex(v_place);

  if (look ->> 'ok')::boolean then
    v_place := look -> 'place' ->> 'placeId';
    v_name  := left(look -> 'place' ->> 'name', 200);
    v_addr  := left(coalesce(look -> 'place' ->> 'address', ''), 300);
  elsif (look ->> 'error') in ('not-found', 'invalid') then
    return jsonb_build_object('ok', false, 'reason', 'invalid-place');
  else
    if v_place !~ '^[A-Za-z0-9_-]{6,200}$' or v_name = '' then
      return jsonb_build_object('ok', false, 'reason', 'invalid');
    end if;
  end if;

  v_url := 'https://search.google.com/local/writereview?placeid=' || v_place;

  update public.cards
     set place_id      = v_place,
         business_name = v_name,
         address       = v_addr,
         review_url    = v_url
   where code = upper(trim(coalesce(p_code, '')))
   returning * into c;

  return jsonb_build_object('ok', true, 'card', public.owner_json(c));
end
$fn$;

grant execute on function public.activate_card(text, text, text, text, text) to anon, authenticated;
grant execute on function public.update_target(text, text, text, text, text) to anon, authenticated;