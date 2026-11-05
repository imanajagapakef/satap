-- ============================================================
-- Ulasin 0001 — skema inti: kartu, rahasia PIN, admin
--   + Row Level Security + RPC (pengganti Cloud Functions lama)
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- enum status kartu ----------
do $do$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'card_status' and n.nspname = 'public'
  ) then
    create type public.card_status as enum ('inactive','active','blocked');
  end if;
end
$do$;

-- ---------- tabel ----------
create table if not exists public.cards (
  code          text primary key,
  status        public.card_status not null default 'inactive',
  business_name text not null default '',
  address       text not null default '',
  place_id      text not null default '',
  review_url    text not null default '',
  scan_count    integer not null default 0,
  last_scan_at  timestamptz,
  activated_at  timestamptz,
  created_at    timestamptz not null default now(),
  batch         text not null default ''
);

create table if not exists public.card_secrets (
  code         text primary key references public.cards(code) on delete cascade,
  pin_hash     text not null,
  fail_count   integer not null default 0,
  locked_until timestamptz
);

create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists cards_created_at_idx   on public.cards (created_at desc);
create index if not exists cards_batch_idx        on public.cards (batch);
create index if not exists card_secrets_locked_idx on public.card_secrets (locked_until);

-- ---------- RLS ----------
alter table public.cards        enable row level security;
alter table public.card_secrets enable row level security;
alter table public.admins       enable row level security;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $fn$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$fn$;

-- cards: hanya admin yang boleh list. Akses publik 1 kartu lewat RPC public_card().
drop policy if exists cards_admin_select on public.cards;
create policy cards_admin_select on public.cards
  for select to authenticated
  using (public.is_admin());

-- admins: admin boleh lihat daftarnya sendiri
drop policy if exists admins_admin_select on public.admins;
create policy admins_admin_select on public.admins
  for select to authenticated
  using (public.is_admin());

-- card_secrets: SENGAJA TIDAK ADA POLICY -> tertutup total untuk client.

-- ---------- util ----------
create or replace function public.random_code(n integer default 6)
returns text
language plpgsql volatile
set search_path = public, extensions
as $fn$
declare
  alphabet text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; -- tanpa 0/O/1/I
  res text := '';
  i integer;
begin
  for i in 1..greatest(n, 1) loop
    res := res || substr(alphabet, 1 + (get_byte(extensions.gen_random_bytes(1), 0) % 32), 1);
  end loop;
  return res;
end
$fn$;

create or replace function public.random_pin(n integer default 6)
returns text
language plpgsql volatile
set search_path = public, extensions
as $fn$
declare
  res text := '';
  i integer;
begin
  for i in 1..greatest(n, 1) loop
    res := res || (get_byte(extensions.gen_random_bytes(1), 0) % 10)::text;
  end loop;
  return res;
end
$fn$;

create or replace function public.owner_json(c public.cards)
returns jsonb
language sql immutable
set search_path = public
as $fn$
  select jsonb_build_object(
    'code',         c.code,
    'status',       c.status,
    'businessName', c.business_name,
    'address',      c.address,
    'placeId',      c.place_id,
    'reviewUrl',    c.review_url,
    'scanCount',    c.scan_count,
    'lastScanAt',   c.last_scan_at,
    'activatedAt',  c.activated_at
  );
$fn$;

-- ---------- internal: cek PIN + lockout ----------
-- Tidak boleh dipanggil langsung oleh client (lihat bagian grants).
create or replace function public.check_owner(p_code text, p_pin text)
returns public.cards
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
    raise exception using errcode = 'P0001', message = 'not-found';
  end if;

  select * into v_card from public.cards        where code = v_code;
  select * into v_sec  from public.card_secrets where code = v_code;
  if v_card.code is null or v_sec.code is null then
    raise exception using errcode = 'P0001', message = 'not-found';
  end if;

  if v_card.status = 'blocked' then
    raise exception using errcode = 'P0001', message = 'blocked';
  end if;

  if v_sec.locked_until is not null and v_sec.locked_until > now() then
    raise exception using errcode = 'P0001', message = 'locked';
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
    raise exception using errcode = 'P0001', message = 'wrong-pin';
  end if;

  if coalesce(v_sec.fail_count, 0) <> 0 then
    update public.card_secrets set fail_count = 0 where code = v_code;
  end if;

  return v_card;
end
$fn$;

-- ---------- publik / pemilik ----------
create or replace function public.public_card(p_code text)
returns jsonb
language sql stable security definer
set search_path = public
as $fn$
  select jsonb_build_object(
    'code',         c.code,
    'status',       c.status,
    'businessName', c.business_name,
    'address',      c.address,
    'placeId',      c.place_id,
    'reviewUrl',    c.review_url
  )
  from public.cards c
  where c.code = upper(trim(coalesce(p_code, '')));
$fn$;

