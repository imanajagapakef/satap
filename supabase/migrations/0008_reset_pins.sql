-- ============================================================
-- Ulasin 0008 — reset PIN kartu (admin)
--   PIN hanya disimpan sebagai hash, jadi kalau hilang harus direset.
--   Satu RPC untuk dua kebutuhan:
--     - reset beberapa kartu  : kirim p_codes = [ 'ABC123', ... ]
--     - reset satu batch      : kirim p_batch = 'Nama Batch'
--   Mengembalikan { ok:true, cards:[{code,pin}, ...] } — tampil sekali.
-- ============================================================

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
    v_targets := p_codes;
  elsif p_batch is not null and btrim(p_batch) <> '' then
    select array_agg(c.code) into v_targets
      from public.cards c
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