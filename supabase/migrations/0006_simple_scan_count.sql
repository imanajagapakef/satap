-- ============================================================
-- Ulasin 0006 — batalkan rate limit track_scan (0005)
--   Permintaan pemilik: hitungan tap apa adanya, tanpa dedupe /
--   batas harian. Tap hanya dihitung untuk kartu berstatus aktif.
-- ============================================================

alter table public.cards drop column if exists scan_day;
alter table public.cards drop column if exists scan_day_count;

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

grant execute on function public.track_scan(text) to anon, authenticated;