create or replace function public.track_scan(p_code text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $fn$
declare
  v_code text := upper(trim(coalesce(p_code, '')));
begin
  if v_code !~ '^[A-Z0-9]{4,12}$' then
    return jsonb_build_object('ok', false);
  end if;
  update public.cards
     set scan_count = scan_count + 1, last_scan_at = now()
   where code = v_code and status = 'active';
  return jsonb_build_object('ok', true);
end
$fn$;

create or replace function public.verify_owner(p_code text, p_pin text)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $fn$
declare
  c public.cards;
begin
  c := public.check_owner(p_code, p_pin);
  return public.owner_json(c);
end
$fn$;

create or replace function public.activate_card(
  p_code text, p_pin text, p_place_id text, p_name text, p_address text default ''
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $fn$
declare
  c       public.cards;
  v_place text := trim(coalesce(p_place_id, ''));
  v_name  text := trim(coalesce(p_name, ''));
  v_addr  text := left(trim(coalesce(p_address, '')), 300);
  v_url   text;
begin
  c := public.check_owner(p_code, p_pin);
  if c.status = 'active' then
    raise exception using errcode = 'P0001', message = 'already-active';
  end if;
  if v_place !~ '^[A-Za-z0-9_-]{6,200}$' or v_name = '' then
    raise exception using errcode = 'P0001', message = 'invalid';
  end if;

  v_url := 'https://search.google.com/local/writereview?placeid=' || v_place;

  update public.cards
     set place_id      = v_place,
         business_name = left(v_name, 200),
         address       = v_addr,
         review_url    = v_url,
         status        = 'active',
         activated_at  = now()
   where code = c.code
   returning * into c;

  return public.owner_json(c);
end
$fn$;

create or replace function public.update_target(
  p_code text, p_pin text, p_place_id text, p_name text, p_address text default ''
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $fn$
declare
  c       public.cards;
  v_place text := trim(coalesce(p_place_id, ''));
  v_name  text := trim(coalesce(p_name, ''));
  v_addr  text := left(trim(coalesce(p_address, '')), 300);
  v_url   text;
begin
  c := public.check_owner(p_code, p_pin);
  if c.status <> 'active' then
    raise exception using errcode = 'P0001', message = 'invalid';
  end if;
  if v_place !~ '^[A-Za-z0-9_-]{6,200}$' or v_name = '' then
    raise exception using errcode = 'P0001', message = 'invalid';
  end if;

  v_url := 'https://search.google.com/local/writereview?placeid=' || v_place;

  update public.cards
     set place_id      = v_place,
         business_name = left(v_name, 200),
         address       = v_addr,
         review_url    = v_url
   where code = c.code
   returning * into c;

  return public.owner_json(c);
end
$fn$;

-- ---------- admin ----------
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
  v_pin   text;
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

    v_pin := public.random_pin(6);

    insert into public.cards (code, status, created_at, batch)
      values (v_code, 'inactive', now(), v_label);

    insert into public.card_secrets (code, pin_hash, fail_count, locked_until)
      values (v_code, extensions.crypt(v_pin, extensions.gen_salt('bf', 10)), 0, null);

    v_out := v_out || jsonb_build_object('code', v_code, 'pin', v_pin);
  end loop;

  return v_out;
end
$fn$;

create or replace function public.set_card_blocked(p_code text, p_blocked boolean)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $fn$
declare
  v_code   text := upper(trim(coalesce(p_code, '')));
  v_card   public.cards;
  v_status public.card_status;
begin
  if not public.is_admin() then
    raise exception using errcode = 'P0001', message = 'forbidden';
  end if;
  if v_code !~ '^[A-Z0-9]{4,12}$' then
    raise exception using errcode = 'P0001', message = 'not-found';
  end if;

  select * into v_card from public.cards where code = v_code;
  if v_card.code is null then
    raise exception using errcode = 'P0001', message = 'not-found';
  end if;

  if p_blocked then
    v_status := 'blocked';
  elsif v_card.place_id <> '' then
    v_status := 'active';
  else
    v_status := 'inactive';
  end if;

  update public.cards set status = v_status where code = v_code;
  return jsonb_build_object('ok', true, 'status', v_status);
end
$fn$;

-- ---------- grants / revokes ----------
-- helper internal: jangan sampai bisa dipanggil client
revoke all on function public.check_owner(text, text)  from public;
revoke all on function public.random_code(integer)      from public;
revoke all on function public.random_pin(integer)       from public;

-- fungsi publik (anon = pengunjung tanpa login)
grant execute on function public.public_card(text)                             to anon, authenticated;
grant execute on function public.verify_owner(text, text)                      to anon, authenticated;
grant execute on function public.activate_card(text, text, text, text, text)   to anon, authenticated;
grant execute on function public.update_target(text, text, text, text, text)   to anon, authenticated;
grant execute on function public.track_scan(text)                              to anon, authenticated;

-- fungsi admin (wajib login + terdaftar di tabel admins)
grant execute on function public.generate_batch(integer, text)                 to authenticated;
grant execute on function public.set_card_blocked(text, boolean)               to authenticated;

-- akses tabel
revoke all on public.cards        from anon;
revoke all on public.card_secrets from anon, authenticated;
revoke all on public.admins       from anon;

grant select on public.cards  to authenticated;
grant select on public.admins to authenticated;

revoke insert, update, delete on public.cards  from authenticated;
revoke insert, update, delete on public.admins from authenticated;
