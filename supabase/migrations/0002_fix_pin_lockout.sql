-- ============================================================
-- Ulasin 0002 — perbaiki lockout PIN
--   Masalah: `raise exception` di transaksi yang sama membuat
--   update fail_count ikut ter-rollback -> lockout tidak pernah aktif.
--   Solusi: mengembalikan {ok:false, reason:...} TANPA raise untuk
--   error yang diharapkan, sehingga update tetap ter-commit.
-- ============================================================

-- check_owner: return type berubah cards -> jsonb, jadi harus di-drop dulu
drop function if exists public.check_owner(text, text);

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

create or replace function public.verify_owner(p_code text, p_pin text)
returns jsonb
language sql volatile security definer
set search_path = public
as $fn$
  select public.check_owner(p_code, p_pin);
$fn$;

create or replace function public.activate_card(
  p_code text, p_pin text, p_place_id text, p_name text, p_address text default ''
)
returns jsonb
language plpgsql volatile security definer
set search_path = public, extensions
as $fn$
declare
  v       jsonb;
  c       public.cards;
  v_place text := trim(coalesce(p_place_id, ''));
  v_name  text := trim(coalesce(p_name, ''));
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

  if v_place !~ '^[A-Za-z0-9_-]{6,200}$' or v_name = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  v_url := 'https://search.google.com/local/writereview?placeid=' || v_place;

  update public.cards
     set place_id      = v_place,
         business_name = left(v_name, 200),
         address       = v_addr,
         review_url    = v_url,
         status        = 'active',
         activated_at  = now()
   where code = upper(trim(coalesce(p_code, '')))
   returning * into c;

  return jsonb_build_object('ok', true, 'card', public.owner_json(c));
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
  v       jsonb;
  c       public.cards;
  v_place text := trim(coalesce(p_place_id, ''));
  v_name  text := trim(coalesce(p_name, ''));
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

  if v_place !~ '^[A-Za-z0-9_-]{6,200}$' or v_name = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  v_url := 'https://search.google.com/local/writereview?placeid=' || v_place;

  update public.cards
     set place_id      = v_place,
         business_name = left(v_name, 200),
         address       = v_addr,
         review_url    = v_url
   where code = upper(trim(coalesce(p_code, '')))
   returning * into c;

  return jsonb_build_object('ok', true, 'card', public.owner_json(c));
end
$fn$;

-- pastikan hak akses tetap benar
grant execute on function public.verify_owner(text, text)                    to anon, authenticated;
grant execute on function public.activate_card(text, text, text, text, text) to anon, authenticated;
grant execute on function public.update_target(text, text, text, text, text) to anon, authenticated;
