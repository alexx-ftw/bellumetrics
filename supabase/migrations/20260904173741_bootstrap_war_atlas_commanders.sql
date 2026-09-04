create function curation_private.normalized_war_atlas_commander_slug(
  entity_ref text,
  payload_commander jsonb
) returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  source_slug text;
  payload_slug text;
  canonical_slug text;
begin
  if split_part(entity_ref, ':', 1) <> 'war-atlas' then
    return null;
  end if;
  if entity_ref !~ '^war-atlas:[A-Za-z0-9][A-Za-z0-9_-]*$' then
    raise exception 'invalid War Atlas commander reference: %', entity_ref;
  end if;
  if jsonb_typeof(payload_commander) <> 'object'
    or nullif(btrim(payload_commander->>'name'), '') is null then
    raise exception 'War Atlas commander payload requires a display name';
  end if;

  source_slug := substring(entity_ref from position(':' in entity_ref) + 1);
  payload_slug := nullif(btrim(payload_commander->>'slug'), '');
  if payload_slug is null then
    raise exception 'War Atlas commander payload requires a slug';
  end if;

  canonical_slug := lower(replace(source_slug, '_', '-'));
  payload_slug := lower(replace(payload_slug, '_', '-'));
  if canonical_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or payload_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'War Atlas commander slug cannot be normalized safely';
  end if;
  if canonical_slug is distinct from payload_slug then
    raise exception 'War Atlas commander reference does not match the ordered payload';
  end if;
  return canonical_slug;
end;
$$;

create function curation_private.prepare_war_atlas_battle_commanders(
  commander_refs jsonb,
  payload_commanders jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  commander_index integer;
  commander_count integer;
  commander_ref jsonb;
  payload_commander jsonb;
  canonical_slug text;
  normalized_slugs text[] := '{}'::text[];
  before_commanders jsonb;
  after_commanders jsonb;
  existing_commander public.commanders;
begin
  if jsonb_typeof(commander_refs) <> 'array'
    or jsonb_typeof(payload_commanders) <> 'array' then
    raise exception 'approved battle requires ordered commander references and payload commanders';
  end if;
  commander_count := jsonb_array_length(commander_refs);
  if commander_count < 2
    or commander_count <> jsonb_array_length(payload_commanders) then
    raise exception 'commander references must align with the staged battle payload';
  end if;

  for commander_index in 0..commander_count - 1
  loop
    commander_ref := commander_refs->commander_index;
    payload_commander := payload_commanders->commander_index;
    canonical_slug := curation_private.normalized_war_atlas_commander_slug(
      commander_ref->>'id',
      payload_commander
    );
    if canonical_slug is not null and not canonical_slug = any(normalized_slugs) then
      normalized_slugs := array_append(normalized_slugs, canonical_slug);
    end if;
  end loop;

  select coalesce(array_agg(slug order by slug), '{}'::text[])
  into normalized_slugs
  from (
    select distinct unnest(normalized_slugs) as slug
  ) normalized;

  foreach canonical_slug in array normalized_slugs
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('bellumetrics:commander:' || canonical_slug, 0)
    );
  end loop;

  select coalesce(jsonb_agg(to_jsonb(commander) order by commander.slug), '[]'::jsonb)
  into before_commanders
  from public.commanders commander
  where commander.slug = any(normalized_slugs);

  for commander_index in 0..commander_count - 1
  loop
    commander_ref := commander_refs->commander_index;
    payload_commander := payload_commanders->commander_index;
    canonical_slug := curation_private.normalized_war_atlas_commander_slug(
      commander_ref->>'id',
      payload_commander
    );
    if canonical_slug is null then
      continue;
    end if;

    select commander.* into existing_commander
    from public.commanders commander
    where commander.slug = canonical_slug
    for update;

    if not found then
      insert into public.commanders (slug, display_name, publication_status)
      values (canonical_slug, btrim(payload_commander->>'name'), 'published');
    elsif existing_commander.publication_status = 'retired' then
      raise exception 'retired commander cannot be republished automatically: %', canonical_slug;
    elsif existing_commander.publication_status <> 'published' then
      update public.commanders commander
      set publication_status = 'published',
          updated_at = clock_timestamp()
      where commander.id = existing_commander.id;
    end if;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(commander) order by commander.slug), '[]'::jsonb)
  into after_commanders
  from public.commanders commander
  where commander.slug = any(normalized_slugs);

  return jsonb_build_object(
    'slugs', to_jsonb(normalized_slugs),
    'before', before_commanders,
    'after', after_commanders
  );
