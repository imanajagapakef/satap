-- ============================================================
-- Ulasin 0005 — rate limit track_scan
--   PostgREST tidak meneruskan IP client ke fungsi, jadi pembatasnya:
--     1) dedupe  : tap berulang < 10 detik dihitung sekali
--     2) harian  : maksimal 1000 tap per kartu per hari
-- ============================================================

alter table public.cards add column if not exists scan_day       date;
alter table public.cards add column if not exists scan_day_count integer not null default 0;

create or replace function public.track_scan(p_code text)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $fn$
declare
  v_code  text := upper(trim(coalesce(p_code, '')));
  v_card  public.cards;
  v_today integer;
begin
  if v_code !~ '^[A-Z0-9]{4,12}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid-argument');
  end if;

  select * into v_card from public.cards where code = v_code;
  if v_card.code is null or v_card.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', 'not-active');
  end if;

  -- 1) dedupe: tap berulang dalam 10 detik tidak dihitung
  if v_card.last_scan_at is not null and v_card.last_scan_at > now() - interval '10 seconds' then
    return jsonb_build_object('ok', true, 'counted', false, 'reason', 'duplicate');
  end if;

  -- 2) batas harian
  v_today := case when v_card.scan_day = current_date then coalesce(v_card.scan_day_count, 0) else 0 end;
  if v_today >= 1000 then
    return jsonb_build_object('ok', true, 'counted', false, 'reason', 'rate-limited');
  end if;

  update public.cards
     set scan_count     = scan_count + 1,
         last_scan_at   = now(),
         scan_day       = current_date,
         scan_day_count = v_today + 1
   where code = v_code;

  return jsonb_build_object('ok', true, 'counted', true);
end
$fn$;

grant execute on function public.track_scan(text) to anon, authenticated;
