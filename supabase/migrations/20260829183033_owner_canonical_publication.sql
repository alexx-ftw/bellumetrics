create function public.publish_owner_curation_decision(
  p_case_id bigint,
  p_requested_action text,
  p_mutation jsonb,
  p_reason text
) returns public.curation_publication_result
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_case public.curation_cases;
  action_name text;
  evidence jsonb;
  evidence_item jsonb;
  before_state jsonb;
  after_state jsonb;
  created_event_id bigint;
  created_job_id bigint;
  existing_event_id bigint;
  existing_job_id bigint;
  v_engagement_id bigint;
  v_claim_id bigint;
  v_source_id bigint;
  v_commander_id bigint;
  v_source_commander_id bigint;
  v_target_commander_id bigint;
  source_external_slug text;
  source_ref text;
  target_ref text;
  evidence_source_slugs text[] := '{}'::text[];
  commander_ref jsonb;
  payload_commander jsonb;
  commander_count integer;
  commander_index integer;
  side_label text;
  side_labels text[] := '{}'::text[];
  side_ids bigint[] := '{}'::bigint[];
  side_position integer;
  v_side_id bigint;
  first_outcome text;
  side_outcome text;
  participation_row record;
  v_existing_participation_id bigint;
  latest_link public.commander_identity_links;
  linked_event public.editorial_events;
