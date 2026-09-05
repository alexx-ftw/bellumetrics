-- Reviewed enrichment stays in the immutable decision; the imported payload is untouched.
create function curation_private.valid_participants(m jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare p jsonb; i integer := 0; sides text[] := '{}'; ids text[] := '{}';
begin
  if jsonb_typeof(m->'participants') is distinct from 'array'
    or jsonb_typeof(m->'commanderRefs') is distinct from 'array' then return false; end if;
  if jsonb_array_length(m->'participants') < 2
    or jsonb_array_length(m->'participants') <> jsonb_array_length(m->'commanderRefs') then return false; end if;
  for p in select value from jsonb_array_elements(m->'participants') loop
    if jsonb_typeof(p) is distinct from 'object'
      or not (p ?& array['ref','side']) or p - array['ref','side'] <> '{}'::jsonb
      or not curation_private.is_strict_entity_ref(p->'ref','commander')
      or p->'ref' is distinct from m->'commanderRefs'->i
      or jsonb_typeof(p->'side') is distinct from 'string'
      or nullif(btrim(p->>'side'),'') is null
      or p->>'side' is distinct from btrim(p->>'side')
      or (p->'ref'->>'id') = any(ids) then return false; end if;
    ids := array_append(ids,p->'ref'->>'id');
    if not (p->>'side') = any(sides) then sides := array_append(sides,p->>'side'); end if;
    i := i+1;
  end loop;
  return cardinality(sides)=2;
end;
$$;
revoke all on function curation_private.valid_participants(jsonb) from public,anon,authenticated;

create function curation_private.effective_battle_commanders(raw_payload jsonb, m jsonb, revision text)
returns jsonb language plpgsql set search_path = '' as $$
declare result jsonb := '[]'; p jsonb; cid bigint; person public.commanders; imported jsonb; ref text;
begin
  if not (m ? 'participants') then return raw_payload->'commanders'; end if;
  if not curation_private.valid_participants(m) then raise exception 'invalid participant proposal'; end if;
  if coalesce(raw_payload->'commanders','[]'::jsonb) <> '[]'::jsonb then
    raise exception 'participant proposal cannot overwrite original commanders';
  end if;
  for p in select value from jsonb_array_elements(m->'participants') loop
    ref := p->'ref'->>'id';
    cid := null;
    begin
      cid := curation_private.resolve_commander_ref(ref);
    exception when sqlstate 'P0001' then
      cid := null;
    end;
    if cid is not null then
      select * into person from public.commanders where id=cid;
      if person.publication_status = 'retired' then raise exception 'retired participant'; end if;
      result := result || jsonb_build_array(jsonb_build_object(
        'name',person.display_name,'slug',
        case when ref like 'war-atlas:%' then split_part(ref,':',2) else person.slug end,
        'rank','','side',p->>'side'));
    elsif ref like 'war-atlas:%' then
      select ir.payload into imported from public.import_records ir
      join public.import_runs r on r.id=ir.import_run_id
      where r.status='staged' and r.source_dataset='the-war-atlas' and r.source_version=revision
        and ir.entity_type='commander' and ir.external_id=split_part(ref,':',2)
      order by ir.id limit 1;
      if imported is null or nullif(btrim(coalesce(imported->>'name',imported->>'title')),'') is null then
        raise exception 'participant requires a verified imported identity';
      end if;
      result := result || jsonb_build_array(jsonb_build_object(
        'name',coalesce(imported->>'name',imported->>'title'),'slug',split_part(ref,':',2),
        'rank','','side',p->>'side'));
    else
      raise exception 'participant requires an existing canonical identity';
    end if;
  end loop;
  return result;
end;
$$;
revoke all on function curation_private.effective_battle_commanders(jsonb,jsonb,text) from public,anon,authenticated;

create or replace function curation_private.is_strict_canonical_mutation(
  candidate jsonb,
  expected_action text
) returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  battle jsonb;
  reference jsonb;
  start_year numeric;
  end_year numeric;
begin
  if jsonb_typeof(candidate) <> 'object'
    or candidate->>'action' is distinct from expected_action then
    return false;
  end if;

  if expected_action = 'approve_battle' then
    if not (candidate ?& array['action', 'battle', 'commanderRefs'])
      or candidate - array['action', 'battle', 'commanderRefs', 'participants'] <> '{}'::jsonb
      or jsonb_typeof(candidate->'battle') <> 'object'
      or jsonb_typeof(candidate->'commanderRefs') <> 'array'
      or jsonb_array_length(candidate->'commanderRefs') = 0 then
      return false;
    end if;
    if candidate ? 'participants' then
      if not curation_private.valid_participants(candidate) then return false; end if;
    end if;
    battle := candidate->'battle';
    if not (battle ?& array['ref', 'slug', 'title'])
      or battle - array['ref', 'slug', 'title', 'startYear', 'endYear', 'outcome'] <> '{}'::jsonb
      or not curation_private.is_strict_entity_ref(battle->'ref', 'battle')
      or jsonb_typeof(battle->'slug') <> 'string'
      or nullif(btrim(battle->>'slug'), '') is null
      or jsonb_typeof(battle->'title') <> 'string'
      or nullif(btrim(battle->>'title'), '') is null then
      return false;
    end if;
    if battle ? 'startYear' then
      if jsonb_typeof(battle->'startYear') <> 'number' then return false; end if;
      start_year := (battle->>'startYear')::numeric;
      if start_year <> trunc(start_year)
        or start_year not between -2147483648 and 2147483647 then return false; end if;
    end if;
    if battle ? 'endYear' then
      if jsonb_typeof(battle->'endYear') <> 'number' then return false; end if;
      end_year := (battle->>'endYear')::numeric;
      if end_year <> trunc(end_year)
        or end_year not between -2147483648 and 2147483647 then return false; end if;
    end if;
    if start_year is not null and end_year is not null and end_year < start_year then
      return false;
    end if;
    if battle ? 'outcome' and (
      jsonb_typeof(battle->'outcome') <> 'string'
      or battle->>'outcome' not in (
        'victory', 'defeat', 'draw', 'inconclusive', 'disputed', 'unknown'
      )
    ) then
      return false;
    end if;
    for reference in select value from jsonb_array_elements(candidate->'commanderRefs')
    loop
      if not curation_private.is_strict_entity_ref(reference, 'commander') then
        return false;
      end if;
    end loop;
    return true;
  end if;

  if expected_action in ('merge_commanders', 'separate_commanders') then
    return candidate ?& array['action', 'source', 'target']
      and candidate - array['action', 'source', 'target'] = '{}'::jsonb
      and curation_private.is_strict_entity_ref(candidate->'source', 'commander')
      and curation_private.is_strict_entity_ref(candidate->'target', 'commander')
      and candidate->'source'->>'id' <> candidate->'target'->>'id';
  end if;
  return false;
end;
$$;
create or replace function curation_private.publish_curation_decision(
  case_id bigint,
  worker_id text,
  proposer_review_id bigint,
  reviewer_review_id bigint,
  configured_model text
) returns table (event_id bigint, ranking_job_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_case public.curation_cases;
  proposer public.ai_reviews;
  reviewer public.ai_reviews;
  decision jsonb;
  mutation jsonb;
  action_name text;
  before_state jsonb;
  after_state jsonb;
  created_event_id bigint;
  created_job_id bigint;
  v_engagement_id bigint;
  v_claim_id bigint;
  v_source_id bigint;
  v_commander_id bigint;
  v_source_commander_id bigint;
  v_target_commander_id bigint;
  source_ref text;
  target_ref text;
  evidence_item jsonb;
  commander_ref jsonb;
  payload_commander jsonb;
  effective_commanders jsonb;
  commander_index integer;
  commander_count integer;
  side_label text;
  side_labels text[] := '{}'::text[];
  side_ids bigint[] := '{}'::bigint[];
  side_position integer;
  v_side_id bigint;
  first_outcome text;
  side_outcome text;
  source_external_slug text;
  evidence_source_slugs text[] := '{}'::text[];
  v_existing_participation_id bigint;
  participation_row record;
  latest_link public.commander_identity_links;
  linked_event public.editorial_events;
begin
  if worker_id is null or btrim(worker_id) = '' then
    raise exception 'worker_id must not be empty';
  end if;
  if proposer_review_id is null or reviewer_review_id is null
    or proposer_review_id = reviewer_review_id then
    raise exception 'publication requires exact distinct review ids';
  end if;
  if configured_model is null or btrim(configured_model) = '' then
    raise exception 'configured model must not be empty';
  end if;

  select c.* into locked_case
  from public.curation_cases c
  where c.id = publish_curation_decision.case_id
  for update;
  if not found then
    raise exception 'curation case does not exist';
  end if;

  if locked_case.status = 'published' then
    select e.id, j.id into created_event_id, created_job_id
    from public.editorial_events e
    join public.ranking_jobs j on j.editorial_event_id = e.id
    where e.case_id = locked_case.id
      and e.actor_type = 'ai'
      and e.actor_id = worker_id
      and e.proposer_review_id = publish_curation_decision.proposer_review_id
      and e.reviewer_review_id = publish_curation_decision.reviewer_review_id
      and e.model_versions->>'proposer' = configured_model
      and e.model_versions->>'reviewer' = configured_model
      and e.reverts_event_id is null
    order by e.id
    limit 1;
    if created_event_id is null then
      raise exception 'published case has no matching publication event';
    end if;
    return query select created_event_id, created_job_id;
    return;
  end if;

  if locked_case.status is distinct from 'leased'
    or locked_case.lease_owner is distinct from worker_id
    or locked_case.lease_expires_at is null
    or locked_case.lease_expires_at <= clock_timestamp() then
    raise exception 'worker is not the active lease owner';
  end if;

  select r.* into proposer
  from public.ai_reviews r
  where r.id = publish_curation_decision.proposer_review_id
    and r.case_id = locked_case.id
    and r.review_role = 'proposer'
  for update;
  select r.* into reviewer
  from public.ai_reviews r
  where r.id = publish_curation_decision.reviewer_review_id
    and r.case_id = locked_case.id
    and r.review_role = 'reviewer'
  for update;

  if proposer.id is null or reviewer.id is null
    or proposer.model is distinct from configured_model
    or reviewer.model is distinct from configured_model
    or proposer.prompt_version is distinct from 'proposer-v1'
    or reviewer.prompt_version is distinct from 'reviewer-v1' then
    raise exception 'publication requires exact review ids with two compatible reviews for the configured model and leased revision';
  end if;
  if not curation_private.is_strict_publication_decision(
      proposer.decision,
      proposer.evidence,
      'proposer-v1',
      locked_case.source_revision,
      locked_case.entity_type
    )
    or not curation_private.is_strict_publication_decision(
      reviewer.decision,
      reviewer.evidence,
      'reviewer-v1',
      locked_case.source_revision,
      locked_case.entity_type
    ) then
    raise exception 'publication requires normalized canonical mutation, evidence, reason, prompt, and revision';
  end if;
  if proposer.decision->>'action' is distinct from reviewer.decision->>'action'
    or proposer.decision->'canonicalMutation'
      is distinct from reviewer.decision->'canonicalMutation' then
    raise exception 'publication requires exact review ids with two compatible reviews for the configured model and leased revision';
  end if;

  decision := proposer.decision;
  mutation := decision->'canonicalMutation';
  action_name := decision->>'action';
  if action_name = 'approve_battle' then
    effective_commanders := curation_private.effective_battle_commanders(locked_case.payload,mutation,locked_case.source_revision);
  end if;
  if mutation is null or jsonb_typeof(mutation) <> 'object'
    or mutation->>'action' is distinct from action_name
    or action_name not in ('approve_battle', 'merge_commanders', 'separate_commanders') then
    raise exception 'publication action is not a validated canonical mutation';
  end if;
  if (action_name = 'approve_battle'
      and locked_case.entity_type is distinct from 'battle')
    or (action_name in ('merge_commanders', 'separate_commanders')
      and locked_case.entity_type is distinct from 'commander') then
    raise exception 'publication action is incompatible with the curation case type';
  end if;

  if action_name = 'approve_battle' then
    if jsonb_typeof(decision->'evidence') <> 'array'
      or jsonb_array_length(decision->'evidence') = 0 then
      raise exception 'approved battle requires cited evidence';
    end if;
    for evidence_item in select value from jsonb_array_elements(decision->'evidence')
    loop
      if nullif(btrim(evidence_item->>'citation'), '') is null then
        raise exception 'approved battle evidence citation is required';
      end if;
      source_external_slug := 'curation-' || md5(coalesce(
        nullif(evidence_item->>'url', ''),
        evidence_item->>'citation'
      ));
      if not source_external_slug = any(evidence_source_slugs) then
        evidence_source_slugs := array_append(evidence_source_slugs, source_external_slug);
      end if;
    end loop;

    perform curation_private.lock_evidence_sources(evidence_source_slugs);
    perform curation_private.lock_engagement_graph(
      mutation->'battle'->>'slug',
      evidence_source_slugs
    );
    perform 1 from public.curation_cases c
    where c.id = locked_case.id
      and c.status = 'leased'
      and c.lease_owner = worker_id
      and c.lease_expires_at > clock_timestamp();
    if not found then
      raise exception 'worker is not the active lease owner after canonical graph lock';
    end if;
    before_state := curation_private.capture_engagement_state(
      mutation->'battle'->>'slug',
      evidence_source_slugs
    );

    insert into public.engagements (
      slug, title, wikidata_qid, start_year, end_year, date_display,
      date_precision, elo_eligible, publication_status
    ) values (
      mutation->'battle'->>'slug',
      mutation->'battle'->>'title',
      case
        when locked_case.payload->>'wikidata_qid' ~ '^Q[1-9][0-9]*$'
          then locked_case.payload->>'wikidata_qid'
        else null
      end,
      nullif(mutation->'battle'->>'startYear', '')::integer,
      nullif(mutation->'battle'->>'endYear', '')::integer,
      nullif(locked_case.payload->>'date_iso', ''),
      case
        when nullif(locked_case.payload->>'date_iso', '') is not null then 'exact'
        when mutation->'battle'->>'startYear' is not null then 'year'
        else 'unknown'
      end,
      false,
      'published'
    )
    on conflict (slug) do update set
      title = excluded.title,
      wikidata_qid = coalesce(excluded.wikidata_qid, public.engagements.wikidata_qid),
      start_year = excluded.start_year,
      end_year = excluded.end_year,
      date_display = excluded.date_display,
      date_precision = excluded.date_precision,
      publication_status = 'published',
      updated_at = clock_timestamp()
    returning id into v_engagement_id;

    if jsonb_typeof(mutation->'commanderRefs') <> 'array'
      or jsonb_typeof(effective_commanders) <> 'array' then
      raise exception 'approved battle requires ordered commander references and payload commanders';
    end if;
    commander_count := jsonb_array_length(mutation->'commanderRefs');
    if commander_count < 2
      or commander_count <> jsonb_array_length(effective_commanders) then
      raise exception 'commander references must align with the staged battle payload';
    end if;
    first_outcome := coalesce(mutation->'battle'->>'outcome', 'unknown');

    for commander_index in 0..commander_count - 1
    loop
      commander_ref := mutation->'commanderRefs'->commander_index;
      payload_commander := effective_commanders->commander_index;
      v_commander_id := curation_private.resolve_commander_ref(commander_ref->>'id');
      side_label := nullif(btrim(payload_commander->>'side'), '');
      if side_label is null then
        raise exception 'every approved commander requires an explicit staged side';
      end if;
      side_position := array_position(side_labels, side_label);
      if side_position is null then
        side_labels := array_append(side_labels, side_label);
        side_position := array_length(side_labels, 1);
        side_outcome := case
          when side_position = 1 then first_outcome
          when first_outcome = 'victory' then 'defeat'
          when first_outcome = 'defeat' then 'victory'
          when first_outcome in ('draw', 'inconclusive', 'disputed') then first_outcome
          else 'unknown'
        end;
        insert into public.engagement_sides as existing_side (
          engagement_id, position, label, outcome
        ) values (
          v_engagement_id, side_position, side_label, side_outcome
        )
        on conflict (engagement_id, position) do update set
          label = excluded.label,
          outcome = excluded.outcome
        returning id into v_side_id;
        side_ids := array_append(side_ids, v_side_id);
      else
        v_side_id := side_ids[side_position];
      end if;

      insert into public.participations (
        engagement_side_id, commander_id, role, presence_status
      ) values (
        v_side_id,
        v_commander_id,
        coalesce(payload_commander->>'rank', ''),
        'unknown'
      )
      on conflict (engagement_side_id, commander_id, role) do update set
        presence_status = excluded.presence_status;
    end loop;

    update public.engagements e
    set elo_eligible = array_length(side_labels, 1) = 2
        and first_outcome in ('victory', 'defeat', 'draw'),
        updated_at = clock_timestamp()
    where e.id = v_engagement_id;

    for evidence_item in select value from jsonb_array_elements(decision->'evidence')
    loop
      source_external_slug := 'curation-' || md5(coalesce(
        nullif(evidence_item->>'url', ''),
        evidence_item->>'citation'
      ));
      insert into public.sources as existing_source (
        source_type, title, url, locator, external_slug, publication_status
      ) values (
        'specialist',
        evidence_item->>'citation',
        nullif(evidence_item->>'url', ''),
        nullif(evidence_item->>'locator', ''),
        source_external_slug,
        'published'
      )
      on conflict (external_slug) where external_slug is not null do update set
        title = excluded.title,
        url = coalesce(excluded.url, existing_source.url),
        locator = coalesce(excluded.locator, existing_source.locator),
        publication_status = 'published',
        updated_at = clock_timestamp()
      returning id into v_source_id;
    end loop;

    insert into public.claims (
      claim_type, statement, confidence, publication_status
    ) values (
      action_name,
      decision->>'reason',
      case
        when jsonb_typeof(decision->'confidence') = 'number'
          and (decision->>'confidence')::numeric between 0 and 1
          then (decision->>'confidence')::numeric
        else null
      end,
      'published'
    ) returning id into v_claim_id;
    insert into public.engagement_claims (engagement_id, claim_id)
    values (v_engagement_id, v_claim_id);
    for evidence_item in select value from jsonb_array_elements(decision->'evidence')
    loop
      source_external_slug := 'curation-' || md5(coalesce(
        nullif(evidence_item->>'url', ''),
        evidence_item->>'citation'
      ));
      select s.id into v_source_id
      from public.sources s where s.external_slug = source_external_slug;
      insert into public.claim_sources (claim_id, source_id, relation, locator)
      values (v_claim_id, v_source_id, 'supports', nullif(evidence_item->>'locator', ''))
      on conflict (claim_id, source_id) do nothing;
    end loop;

    after_state := curation_private.capture_engagement_state(
      mutation->'battle'->>'slug',
      evidence_source_slugs
    );
  else
    source_ref := mutation->'source'->>'id';
    target_ref := mutation->'target'->>'id';
    v_source_commander_id := curation_private.resolve_commander_ref(source_ref);
    v_target_commander_id := curation_private.resolve_commander_ref(target_ref);
    if v_source_commander_id = v_target_commander_id then
      raise exception 'identity mutation source and target must be distinct';
    end if;

    perform 1
    from public.commanders c
    where c.id in (v_source_commander_id, v_target_commander_id)
    order by c.id
    for update;
    perform 1 from public.curation_cases c
    where c.id = locked_case.id
      and c.status = 'leased'
      and c.lease_owner = worker_id
      and c.lease_expires_at > clock_timestamp();
    if not found then
      raise exception 'worker is not the active lease owner after canonical graph lock';
    end if;
    before_state := curation_private.capture_identity_state(
      v_source_commander_id, v_target_commander_id, source_ref, target_ref
    );

    select l.* into latest_link
    from public.commander_identity_links l
    where l.source_commander_id = v_source_commander_id
      and l.target_commander_id = v_target_commander_id
    order by l.id desc
    limit 1;

    if action_name = 'merge_commanders' then
      if latest_link.id is not null and latest_link.link_state = 'linked' then
        raise exception 'commander identities are already linked';
      end if;
      for participation_row in
        select p.*
        from public.participations p
        where p.commander_id = v_source_commander_id
        order by p.id
        for update
      loop
        select p.id into v_existing_participation_id
        from public.participations p
        where p.engagement_side_id = participation_row.engagement_side_id
          and p.commander_id = v_target_commander_id
          and p.role = participation_row.role;
        if v_existing_participation_id is null then
          update public.participations p
          set commander_id = v_target_commander_id
          where p.id = participation_row.id;
        else
          insert into public.participation_claims (participation_id, claim_id)
          select v_existing_participation_id, pc.claim_id
          from public.participation_claims pc
          where pc.participation_id = participation_row.id
          on conflict do nothing;
          delete from public.participations p where p.id = participation_row.id;
        end if;
      end loop;
      insert into public.commander_claims (commander_id, claim_id)
      select v_target_commander_id, cc.claim_id
      from public.commander_claims cc
      where cc.commander_id = v_source_commander_id
      on conflict do nothing;
      delete from public.commander_claims cc
      where cc.commander_id = v_source_commander_id;
      update public.commanders c
      set publication_status = 'retired', updated_at = clock_timestamp()
      where c.id = v_source_commander_id;
      update public.commanders c
      set publication_status = 'published', updated_at = clock_timestamp()
      where c.id = v_target_commander_id;
    else
      if latest_link.id is null or latest_link.link_state <> 'linked' then
        raise exception 'commander identities are not currently linked';
      end if;
      select e.* into linked_event
      from public.editorial_events e
      where e.id = latest_link.editorial_event_id
      for update;
      if linked_event.action not in ('merge_commanders', 'revert_separate_commanders') then
        raise exception 'linked identity history has no reversible linked snapshot';
      end if;
      perform curation_private.restore_identity_state(
        linked_event.before_state,
        linked_event.after_state
      );
    end if;

    after_state := curation_private.capture_identity_state(
      v_source_commander_id, v_target_commander_id, source_ref, target_ref
    );
  end if;

  insert into public.editorial_events (
    case_id, actor_type, actor_id, action, before_state, after_state,
    reason, data_revision, model_versions, prompt_versions,
    proposer_review_id, reviewer_review_id
  ) values (
    locked_case.id,
    'ai',
    worker_id,
    action_name,
    before_state,
    after_state,
    decision->>'reason',
    locked_case.source_revision,
    jsonb_build_object('proposer', proposer.model, 'reviewer', reviewer.model),
    jsonb_build_object(
      'proposer', proposer.prompt_version,
      'reviewer', reviewer.prompt_version
    ),
    proposer.id,
    reviewer.id
  ) returning id into created_event_id;

  if action_name in ('merge_commanders', 'separate_commanders') then
    insert into public.commander_identity_links (
      source_commander_id, target_commander_id, source_ref, target_ref,
      link_state, editorial_event_id
    ) values (
      v_source_commander_id,
      v_target_commander_id,
      source_ref,
      target_ref,
      case when action_name = 'merge_commanders' then 'linked' else 'separated' end,
      created_event_id
    );
  end if;

  update public.curation_cases c
  set status = 'published',
      lease_owner = null,
      lease_expires_at = null,
      last_error = null,
      updated_at = clock_timestamp()
  where c.id = locked_case.id;

  insert into public.ranking_jobs (
    data_revision, algorithm_version, status, editorial_event_id
  ) values (
    locked_case.source_revision || ':event:' || created_event_id::text,
    'elo-v1',
    'pending',
    created_event_id
  )
  on conflict (editorial_event_id) where editorial_event_id is not null do update
    set editorial_event_id = excluded.editorial_event_id
  returning id into created_job_id;

  return query select created_event_id, created_job_id;
end;
$$;
create or replace function public.publish_curation_decision(
  case_id bigint,
  worker_id text,
  proposer_review_id bigint,
  reviewer_review_id bigint,
  configured_model text
) returns table (event_id bigint, ranking_job_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  mutation jsonb;
  reviewer_mutation jsonb;
  payload_commanders jsonb;
  case_status text;
  raw_case public.curation_cases;
  commander_preparation jsonb;
  created_event_id bigint;
  created_job_id bigint;
begin
  select * into raw_case from public.curation_cases where id=publish_curation_decision.case_id for update;
  if not found then raise exception 'curation case does not exist'; end if;
  if raw_case.status <> 'published' and (
    raw_case.status is distinct from 'leased' or raw_case.lease_owner is distinct from worker_id
    or raw_case.lease_expires_at is null or raw_case.lease_expires_at <= clock_timestamp()
  ) then raise exception 'worker is not the active lease owner'; end if;
  select review.decision->'canonicalMutation'
  into mutation
  from public.ai_reviews review
  where review.id = publish_curation_decision.proposer_review_id
    and review.case_id = publish_curation_decision.case_id;
  select review.decision->'canonicalMutation'
  into reviewer_mutation
  from public.ai_reviews review
  where review.id = publish_curation_decision.reviewer_review_id
    and review.case_id = publish_curation_decision.case_id;
  select curation_case.payload->'commanders', curation_case.status
  into payload_commanders, case_status
  from public.curation_cases curation_case
  where curation_case.id = publish_curation_decision.case_id;

  if case_status <> 'published' and mutation ? 'participants' then
    payload_commanders := curation_private.effective_battle_commanders(raw_case.payload,mutation,raw_case.source_revision);
  end if;
  if case_status <> 'published'
    and mutation->>'action' = 'approve_battle'
    and mutation is not distinct from reviewer_mutation
    and jsonb_typeof(mutation->'commanderRefs') = 'array'
    and jsonb_typeof(payload_commanders) = 'array' then
    if jsonb_array_length(mutation->'commanderRefs') >= 2
      and jsonb_array_length(mutation->'commanderRefs')
        = jsonb_array_length(payload_commanders) then
      commander_preparation := curation_private.prepare_war_atlas_battle_commanders(
        mutation->'commanderRefs',
        payload_commanders
      );
    end if;
  end if;

  select published.event_id, published.ranking_job_id
  into created_event_id, created_job_id
  from curation_private.publish_curation_decision(
    publish_curation_decision.case_id,
    worker_id,
    proposer_review_id,
    reviewer_review_id,
    configured_model
  ) published;

  perform curation_private.attach_battle_commander_audit(
    created_event_id,
    commander_preparation
  );
  return query select created_event_id, created_job_id;
end;
$$;
