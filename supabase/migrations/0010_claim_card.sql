-- ============================================================
-- Ulasin 0010 — PIN dibuat pemilik saat aktivasi (klaim kartu)
--
--   Sebelumnya: admin generate_batch membuat PIN acak, dicetak di
--   belakang kartu, lalu pemilik memasukkannya untuk aktivasi.
--
--   Sekarang: kartu lahir TANPA PIN. Aktivasi pertama = KLAIM:
--   pemilik membuat PIN-nya sendiri sekaligus memilih toko.
--   Admin tetap bisa reset PIN lewat reset_card_pins (pemulihan),
--   tapi hanya untuk kartu yang sudah diklaim.
--
--   Penanda "sudah diklaim" = card_secrets.pin_set.
-- ============================================================

-- ---------- penanda klaim ----------
alter table public.card_secrets
  add column if not exists pin_set boolean not null default false;

-- Kartu yang belum pernah diaktifkan -> bisa diklaim ulang (buang PIN lama).
update public.card_secrets s
   set pin_hash = '', pin_set = false, fail_count = 0, locked_until = null
  from public.cards c
 where c.code = s.code
   and c.status = 'inactive';

-- Kartu aktif/diblokir yang sudah punya PIN -> tetap diklaim (pemilik lama tetap bisa masuk).
update public.card_secrets s
   set pin_set = true
  from public.cards c
 where c.code = s.code
   and c.status <> 'inactive'
   and s.pin_hash <> '';

-- ---------- check_owner: tolak kartu yang belum diklaim ----------
create or replace function public.check_owner(p_code text, p_pin text)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $fn$
declare
  v_code  text := upper(trim(coalesce(p_code, '')));
  v_card  public.cards;
  v_sec   public.card_secrets;
  v_ok    boolean;
  v_fails integer;
begin
  if v_code !~ '^[A-Z0-9]{4,12}$' then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  select * into v_card from public.cards        where code = v_code;
  select * into v_sec  from public.card_secrets where code = v_code;
  if v_card.code is null or v_sec.code is null then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  if v_card.status = 'blocked' then
    return jsonb_build_object('ok', false, 'reason', 'blocked');
  end if;

  if not v_sec.pin_set then
    return jsonb_build_object('ok', false, 'reason', 'unclaimed');
  end if;

  if v_sec.locked_until is not null and v_sec.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked');
  end if;

  v_ok := (v_sec.pin_hash = extensions.crypt(coalesce(p_pin, ''), v_sec.pin_hash));

  if not v_ok then
    v_fails := coalesce(v_sec.fail_count, 0) + 1;
    if v_fails >= 5 then
      update public.card_secrets
         set fail_count = 0, locked_until = now() + interval '15 minutes'
       where code = v_code;
    else
      update public.card_secrets set fail_count = v_fails where code = v_code;
    end if;
    -- TIDAK raise: agar update fail_count di atas ikut ter-commit
    return jsonb_build_object('ok', false, 'reason', 'wrong-pin');
  end if;

  if coalesce(v_sec.fail_count, 0) <> 0 then
    update public.card_secrets set fail_count = 0 where code = v_code;
  end if;

  return jsonb_build_object('ok', true, 'card', public.owner_json(v_card));
end
$fn$;

revoke all on function public.check_owner(text, text) from public;

