-- ============================================================
-- Ulasin 0004 — cabut EXECUTE default dari PUBLIC
--   PostgreSQL memberi EXECUTE ke PUBLIC secara default, jadi
--   revoke dari anon/authenticated saja TIDAK cukup.
--   Setelah ini:
--     publik (anon+auth) : public_card, track_scan, verify_owner,
--                          activate_card, update_target
--     admin (auth saja)  : generate_batch, set_card_blocked, is_admin
--     internal (nobody)  : check_owner, owner_json, random_code, random_pin
-- ============================================================

revoke all on function public.owner_json(public.cards)        from public, anon, authenticated;
revoke all on function public.generate_batch(integer, text)   from public;
revoke all on function public.set_card_blocked(text, boolean) from public;
revoke all on function public.is_admin()                      from public;

grant execute on function public.generate_batch(integer, text)   to authenticated;
grant execute on function public.set_card_blocked(text, boolean) to authenticated;
grant execute on function public.is_admin()                      to authenticated;