begin
  if (select auth.uid()) is null or not exists (
    select 1 from public.curator_memberships membership
    where membership.user_id = (select auth.uid()) and membership.role = 'owner'
  ) then raise exception 'owner publication requires verified owner membership'; end if;
  if p_requested_action not in ('approve_corrected', 'merge', 'separate') then
    raise exception 'unsupported owner publication action';
  end if;
  if p_reason is null or nullif(btrim(p_reason), '') is null or length(p_reason) > 2000 then
    raise exception 'publication reason is required';
  end if;
  if jsonb_typeof(p_mutation) <> 'object' then raise exception 'canonical mutation must be an object'; end if;
  action_name := case p_requested_action when 'approve_corrected' then 'approve_battle' when 'merge' then 'merge_commanders' else 'separate_commanders' end;
  if not curation_private.is_strict_canonical_mutation(p_mutation, action_name) then
    raise exception 'owner canonical mutation is invalid';
  end if;

  select * into locked_case from public.curation_cases where id = p_case_id for update;
  if not found then raise exception 'curation case does not exist'; end if;
  if locked_case.status = 'published' then
    select e.id, j.id into existing_event_id, existing_job_id
    from public.editorial_events e join public.ranking_jobs j on j.editorial_event_id = e.id
    where e.case_id = locked_case.id and e.actor_type = 'human'
      and e.actor_id = (select auth.uid())::text and e.action = action_name
      and e.reverts_event_id is null
    order by e.id limit 1;
    if existing_event_id is null then raise exception 'published case is not this owner publication'; end if;
    return row(existing_event_id, existing_job_id)::public.curation_publication_result;
  end if;
  if locked_case.status not in ('awaiting_human', 'failed') then
    raise exception 'owner publication requires an exception case';
  end if;
  if (action_name = 'approve_battle' and locked_case.entity_type <> 'battle')
    or (action_name in ('merge_commanders', 'separate_commanders') and locked_case.entity_type <> 'commander') then
    raise exception 'owner publication action is incompatible with the case type';
  end if;

  select r.evidence into evidence from public.ai_reviews r
  where r.case_id = locked_case.id and curation_private.is_strict_evidence(r.evidence)
  order by r.created_at desc, r.id desc limit 1;
  if evidence is null then raise exception 'owner publication requires cited recorded evidence'; end if;

  if action_name = 'approve_battle' then
    for evidence_item in select value from jsonb_array_elements(evidence)
    loop
      source_external_slug := 'curation-' || md5(coalesce(nullif(evidence_item->>'url', ''), evidence_item->>'citation'));
      if not source_external_slug = any(evidence_source_slugs) then evidence_source_slugs := array_append(evidence_source_slugs, source_external_slug); end if;
    end loop;
    perform curation_private.lock_evidence_sources(evidence_source_slugs);
    perform curation_private.lock_engagement_graph(p_mutation->'battle'->>'slug', evidence_source_slugs);
    before_state := curation_private.capture_engagement_state(p_mutation->'battle'->>'slug', evidence_source_slugs);

    insert into public.engagements (slug, title, wikidata_qid, start_year, end_year, date_display, date_precision, elo_eligible, publication_status)
    values (
      p_mutation->'battle'->>'slug', p_mutation->'battle'->>'title',
      case when locked_case.payload->>'wikidata_qid' ~ '^Q[1-9][0-9]*$' then locked_case.payload->>'wikidata_qid' else null end,
      nullif(p_mutation->'battle'->>'startYear', '')::integer, nullif(p_mutation->'battle'->>'endYear', '')::integer,
      nullif(locked_case.payload->>'date_iso', ''),
      case when nullif(locked_case.payload->>'date_iso', '') is not null then 'exact' when p_mutation->'battle'->>'startYear' is not null then 'year' else 'unknown' end,
      false, 'published'
    ) on conflict (slug) do update set
      title = excluded.title, wikidata_qid = coalesce(excluded.wikidata_qid, public.engagements.wikidata_qid),
      start_year = excluded.start_year, end_year = excluded.end_year, date_display = excluded.date_display,
      date_precision = excluded.date_precision, publication_status = 'published', updated_at = clock_timestamp()
    returning id into v_engagement_id;

    if jsonb_typeof(locked_case.payload->'commanders') <> 'array' then raise exception 'approved battle requires staged commanders'; end if;
    commander_count := jsonb_array_length(p_mutation->'commanderRefs');
    if commander_count < 2 or commander_count <> jsonb_array_length(locked_case.payload->'commanders') then raise exception 'commander references must align with staged payload'; end if;
    first_outcome := coalesce(p_mutation->'battle'->>'outcome', 'unknown');
    for commander_index in 0..commander_count - 1 loop
      commander_ref := p_mutation->'commanderRefs'->commander_index;
      payload_commander := locked_case.payload->'commanders'->commander_index;
      v_commander_id := curation_private.resolve_commander_ref(commander_ref->>'id');
      side_label := nullif(btrim(payload_commander->>'side'), '');
      if side_label is null then raise exception 'every approved commander requires a staged side'; end if;
      side_position := array_position(side_labels, side_label);
      if side_position is null then
        side_labels := array_append(side_labels, side_label); side_position := array_length(side_labels, 1);
        side_outcome := case when side_position = 1 then first_outcome when first_outcome = 'victory' then 'defeat' when first_outcome = 'defeat' then 'victory' when first_outcome in ('draw', 'inconclusive', 'disputed') then first_outcome else 'unknown' end;
        insert into public.engagement_sides as existing_side (engagement_id, position, label, outcome)
        values (v_engagement_id, side_position, side_label, side_outcome)
        on conflict (engagement_id, position) do update set label = excluded.label, outcome = excluded.outcome
        returning id into v_side_id;
        side_ids := array_append(side_ids, v_side_id);
      else v_side_id := side_ids[side_position]; end if;
      insert into public.participations (engagement_side_id, commander_id, role, presence_status)
      values (v_side_id, v_commander_id, coalesce(payload_commander->>'rank', ''), 'unknown')
      on conflict (engagement_side_id, commander_id, role) do update set presence_status = excluded.presence_status;
    end loop;
    update public.engagements set elo_eligible = array_length(side_labels, 1) = 2 and first_outcome in ('victory', 'defeat', 'draw'), updated_at = clock_timestamp() where id = v_engagement_id;
    for evidence_item in select value from jsonb_array_elements(evidence) loop
      source_external_slug := 'curation-' || md5(coalesce(nullif(evidence_item->>'url', ''), evidence_item->>'citation'));
      insert into public.sources as existing_source (source_type, title, url, locator, external_slug, publication_status)
      values ('specialist', evidence_item->>'citation', nullif(evidence_item->>'url', ''), nullif(evidence_item->>'locator', ''), source_external_slug, 'published')
      on conflict (external_slug) where external_slug is not null do update set title = excluded.title, url = coalesce(excluded.url, existing_source.url), locator = coalesce(excluded.locator, existing_source.locator), publication_status = 'published', updated_at = clock_timestamp()
      returning id into v_source_id;
    end loop;
    insert into public.claims (claim_type, statement, publication_status) values (action_name, p_reason, 'published') returning id into v_claim_id;
    insert into public.engagement_claims (engagement_id, claim_id) values (v_engagement_id, v_claim_id);
    for evidence_item in select value from jsonb_array_elements(evidence) loop
      source_external_slug := 'curation-' || md5(coalesce(nullif(evidence_item->>'url', ''), evidence_item->>'citation'));
      select id into v_source_id from public.sources where external_slug = source_external_slug;
      insert into public.claim_sources (claim_id, source_id, relation, locator) values (v_claim_id, v_source_id, 'supports', nullif(evidence_item->>'locator', '')) on conflict do nothing;
    end loop;
    after_state := curation_private.capture_engagement_state(p_mutation->'battle'->>'slug', evidence_source_slugs);
  else
    source_ref := p_mutation->'source'->>'id'; target_ref := p_mutation->'target'->>'id';
    v_source_commander_id := curation_private.resolve_commander_ref(source_ref); v_target_commander_id := curation_private.resolve_commander_ref(target_ref);
    if v_source_commander_id = v_target_commander_id then raise exception 'identity mutation source and target must be distinct'; end if;
    perform 1 from public.commanders where id in (v_source_commander_id, v_target_commander_id) order by id for update;
    before_state := curation_private.capture_identity_state(v_source_commander_id, v_target_commander_id, source_ref, target_ref);
    select * into latest_link from public.commander_identity_links where source_commander_id = v_source_commander_id and target_commander_id = v_target_commander_id order by id desc limit 1;
    if action_name = 'merge_commanders' then
      if latest_link.id is not null and latest_link.link_state = 'linked' then raise exception 'commander identities are already linked'; end if;
      for participation_row in select * from public.participations where commander_id = v_source_commander_id order by id for update loop
        select id into v_existing_participation_id from public.participations where engagement_side_id = participation_row.engagement_side_id and commander_id = v_target_commander_id and role = participation_row.role;
        if v_existing_participation_id is null then update public.participations set commander_id = v_target_commander_id where id = participation_row.id;
        else insert into public.participation_claims (participation_id, claim_id) select v_existing_participation_id, claim_id from public.participation_claims where participation_id = participation_row.id on conflict do nothing; delete from public.participations where id = participation_row.id; end if;
      end loop;
      insert into public.commander_claims (commander_id, claim_id) select v_target_commander_id, claim_id from public.commander_claims where commander_id = v_source_commander_id on conflict do nothing;
      delete from public.commander_claims where commander_id = v_source_commander_id;
      update public.commanders set publication_status = 'retired', updated_at = clock_timestamp() where id = v_source_commander_id;
      update public.commanders set publication_status = 'published', updated_at = clock_timestamp() where id = v_target_commander_id;
    else
      if latest_link.id is null or latest_link.link_state <> 'linked' then raise exception 'commander identities are not currently linked'; end if;
      select * into linked_event from public.editorial_events where id = latest_link.editorial_event_id for update;
      if linked_event.action not in ('merge_commanders', 'revert_separate_commanders') then raise exception 'linked identity history has no reversible linked snapshot'; end if;
      perform curation_private.restore_identity_state(linked_event.before_state, linked_event.after_state);
    end if;
    after_state := curation_private.capture_identity_state(v_source_commander_id, v_target_commander_id, source_ref, target_ref);
  end if;

  insert into public.editorial_events (case_id, actor_type, actor_id, action, before_state, after_state, reason, data_revision, model_versions, prompt_versions)
  values (locked_case.id, 'human', (select auth.uid())::text, action_name, before_state, after_state, p_reason, locked_case.source_revision, '{}'::jsonb, '{}'::jsonb)
  returning id into created_event_id;
  if action_name in ('merge_commanders', 'separate_commanders') then
    insert into public.commander_identity_links (source_commander_id, target_commander_id, source_ref, target_ref, link_state, editorial_event_id)
    values (v_source_commander_id, v_target_commander_id, source_ref, target_ref, case when action_name = 'merge_commanders' then 'linked' else 'separated' end, created_event_id);
  end if;
  update public.curation_cases set status = 'published', lease_owner = null, lease_expires_at = null, last_error = null, updated_at = clock_timestamp() where id = locked_case.id;
  insert into public.ranking_jobs (data_revision, algorithm_version, status, editorial_event_id)
  values (locked_case.source_revision || ':event:' || created_event_id::text, 'elo-v1', 'pending', created_event_id)
  on conflict (editorial_event_id) where editorial_event_id is not null do update set editorial_event_id = excluded.editorial_event_id
  returning id into created_job_id;
  return row(created_event_id, created_job_id)::public.curation_publication_result;