-- ---------- claim_card: aktivasi + set PIN milik pemilik ----------
create or replace function public.claim_card(
  p_code text, p_pin text, p_place_id text, p_name text default '', p_address text default ''
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $fn$
declare
  v_code  text := upper(trim(coalesce(p_code, '')));
  v_pin   text := trim(coalesce(p_pin, ''));
  v_place text := trim(coalesce(p_place_id, ''));
  v_name  text := left(trim(coalesce(p_name, '')), 200);
  v_addr  text := left(trim(coalesce(p_address, '')), 300);
  v_card  public.cards;
  v_sec   public.card_secrets;
  look    jsonb;
  v_url   text;
begin
  if v_code !~ '^[A-Z0-9]{4,12}$' then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;
  if v_pin !~ '^[0-9]{4,12}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid-pin');
  end if;

  select * into v_card from public.cards        where code = v_code;
  select * into v_sec  from public.card_secrets where code = v_code;
  if v_card.code is null or v_sec.code is null then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;
  if v_card.status = 'blocked' then
    return jsonb_build_object('ok', false, 'reason', 'blocked');
  end if;
  if v_sec.pin_set then
    return jsonb_build_object('ok', false, 'reason', 'already-claimed');
  end if;

  -- verifikasi Place ID (tahan banting seperti 0009)
  look := public.places_lookup_ex(v_place);
  if (look ->> 'ok')::boolean then
    v_place := look -> 'place' ->> 'placeId';
    v_name  := left(look -> 'place' ->> 'name', 200);
    v_addr  := left(coalesce(look -> 'place' ->> 'address', ''), 300);
  elsif (look ->> 'error') in ('not-found', 'invalid') then
    return jsonb_build_object('ok', false, 'reason', 'invalid-place');
  else
    -- key dibatasi / Google tidak bisa dihubungi: pakai data dari client
    if v_place !~ '^[A-Za-z0-9_-]{6,200}$' or v_name = '' then
      return jsonb_build_object('ok', false, 'reason', 'invalid');
    end if;
  end if;

  v_url := 'https://search.google.com/local/writereview?placeid=' || v_place;

  update public.card_secrets
     set pin_hash     = extensions.crypt(v_pin, extensions.gen_salt('bf', 10)),
         pin_set      = true,
         fail_count   = 0,
         locked_until = null
   where code = v_code;

  update public.cards
     set place_id      = v_place,
         business_name = v_name,
         address       = v_addr,
         review_url    = v_url,
         status        = 'active',
         activated_at  = now()
   where code = v_code
   returning * into v_card;

  return jsonb_build_object('ok', true, 'card', public.owner_json(v_card));
end
$fn$;

revoke all on function public.claim_card(text, text, text, text, text) from public;
grant execute on function public.claim_card(text, text, text, text, text) to anon, authenticated;

-- ---------- generate_batch: tanpa PIN (kartu diklaim pemilik) ----------
create or replace function public.generate_batch(p_count integer, p_label text default '')
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $fn$
declare
  v_count integer := floor(coalesce(p_count, 0));
  v_label text    := left(coalesce(p_label, ''), 80);
  v_out   jsonb   := '[]'::jsonb;
  v_code  text;
  i       integer;
begin
  if not public.is_admin() then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  if v_count < 1 or v_count > 500 then
    raise exception using errcode = 'P0001', message = 'invalid-argument';
  end if;

  for i in 1..v_count loop
    loop
      v_code := public.random_code(6);
      exit when not exists (select 1 from public.cards where code = v_code);
    end loop;

    insert into public.cards (code, status, created_at, batch)
      values (v_code, 'inactive', now(), v_label);

    insert into public.card_secrets (code, pin_hash, pin_set, fail_count, locked_until)
      values (v_code, '', false, 0, null);

    v_out := v_out || jsonb_build_object('code', v_code);
  end loop;

  return v_out;
end
$fn$;

-- ---------- reset PIN: hanya kartu yang sudah diklaim ----------
create or replace function public.reset_card_pins(
  p_codes text[] default null,
  p_batch text default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $fn$
declare
  v_targets text[];
  v_out     jsonb := '[]'::jsonb;
  v_pin     text;
  r         record;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  if p_codes is not null and coalesce(array_length(p_codes, 1), 0) >= 1 then
    select array_agg(c.code) into v_targets
      from public.cards c
      join public.card_secrets s on s.code = c.code and s.pin_set
     where c.code = any (p_codes);
  elsif p_batch is not null and btrim(p_batch) <> '' then
    select array_agg(c.code) into v_targets
      from public.cards c
      join public.card_secrets s on s.code = c.code and s.pin_set
     where c.batch = btrim(p_batch);
  end if;

  if v_targets is null or coalesce(array_length(v_targets, 1), 0) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  if array_length(v_targets, 1) > 1000 then
    return jsonb_build_object('ok', false, 'reason', 'too-many');
  end if;

  for r in
    select c.code from public.cards c where c.code = any(v_targets) order by c.code
  loop
    v_pin := public.random_pin(6);

    update public.card_secrets
       set pin_hash     = extensions.crypt(v_pin, extensions.gen_salt('bf', 10)),
           pin_set      = true,
           fail_count   = 0,
           locked_until = null
     where code = r.code;

    if found then
      v_out := v_out || jsonb_build_object('code', r.code, 'pin', v_pin);
    end if;
  end loop;

  if jsonb_array_length(v_out) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'not-found');
  end if;

  return jsonb_build_object('ok', true, 'cards', v_out);
end
$fn$;

revoke all on function public.reset_card_pins(text[], text) from public;
revoke all on function public.reset_card_pins(text[], text) from anon;
grant execute on function public.reset_card_pins(text[], text) to authenticated;

-- ---------- activate_card tidak dipakai lagi (diganti claim_card) ----------
revoke all on function public.activate_card(text, text, text, text, text) from public, anon, authenticated;