end;
$$;

create function curation_private.attach_battle_commander_audit(
  publication_event_id bigint,
  commander_preparation jsonb
) returns void
language plpgsql
set search_path = ''
as $$
begin
  if commander_preparation is null
    or jsonb_array_length(commander_preparation->'slugs') = 0 then
    return;
  end if;

  update public.editorial_events event
  set before_state = jsonb_set(
        jsonb_set(
          event.before_state,
          '{metadata,commander_slugs}',
          commander_preparation->'slugs',
          true
        ),
        '{commanders}',
        commander_preparation->'before',
        true
      ),
      after_state = jsonb_set(
        jsonb_set(
          event.after_state,
          '{metadata,commander_slugs}',
          commander_preparation->'slugs',
          true
        ),
        '{commanders}',
        commander_preparation->'after',
        true
      )
  where event.id = publication_event_id
    and event.action = 'approve_battle'
    and not event.before_state ? 'commanders';
end;
$$;

alter function curation_private.restore_engagement_state(jsonb, jsonb)
  rename to restore_engagement_state_base;

create function curation_private.restore_engagement_state(
  before_state jsonb,
  expected_state jsonb
) returns void
language plpgsql
set search_path = ''
as $$
declare
  engagement_slug text := before_state->'metadata'->>'engagement_slug';
  source_slugs text[];
  commander_slugs text[];
  lock_slug text;
  current_state jsonb;
  current_commanders jsonb;
  base_before_state jsonb;
  base_expected_state jsonb;
  commander_item jsonb;
  before_commander jsonb;
  v_commander_id bigint;
begin
  if not expected_state ? 'commanders' then
    perform curation_private.restore_engagement_state_base(before_state, expected_state);
    return;
  end if;

  select coalesce(array_agg(value order by value), '{}'::text[])
  into source_slugs
  from jsonb_array_elements_text(
    before_state->'metadata'->'source_external_slugs'
  ) value;
  select coalesce(array_agg(value order by value), '{}'::text[])
  into commander_slugs
  from jsonb_array_elements_text(
    expected_state->'metadata'->'commander_slugs'
  ) value;

  foreach lock_slug in array commander_slugs
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('bellumetrics:commander:' || lock_slug, 0)
    );
  end loop;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('bellumetrics:engagement:' || engagement_slug, 0)
  );

  select coalesce(jsonb_agg(to_jsonb(commander) order by commander.slug), '[]'::jsonb)
  into current_commanders
  from public.commanders commander
  where commander.slug = any(commander_slugs);
  current_state := curation_private.capture_engagement_state(
    engagement_slug,
    source_slugs
  );
  current_state := jsonb_set(
    jsonb_set(
      current_state,
      '{metadata,commander_slugs}',
      to_jsonb(commander_slugs),
      true
    ),
    '{commanders}',
    current_commanders,
    true
  );
  if current_state is distinct from expected_state then
    raise exception 'canonical engagement state changed after the editorial event';
  end if;

  base_before_state := jsonb_set(
    before_state - 'commanders',
    '{metadata}',
    (before_state->'metadata') - 'commander_slugs'
  );
  base_expected_state := jsonb_set(
    expected_state - 'commanders',
    '{metadata}',
    (expected_state->'metadata') - 'commander_slugs'
  );
  perform curation_private.restore_engagement_state_base(
    base_before_state,
    base_expected_state
  );

  for commander_item in
    select value
    from jsonb_array_elements(expected_state->'commanders') value
  loop
    v_commander_id := (commander_item->>'id')::bigint;
    select value into before_commander
    from jsonb_array_elements(before_state->'commanders') value
    where (value->>'id')::bigint = v_commander_id;

    if before_commander is null then
      if exists (
        select 1 from public.participations participation
        where participation.commander_id = v_commander_id
      ) or exists (
        select 1 from public.commander_claims commander_claim
        where commander_claim.commander_id = v_commander_id
      ) or exists (
        select 1 from public.commander_identity_links identity_link
        where identity_link.source_commander_id = v_commander_id
           or identity_link.target_commander_id = v_commander_id
      ) then
        raise exception 'bootstrapped commander gained dependencies after the editorial event';
      end if;
      delete from public.commanders commander where commander.id = v_commander_id;
    elsif before_commander is distinct from commander_item then
      if exists (
        select 1 from public.participations participation
        where participation.commander_id = v_commander_id
      ) or exists (
        select 1 from public.commander_claims commander_claim
        where commander_claim.commander_id = v_commander_id
      ) or exists (
        select 1 from public.commander_identity_links identity_link
        where identity_link.source_commander_id = v_commander_id
           or identity_link.target_commander_id = v_commander_id
      ) then
        raise exception 'bootstrapped commander gained dependencies after the editorial event';
      end if;
      update public.commanders commander
      set slug = before_commander->>'slug',
          display_name = before_commander->>'display_name',
          wikidata_qid = nullif(before_commander->>'wikidata_qid', ''),
          birth_year = nullif(before_commander->>'birth_year', '')::integer,
          death_year = nullif(before_commander->>'death_year', '')::integer,
          historicity_status = before_commander->>'historicity_status',
          publication_status = before_commander->>'publication_status',
          created_at = (before_commander->>'created_at')::timestamptz,
          updated_at = (before_commander->>'updated_at')::timestamptz
      where commander.id = v_commander_id;
    end if;
  end loop;