end;
$$;

create or replace function public.owner_curation_action(
  p_case_id bigint, p_action text, p_mutation jsonb, p_reason text
) returns public.curation_cases
language plpgsql security definer set search_path = ''
as $$
declare locked_case public.curation_cases; before_case jsonb; requested_event_id bigint; requested_event public.editorial_events;
begin
  if (select auth.uid()) is null or not exists (select 1 from public.curator_memberships m where m.user_id = (select auth.uid()) and m.role = 'owner') then raise exception 'curation action requires verified owner membership'; end if;
  if p_action in ('approve_corrected', 'merge', 'separate') then
    perform public.publish_owner_curation_decision(p_case_id, p_action, coalesce(p_mutation->'mutation', p_mutation), p_reason);
    select * into locked_case from public.curation_cases where id = p_case_id;
    return locked_case;
  end if;
  if p_action not in ('reject', 'retry', 'revert') then raise exception 'unsupported owner curation action'; end if;
  if p_reason is null or nullif(btrim(p_reason), '') is null or length(p_reason) > 2000 then raise exception 'curation action reason is required'; end if;
  select * into locked_case from public.curation_cases where id = p_case_id for update;
  if not found then raise exception 'curation case does not exist'; end if;
  before_case := to_jsonb(locked_case);
  if p_action = 'revert' then
    requested_event_id := (p_mutation->>'eventId')::bigint;
    if requested_event_id is null then raise exception 'reversion event id is required'; end if;
    select * into requested_event from public.editorial_events where id = requested_event_id and case_id = p_case_id for update;
    if not found or requested_event.action not in ('approve_battle', 'merge_commanders', 'separate_commanders') then
      raise exception 'event is not reversible for this curation case';
    end if;
    perform public.revert_editorial_event(requested_event_id, (select auth.uid()), p_reason);
  else
    update public.curation_cases set status = case when p_action = 'retry' then 'pending' else 'rejected' end,
      lease_owner = null, lease_expires_at = null, last_error = case when p_action = 'retry' then null else locked_case.last_error end, updated_at = clock_timestamp()
    where id = p_case_id returning * into locked_case;
    insert into public.editorial_events (case_id, actor_type, actor_id, action, before_state, after_state, reason, data_revision, model_versions, prompt_versions)
    values (p_case_id, 'human', (select auth.uid())::text, p_action, before_case, to_jsonb(locked_case), p_reason, locked_case.source_revision, '{}'::jsonb, '{}'::jsonb);
  end if;
  select * into locked_case from public.curation_cases where id = p_case_id; return locked_case;
end;
$$;

revoke all on function public.publish_owner_curation_decision(bigint, text, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.owner_curation_action(bigint, text, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.owner_curation_action(bigint, text, jsonb, text) to authenticated;
