-- ============================================================
-- Ulasin 0003 — perbaiki hak akses (grants)
--   Supabase memberi EXECUTE default ke anon/authenticated untuk
--   setiap fungsi baru, jadi `revoke ... from public` saja tidak cukup.
-- ============================================================

-- fungsi internal: harus benar-benar tertutup
revoke all on function public.check_owner(text, text)   from anon, authenticated;
revoke all on function public.random_code(integer)      from anon, authenticated;
revoke all on function public.random_pin(integer)       from anon, authenticated;
revoke all on function public.owner_json(public.cards)  from anon, authenticated;

-- fungsi khusus admin: jangan bisa dipanggil tanpa login
revoke all on function public.generate_batch(integer, text)      from anon;
revoke all on function public.set_card_blocked(text, boolean)    from anon;

-- is_admin dipakai policy RLS -> butuh EXECUTE untuk authenticated, cabut dari anon
revoke all on function public.is_admin() from anon;

-- grant yang benar (tegaskan ulang)
grant execute on function public.public_card(text)                             to anon, authenticated;
grant execute on function public.track_scan(text)                              to anon, authenticated;
grant execute on function public.verify_owner(text, text)                      to anon, authenticated;
grant execute on function public.activate_card(text, text, text, text, text)   to anon, authenticated;
grant execute on function public.update_target(text, text, text, text, text)   to anon, authenticated;

grant execute on function public.generate_batch(integer, text)                 to authenticated;
grant execute on function public.set_card_blocked(text, boolean)               to authenticated;

grant execute on function public.is_admin()                                    to authenticated;