end;
$$;

create or replace function curation_private.resolve_commander_ref(entity_ref text)
returns bigint
language plpgsql
stable
set search_path = ''
as $$
declare
  namespace text;
  identifier text;
  commander_id bigint;
begin
  namespace := split_part(entity_ref, ':', 1);
  identifier := substring(entity_ref from position(':' in entity_ref) + 1);

  if namespace = 'wikidata' then
    select commander.id into commander_id
    from public.commanders commander
    where commander.wikidata_qid = identifier;
  elsif namespace = 'war-atlas' then
    select commander.id into commander_id
    from public.commanders commander
    where commander.slug = lower(replace(identifier, '_', '-'));
  elsif namespace = 'canonical' and identifier ~ '^[1-9][0-9]*$' then
    select commander.id into commander_id
    from public.commanders commander
    where commander.id = identifier::bigint;
  else
    raise exception 'unsupported commander reference: %', entity_ref;
  end if;

  if commander_id is null then
    raise exception 'commander reference does not resolve: %', entity_ref;
  end if;
  return commander_id;
end;
$$;

alter function public.publish_curation_decision(bigint, text, bigint, bigint, text)
  set schema curation_private;

create function public.publish_curation_decision(
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
  commander_preparation jsonb;
  created_event_id bigint;
  created_job_id bigint;
begin
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

alter function public.publish_owner_curation_decision(bigint, text, jsonb, text)
  set schema curation_private;

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
  payload_commanders jsonb;
  case_status text;
  commander_preparation jsonb;
  publication_result public.curation_publication_result;
begin
  select curation_case.payload->'commanders', curation_case.status
  into payload_commanders, case_status
  from public.curation_cases curation_case
  where curation_case.id = p_case_id;
  if case_status <> 'published'
    and p_requested_action = 'approve_corrected'
    and p_mutation->>'action' = 'approve_battle'
    and curation_private.is_strict_canonical_mutation(p_mutation, 'approve_battle')
    and jsonb_typeof(payload_commanders) = 'array' then
    if jsonb_array_length(p_mutation->'commanderRefs') >= 2
      and jsonb_array_length(p_mutation->'commanderRefs')
        = jsonb_array_length(payload_commanders) then
      commander_preparation := curation_private.prepare_war_atlas_battle_commanders(
        p_mutation->'commanderRefs',
        payload_commanders
      );
    end if;
  end if;

  select * into publication_result
  from curation_private.publish_owner_curation_decision(
    p_case_id,
    p_requested_action,
    p_mutation,
    p_reason
  );

  perform curation_private.attach_battle_commander_audit(
    publication_result.event_id,
    commander_preparation
  );
  return publication_result;
end;
$$;

revoke all on function curation_private.normalized_war_atlas_commander_slug(text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function curation_private.prepare_war_atlas_battle_commanders(jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function curation_private.attach_battle_commander_audit(bigint, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function curation_private.restore_engagement_state(jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function curation_private.restore_engagement_state_base(jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function curation_private.publish_curation_decision(bigint, text, bigint, bigint, text)
  from public, anon, authenticated, service_role;
revoke all on function curation_private.publish_owner_curation_decision(bigint, text, jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function public.publish_curation_decision(bigint, text, bigint, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.publish_curation_decision(bigint, text, bigint, bigint, text)
  to service_role;
revoke all on function public.publish_owner_curation_decision(bigint, text, jsonb, text)
  from public, anon, authenticated, service_role;
