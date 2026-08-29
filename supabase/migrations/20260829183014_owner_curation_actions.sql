create function public.owner_curation_action(
  p_case_id bigint,
  p_action text,
  p_mutation jsonb,
  p_reason text
) returns public.curation_cases
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_case public.curation_cases;
  mutation jsonb := coalesce(p_mutation, '{}'::jsonb);
  requested_event_id bigint;
begin
  if (select auth.uid()) is null or not exists (
    select 1 from public.curator_memberships membership
    where membership.user_id = (select auth.uid()) and membership.role = 'owner'
  ) then
    raise exception 'curation action requires verified owner membership';
  end if;
  if p_case_id is null or p_case_id <= 0 then raise exception 'case id must be positive'; end if;
  if p_action not in ('approve_corrected', 'reject', 'merge', 'separate', 'retry', 'revert') then
    raise exception 'unsupported owner curation action';
  end if;
  if p_reason is null or nullif(btrim(p_reason), '') is null or length(p_reason) > 2000 then
    raise exception 'curation action reason is required';
  end if;
  if jsonb_typeof(mutation) <> 'object' then raise exception 'curation action mutation must be an object'; end if;

  select * into locked_case from public.curation_cases where id = p_case_id for update;
  if not found then raise exception 'curation case does not exist'; end if;

  if p_action = 'revert' then
    requested_event_id := (mutation->>'eventId')::bigint;
    if requested_event_id is null then raise exception 'reversion event id is required'; end if;
    perform public.revert_editorial_event(requested_event_id, (select auth.uid()), p_reason);
  else
    if p_action = 'approve_corrected'
      and not curation_private.is_strict_canonical_mutation(
        mutation->'mutation', (mutation->'mutation'->>'action')
      ) then
      raise exception 'corrected mutation is invalid';
    end if;
    if p_action = 'merge'
      and not curation_private.is_strict_canonical_mutation(mutation->'mutation', 'merge_commanders') then
      raise exception 'merge mutation is invalid';
    end if;
    if p_action = 'separate'
      and not curation_private.is_strict_canonical_mutation(mutation->'mutation', 'separate_commanders') then
      raise exception 'separation mutation is invalid';
    end if;
    update public.curation_cases
    set status = case p_action
      when 'retry' then 'pending'
      when 'reject' then 'rejected'
      else 'approved'
    end,
    payload = case when p_action = 'approve_corrected'
      then locked_case.payload || jsonb_build_object('human_corrected_mutation', mutation->'mutation')
      else locked_case.payload end,
    lease_owner = null,
    lease_expires_at = null,
    last_error = case when p_action = 'retry' then null else locked_case.last_error end,
    updated_at = clock_timestamp()
    where id = p_case_id
    returning * into locked_case;

    insert into public.editorial_events (
      case_id, actor_type, actor_id, action, before_state, after_state, reason
    ) values (
      p_case_id, 'human', (select auth.uid())::text, p_action,
      to_jsonb(locked_case),
      jsonb_build_object('status', locked_case.status, 'mutation', mutation), p_reason
    );
  end if;
  select * into locked_case from public.curation_cases where id = p_case_id;
  return locked_case;
end;
$$;

revoke all on function public.owner_curation_action(bigint, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.owner_curation_action(bigint, text, jsonb, text) to authenticated;
