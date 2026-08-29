revoke all on function public.enqueue_curation_case(text, text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.lease_curation_case(text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.heartbeat_curation_case(bigint, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.release_curation_case(bigint, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.record_ai_review(bigint, text, text, text, text, jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.read_curation_reviews(bigint, text)
  from public, anon, authenticated, service_role;

grant execute on function public.enqueue_curation_case(text, text, text, jsonb)
  to service_role;
grant execute on function public.lease_curation_case(text, integer)
  to service_role;
grant execute on function public.heartbeat_curation_case(bigint, text, integer)
  to service_role;
grant execute on function public.release_curation_case(bigint, text, text, text)
  to service_role;
grant execute on function public.record_ai_review(bigint, text, text, text, text, jsonb, jsonb)
  to service_role;
grant execute on function public.read_curation_reviews(bigint, text)
  to service_role;

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated, service_role';
  end if;
end
$$;
