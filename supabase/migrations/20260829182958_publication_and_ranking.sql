create schema if not exists curation_private;
revoke all on schema curation_private from public, anon, authenticated, service_role;

create type public.curation_publication_result as (
  event_id bigint,
  ranking_job_id bigint
);

alter table public.editorial_events
  add column data_revision text,
  add column model_versions jsonb not null default '{}'::jsonb,
  add column prompt_versions jsonb not null default '{}'::jsonb,
  add column proposer_review_id bigint references public.ai_reviews(id) on delete restrict,
  add column reviewer_review_id bigint references public.ai_reviews(id) on delete restrict,
  add column reverts_event_id bigint references public.editorial_events(id) on delete restrict;

create index ai_reviews_case_role_created_idx
  on public.ai_reviews (case_id, review_role, created_at desc, id desc);
create index editorial_events_case_id_idx
  on public.editorial_events (case_id, id desc);

drop function public.read_curation_reviews(bigint, text);
create function public.read_curation_reviews(
  case_id bigint,
  worker_id text
) returns table (
  review_id bigint,
  review_role text,
  model text,
  prompt_version text,
  evidence jsonb,
  decision jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_case public.curation_cases;
begin
  select c.* into locked_case
  from public.curation_cases c
  where c.id = read_curation_reviews.case_id
  for update;

  if not found
    or locked_case.status is distinct from 'leased'
    or locked_case.lease_owner is distinct from worker_id
    or locked_case.lease_expires_at is null
    or locked_case.lease_expires_at <= clock_timestamp() then
    raise exception 'worker is not the active lease owner';
  end if;

  return query
  select r.id, r.review_role, r.model, r.prompt_version, r.evidence, r.decision
  from public.ai_reviews r
  where r.case_id = read_curation_reviews.case_id
  order by r.created_at, r.id;
end;
$$;
revoke all on function public.read_curation_reviews(bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.read_curation_reviews(bigint, text) to service_role;

create unique index editorial_events_reverts_event_id_uidx
  on public.editorial_events (reverts_event_id)
  where reverts_event_id is not null;

alter table public.ranking_jobs
  add column editorial_event_id bigint references public.editorial_events(id) on delete restrict;

create unique index ranking_jobs_editorial_event_id_uidx
  on public.ranking_jobs (editorial_event_id)
  where editorial_event_id is not null;

create table public.commander_identity_links (
  id bigint generated always as identity primary key,
  source_commander_id bigint not null references public.commanders(id) on delete restrict,
  target_commander_id bigint not null references public.commanders(id) on delete restrict,
  source_ref text not null check (length(btrim(source_ref)) > 0),
  target_ref text not null check (length(btrim(target_ref)) > 0),
  link_state text not null check (link_state in ('linked', 'separated')),
  editorial_event_id bigint not null references public.editorial_events(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (source_commander_id <> target_commander_id)
);

create index commander_identity_links_pair_idx
  on public.commander_identity_links (source_commander_id, target_commander_id, id desc);
create index commander_identity_links_target_id_idx
  on public.commander_identity_links (target_commander_id);
create index commander_identity_links_event_id_idx
  on public.commander_identity_links (editorial_event_id);

alter table public.commander_identity_links enable row level security;
revoke all privileges on table public.commander_identity_links
  from anon, authenticated, service_role;
revoke all privileges on sequence public.commander_identity_links_id_seq
  from anon, authenticated, service_role;
grant select on table public.commander_identity_links to authenticated;

create policy commander_identity_links_owner_read
  on public.commander_identity_links for select to authenticated
  using (exists (
    select 1
    from public.curator_memberships m
    where m.user_id = (select auth.uid())
      and m.role = 'owner'
  ));

create function curation_private.reject_identity_history_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'commander identity history is append-only';
end;
$$;

create trigger commander_identity_links_append_only
before update or delete on public.commander_identity_links
for each row execute function curation_private.reject_identity_history_mutation();

create function curation_private.resolve_commander_ref(entity_ref text)
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
    select c.id into commander_id
    from public.commanders c
    where c.wikidata_qid = identifier;
  elsif namespace = 'war-atlas' then
    select c.id into commander_id
    from public.commanders c
    where c.slug = identifier;
  elsif namespace = 'canonical' and identifier ~ '^[1-9][0-9]*$' then
    select c.id into commander_id
    from public.commanders c
    where c.id = identifier::bigint;
  else
    raise exception 'unsupported commander reference: %', entity_ref;
  end if;

  if commander_id is null then
    raise exception 'commander reference does not resolve: %', entity_ref;
  end if;
  return commander_id;
end;
$$;

create function curation_private.is_strict_entity_ref(
  candidate jsonb,
  expected_type text
) returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(candidate) = 'object'
    and candidate ?& array['type', 'id']
    and candidate - array['type', 'id'] = '{}'::jsonb
    and candidate->>'type' = expected_type
    and candidate->>'id' ~ '^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9._-]*$';
$$;

create function curation_private.is_strict_evidence(candidate jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  item jsonb;
begin
  if jsonb_typeof(candidate) <> 'array' or jsonb_array_length(candidate) = 0 then
    return false;
  end if;
  for item in select value from jsonb_array_elements(candidate)
  loop
    if jsonb_typeof(item) <> 'object'
      or not (item ? 'citation')
      or item - array['citation', 'url', 'locator'] <> '{}'::jsonb
      or jsonb_typeof(item->'citation') <> 'string'
      or nullif(btrim(item->>'citation'), '') is null
      or (item ? 'url' and (
        jsonb_typeof(item->'url') <> 'string'
        or nullif(btrim(item->>'url'), '') is null
      ))
      or (item ? 'locator' and (
        jsonb_typeof(item->'locator') <> 'string'
        or nullif(btrim(item->>'locator'), '') is null
      )) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create function curation_private.is_strict_canonical_mutation(
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
      or candidate - array['action', 'battle', 'commanderRefs'] <> '{}'::jsonb
      or jsonb_typeof(candidate->'battle') <> 'object'
      or jsonb_typeof(candidate->'commanderRefs') <> 'array'
      or jsonb_array_length(candidate->'commanderRefs') = 0 then
      return false;
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

create function curation_private.is_strict_publication_decision(
  candidate jsonb,
  stored_evidence jsonb,
  expected_prompt text,
  expected_revision text,
  expected_entity_type text
) returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  action_name text;
begin
  if jsonb_typeof(candidate) <> 'object'
    or not (candidate ?& array[
      'action', 'evidence', 'reason', 'canonicalMutation', 'dataRevision', 'promptVersion'
    ])
    or candidate - array[
      'action', 'evidence', 'reason', 'canonicalMutation', 'dataRevision',
      'promptVersion', 'confidence'
    ] <> '{}'::jsonb
    or candidate->>'dataRevision' is distinct from expected_revision
    or candidate->>'promptVersion' is distinct from expected_prompt
    or jsonb_typeof(candidate->'reason') <> 'string'
    or nullif(btrim(candidate->>'reason'), '') is null
    or candidate->'evidence' is distinct from stored_evidence
    or not curation_private.is_strict_evidence(candidate->'evidence') then
    return false;
  end if;
  if candidate ? 'confidence' and (
    jsonb_typeof(candidate->'confidence') <> 'number'
    or (candidate->>'confidence')::numeric not between 0 and 1
  ) then
    return false;
  end if;
  action_name := candidate->>'action';
  if (action_name = 'approve_battle'
      and expected_entity_type is distinct from 'battle')
    or (action_name in ('merge_commanders', 'separate_commanders')
      and expected_entity_type is distinct from 'commander')
    or action_name not in ('approve_battle', 'merge_commanders', 'separate_commanders') then
    return false;
  end if;
  return curation_private.is_strict_canonical_mutation(
    candidate->'canonicalMutation',
    action_name
  );
end;
$$;

create function curation_private.affected_engagement_claim_ids(engagement_slug text)
returns table (claim_id bigint)
language sql
stable
set search_path = ''
as $$
  select ec.claim_id
  from public.engagement_claims ec
  join public.engagements e on e.id = ec.engagement_id
  where e.slug = $1
  union
  select pc.claim_id
  from public.participation_claims pc
  join public.participations p on p.id = pc.participation_id
  join public.engagement_sides s on s.id = p.engagement_side_id
  join public.engagements e on e.id = s.engagement_id
  where e.slug = $1
  union
  select ric.claim_id
  from public.result_interpretation_claims ric
  join public.result_interpretations ri on ri.id = ric.result_interpretation_id
  join public.engagements e on e.id = ri.engagement_id
  where e.slug = $1;
$$;

create function curation_private.lock_evidence_sources(evidence_source_slugs text[])
returns text[]
language plpgsql
set search_path = ''
as $$
declare
  source_slug text;
  locked_slugs text[] := '{}'::text[];
begin
  for source_slug in
    select distinct btrim(value)
    from unnest(coalesce(evidence_source_slugs, '{}'::text[])) value
    where nullif(btrim(value), '') is not null
    order by btrim(value)
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('bellumetrics:source:' || source_slug, 0)
    );
    locked_slugs := array_append(locked_slugs, source_slug);
  end loop;
  return locked_slugs;
end;
$$;

create function curation_private.lock_engagement_graph(
  engagement_slug text,
  evidence_source_slugs text[]
) returns void
language plpgsql
set search_path = ''
as $$
begin
  if engagement_slug is null or btrim(engagement_slug) = '' then
    raise exception 'engagement slug must not be empty';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('bellumetrics:engagement:' || engagement_slug, 0)
  );
  perform e.id from public.engagements e
    where e.slug = engagement_slug order by e.id for update;
  perform s.id from public.engagement_sides s
    join public.engagements e on e.id = s.engagement_id
    where e.slug = engagement_slug order by s.id for update of s;
  perform p.id from public.participations p
    join public.engagement_sides s on s.id = p.engagement_side_id
    join public.engagements e on e.id = s.engagement_id
    where e.slug = engagement_slug order by p.id for update of p;
  perform ri.id from public.result_interpretations ri
    join public.engagements e on e.id = ri.engagement_id
    where e.slug = engagement_slug order by ri.id for update of ri;
  perform c.id from public.claims c
    where c.id in (
      select affected.claim_id
      from curation_private.affected_engagement_claim_ids(engagement_slug) affected
    ) order by c.id for update;
  perform src.id from public.sources src
    where src.external_slug = any(coalesce(evidence_source_slugs, '{}'::text[]))
      or src.id in (
        select cs.source_id from public.claim_sources cs
        where cs.claim_id in (
          select affected.claim_id
          from curation_private.affected_engagement_claim_ids(engagement_slug) affected
        )
      ) order by src.id for update;
  perform ec.engagement_id from public.engagement_claims ec
    where ec.claim_id in (
      select affected.claim_id
      from curation_private.affected_engagement_claim_ids(engagement_slug) affected
    ) order by ec.engagement_id, ec.claim_id for update of ec;
  perform pc.participation_id from public.participation_claims pc
    where pc.claim_id in (
      select affected.claim_id
      from curation_private.affected_engagement_claim_ids(engagement_slug) affected
    ) order by pc.participation_id, pc.claim_id for update of pc;
  perform ric.result_interpretation_id from public.result_interpretation_claims ric
    where ric.claim_id in (
      select affected.claim_id
      from curation_private.affected_engagement_claim_ids(engagement_slug) affected
    ) order by ric.result_interpretation_id, ric.claim_id for update of ric;
  perform cc.commander_id from public.commander_claims cc
    where cc.claim_id in (
      select affected.claim_id
      from curation_private.affected_engagement_claim_ids(engagement_slug) affected
    ) order by cc.commander_id, cc.claim_id for update of cc;
  perform cs.claim_id from public.claim_sources cs
    where cs.claim_id in (
      select affected.claim_id
      from curation_private.affected_engagement_claim_ids(engagement_slug) affected
    ) order by cs.claim_id, cs.source_id for update of cs;
end;
$$;

create function curation_private.capture_engagement_state(
  engagement_slug text,
  evidence_source_slugs text[]
) returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'kind', 'engagement',
    'metadata', jsonb_build_object(
      'engagement_slug', engagement_slug,
      'source_external_slugs', to_jsonb(coalesce(evidence_source_slugs, '{}'::text[]))
    ),
    'engagements', coalesce((
      select jsonb_agg(to_jsonb(e) order by e.id)
      from public.engagements e
      where e.slug = engagement_slug
    ), '[]'::jsonb),
    'engagement_sides', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.id)
      from public.engagement_sides s
      join public.engagements e on e.id = s.engagement_id
      where e.slug = engagement_slug
    ), '[]'::jsonb),
    'participations', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.id)
      from public.participations p
      join public.engagement_sides s on s.id = p.engagement_side_id
      join public.engagements e on e.id = s.engagement_id
      where e.slug = engagement_slug
    ), '[]'::jsonb),
    'result_interpretations', coalesce((
      select jsonb_agg(to_jsonb(ri) order by ri.id)
      from public.result_interpretations ri
      join public.engagements e on e.id = ri.engagement_id
      where e.slug = engagement_slug
    ), '[]'::jsonb),
    'participation_claims', coalesce((
      select jsonb_agg(to_jsonb(pc) order by pc.participation_id, pc.claim_id)
      from public.participation_claims pc
      where pc.claim_id in (
        select affected.claim_id
        from curation_private.affected_engagement_claim_ids(engagement_slug) affected
      )
    ), '[]'::jsonb),
    'engagement_claims', coalesce((
      select jsonb_agg(to_jsonb(ec) order by ec.engagement_id, ec.claim_id)
      from public.engagement_claims ec
      where ec.claim_id in (
        select affected.claim_id
        from curation_private.affected_engagement_claim_ids(engagement_slug) affected
      )
    ), '[]'::jsonb),
    'result_interpretation_claims', coalesce((
      select jsonb_agg(to_jsonb(ric) order by ric.result_interpretation_id, ric.claim_id)
      from public.result_interpretation_claims ric
      where ric.claim_id in (
        select affected.claim_id
        from curation_private.affected_engagement_claim_ids(engagement_slug) affected
      )
    ), '[]'::jsonb),
    'claims', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.id)
      from public.claims c
      where c.id in (
        select affected.claim_id
        from curation_private.affected_engagement_claim_ids(engagement_slug) affected
      )
    ), '[]'::jsonb),
    'commander_claims', coalesce((
      select jsonb_agg(to_jsonb(cc) order by cc.commander_id, cc.claim_id)
      from public.commander_claims cc
      where cc.claim_id in (
        select affected.claim_id
        from curation_private.affected_engagement_claim_ids(engagement_slug) affected
      )
    ), '[]'::jsonb),
    'claim_sources', coalesce((
      select jsonb_agg(to_jsonb(cs) order by cs.claim_id, cs.source_id)
      from public.claim_sources cs
      where cs.claim_id in (
        select affected.claim_id
        from curation_private.affected_engagement_claim_ids(engagement_slug) affected
      )
    ), '[]'::jsonb),
    'sources', coalesce((
      select jsonb_agg(to_jsonb(src) order by src.id)
      from public.sources src
      where src.external_slug = any(coalesce(evidence_source_slugs, '{}'::text[]))
        or src.id in (
          select cs.source_id
          from public.claim_sources cs
          where cs.claim_id in (
            select affected.claim_id
            from curation_private.affected_engagement_claim_ids(engagement_slug) affected
          )
        )
    ), '[]'::jsonb)
  );
$$;

create function curation_private.capture_identity_state(
  source_commander_id bigint,
  target_commander_id bigint,
  source_ref text,
  target_ref text
) returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'kind', 'identity',
    'metadata', jsonb_build_object(
      'source_commander_id', source_commander_id,
      'target_commander_id', target_commander_id,
      'source_ref', source_ref,
      'target_ref', target_ref
    ),
    'commanders', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.id)
      from public.commanders c
      where c.id in (source_commander_id, target_commander_id)
    ), '[]'::jsonb),
    'participations', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.id)
      from public.participations p
      where p.commander_id in (source_commander_id, target_commander_id)
    ), '[]'::jsonb),
    'participation_claims', coalesce((
      select jsonb_agg(to_jsonb(pc) order by pc.participation_id, pc.claim_id)
      from public.participation_claims pc
      join public.participations p on p.id = pc.participation_id
      where p.commander_id in (source_commander_id, target_commander_id)
    ), '[]'::jsonb),
    'commander_claims', coalesce((
      select jsonb_agg(to_jsonb(cc) order by cc.commander_id, cc.claim_id)
      from public.commander_claims cc
      where cc.commander_id in (source_commander_id, target_commander_id)
    ), '[]'::jsonb)
  );
$$;

create function curation_private.restore_identity_state(
  before_state jsonb,
  expected_state jsonb
) returns void
language plpgsql
set search_path = ''
as $$
declare
  source_id bigint := (before_state->'metadata'->>'source_commander_id')::bigint;
  target_id bigint := (before_state->'metadata'->>'target_commander_id')::bigint;
  current_state jsonb;
  commander_row record;
  participation_row record;
  participation_claim_row record;
  commander_claim_row record;
begin
  perform 1
  from public.commanders c
  where c.id in (source_id, target_id)
  order by c.id
  for update;
  perform 1
  from public.participations p
  where p.commander_id in (source_id, target_id)
  order by p.id
  for update;

  current_state := curation_private.capture_identity_state(
    source_id,
    target_id,
    before_state->'metadata'->>'source_ref',
    before_state->'metadata'->>'target_ref'
  );
  if current_state is distinct from expected_state then
    raise exception 'canonical identity state changed after the editorial event';
  end if;

  delete from public.participation_claims pc
  where pc.participation_id in (
    select p.id
    from public.participations p
    where p.commander_id in (source_id, target_id)
  );
  delete from public.commander_claims cc
  where cc.commander_id in (source_id, target_id);
  delete from public.participations p
  where p.commander_id in (source_id, target_id);

  for commander_row in
    select *
    from jsonb_to_recordset(before_state->'commanders') as row_data(
      id bigint,
      slug text,
      display_name text,
      wikidata_qid text,
      birth_year integer,
      death_year integer,
      historicity_status text,
      publication_status text,
      created_at timestamptz,
      updated_at timestamptz
    )
  loop
    update public.commanders c
    set slug = commander_row.slug,
        display_name = commander_row.display_name,
        wikidata_qid = commander_row.wikidata_qid,
        birth_year = commander_row.birth_year,
        death_year = commander_row.death_year,
        historicity_status = commander_row.historicity_status,
        publication_status = commander_row.publication_status,
        created_at = commander_row.created_at,
        updated_at = commander_row.updated_at
    where c.id = commander_row.id;
  end loop;

  for participation_row in
    select *
    from jsonb_to_recordset(before_state->'participations') as row_data(
      id bigint,
      engagement_side_id bigint,
      commander_id bigint,
      role text,
      command_level text,
      responsibility numeric,
      autonomy numeric,
      joined_year integer,
      left_year integer,
      presence_status text
    )
  loop
    insert into public.participations (
      id, engagement_side_id, commander_id, role, command_level,
      responsibility, autonomy, joined_year, left_year, presence_status
    ) overriding system value values (
      participation_row.id,
      participation_row.engagement_side_id,
      participation_row.commander_id,
      participation_row.role,
      participation_row.command_level,
      participation_row.responsibility,
      participation_row.autonomy,
      participation_row.joined_year,
      participation_row.left_year,
      participation_row.presence_status
    );
  end loop;

  for participation_claim_row in
    select *
    from jsonb_to_recordset(before_state->'participation_claims') as row_data(
      participation_id bigint,
      claim_id bigint
    )
  loop
    insert into public.participation_claims (participation_id, claim_id)
    values (participation_claim_row.participation_id, participation_claim_row.claim_id);
  end loop;

  for commander_claim_row in
    select *
    from jsonb_to_recordset(before_state->'commander_claims') as row_data(
      commander_id bigint,
      claim_id bigint
    )
  loop
    insert into public.commander_claims (commander_id, claim_id)
    values (commander_claim_row.commander_id, commander_claim_row.claim_id);
  end loop;
end;
$$;

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
  current_state jsonb;
  source_row record;
  engagement_row record;
  side_row record;
  participation_row record;
  participation_claim_row record;
  claim_row record;
  claim_source_row record;
  engagement_claim_row record;
begin
  select coalesce(array_agg(value), '{}'::text[]) into source_slugs
  from jsonb_array_elements_text(before_state->'metadata'->'source_external_slugs') value;

  perform curation_private.lock_engagement_graph(engagement_slug, source_slugs);

  current_state := curation_private.capture_engagement_state(engagement_slug, source_slugs);
  if current_state is distinct from expected_state then
    raise exception 'canonical engagement state changed after the editorial event';
  end if;

  delete from public.participation_claims pc
  where pc.participation_id in (
    select (item->>'id')::bigint
    from jsonb_array_elements(expected_state->'participations') item
    where not exists (
      select 1
      from jsonb_array_elements(before_state->'participations') original
      where original->>'id' = item->>'id'
    )
  );
  delete from public.participations p
  where p.id in (
    select (item->>'id')::bigint
    from jsonb_array_elements(expected_state->'participations') item
    where not exists (
      select 1
      from jsonb_array_elements(before_state->'participations') original
      where original->>'id' = item->>'id'
    )
  );
  delete from public.engagement_sides s
  where s.id in (
    select (item->>'id')::bigint
    from jsonb_array_elements(expected_state->'engagement_sides') item
    where not exists (
      select 1
      from jsonb_array_elements(before_state->'engagement_sides') original
      where original->>'id' = item->>'id'
    )
  );
  delete from public.engagement_claims ec
  where ec.claim_id in (
    select (item->>'id')::bigint
    from jsonb_array_elements(expected_state->'claims') item
    where not exists (
      select 1
      from jsonb_array_elements(before_state->'claims') original
      where original->>'id' = item->>'id'
    )
  );
  delete from public.result_interpretation_claims ric
  where ric.claim_id in (
    select (item->>'id')::bigint
    from jsonb_array_elements(expected_state->'claims') item
    where not exists (
      select 1
      from jsonb_array_elements(before_state->'claims') original
      where original->>'id' = item->>'id'
    )
  );
  delete from public.commander_claims cc
  where cc.claim_id in (
    select (item->>'id')::bigint
    from jsonb_array_elements(expected_state->'claims') item
    where not exists (
      select 1
      from jsonb_array_elements(before_state->'claims') original
      where original->>'id' = item->>'id'
    )
  );
  delete from public.claim_sources cs
  where cs.claim_id in (
    select (item->>'id')::bigint
    from jsonb_array_elements(expected_state->'claims') item
    where not exists (
      select 1
      from jsonb_array_elements(before_state->'claims') original
      where original->>'id' = item->>'id'
    )
  );
  delete from public.claims c
  where c.id in (
    select (item->>'id')::bigint
    from jsonb_array_elements(expected_state->'claims') item
    where not exists (
      select 1
      from jsonb_array_elements(before_state->'claims') original
      where original->>'id' = item->>'id'
    )
  );
  delete from public.sources s
  where s.id in (
    select (item->>'id')::bigint
    from jsonb_array_elements(expected_state->'sources') item
    where not exists (
      select 1
      from jsonb_array_elements(before_state->'sources') original
      where original->>'id' = item->>'id'
    )
  );

  if jsonb_array_length(before_state->'engagements') = 0 then
    delete from public.engagements e where e.slug = engagement_slug;
    return;
  end if;

  for source_row in
    select *
    from jsonb_to_recordset(before_state->'sources') as row_data(
      id bigint,
      source_type text,
      author_or_institution text,
      title text,
      publication text,
      publication_year integer,
      url text,
      locator text,
      accessed_on date,
      external_slug text,
      publication_status text,
      created_at timestamptz,
      updated_at timestamptz
    )
  loop
    insert into public.sources (
      id, source_type, author_or_institution, title, publication,
      publication_year, url, locator, accessed_on, external_slug,
      publication_status, created_at, updated_at
    ) overriding system value values (
      source_row.id, source_row.source_type, source_row.author_or_institution,
      source_row.title, source_row.publication, source_row.publication_year,
      source_row.url, source_row.locator, source_row.accessed_on,
      source_row.external_slug, source_row.publication_status,
      source_row.created_at, source_row.updated_at
    )
    on conflict (id) do update set
      source_type = excluded.source_type,
      author_or_institution = excluded.author_or_institution,
      title = excluded.title,
      publication = excluded.publication,
      publication_year = excluded.publication_year,
      url = excluded.url,
      locator = excluded.locator,
      accessed_on = excluded.accessed_on,
      external_slug = excluded.external_slug,
      publication_status = excluded.publication_status,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at;
  end loop;

  for engagement_row in
    select *
    from jsonb_to_recordset(before_state->'engagements') as row_data(
      id bigint,
      campaign_id bigint,
      slug text,
      title text,
      wikidata_qid text,
      start_year integer,
      end_year integer,
      date_display text,
      date_precision text,
      elo_eligible boolean,
      publication_status text,
      created_at timestamptz,
      updated_at timestamptz
    )
  loop
    insert into public.engagements (
      id, campaign_id, slug, title, wikidata_qid, start_year, end_year,
      date_display, date_precision, elo_eligible, publication_status,
      created_at, updated_at
    ) overriding system value values (
      engagement_row.id, engagement_row.campaign_id, engagement_row.slug,
      engagement_row.title, engagement_row.wikidata_qid,
      engagement_row.start_year, engagement_row.end_year,
      engagement_row.date_display, engagement_row.date_precision,
      engagement_row.elo_eligible, engagement_row.publication_status,
      engagement_row.created_at, engagement_row.updated_at
    )
    on conflict (id) do update set
      campaign_id = excluded.campaign_id,
      slug = excluded.slug,
      title = excluded.title,
      wikidata_qid = excluded.wikidata_qid,
      start_year = excluded.start_year,
      end_year = excluded.end_year,
      date_display = excluded.date_display,
      date_precision = excluded.date_precision,
      elo_eligible = excluded.elo_eligible,
      publication_status = excluded.publication_status,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at;
  end loop;

  for side_row in
    select *
    from jsonb_to_recordset(before_state->'engagement_sides') as row_data(
      id bigint,
      engagement_id bigint,
      position smallint,
      label text,
      outcome text
    )
  loop
    insert into public.engagement_sides (id, engagement_id, position, label, outcome)
    overriding system value values (
      side_row.id, side_row.engagement_id, side_row.position,
      side_row.label, side_row.outcome
    )
    on conflict (id) do update set
      engagement_id = excluded.engagement_id,
      position = excluded.position,
      label = excluded.label,
      outcome = excluded.outcome;
  end loop;

  for participation_row in
    select *
    from jsonb_to_recordset(before_state->'participations') as row_data(
      id bigint,
      engagement_side_id bigint,
      commander_id bigint,
      role text,
      command_level text,
      responsibility numeric,
      autonomy numeric,
      joined_year integer,
      left_year integer,
      presence_status text
    )
  loop
    insert into public.participations (
      id, engagement_side_id, commander_id, role, command_level,
      responsibility, autonomy, joined_year, left_year, presence_status
    ) overriding system value values (
      participation_row.id, participation_row.engagement_side_id,
      participation_row.commander_id, participation_row.role,
      participation_row.command_level, participation_row.responsibility,
      participation_row.autonomy, participation_row.joined_year,
      participation_row.left_year, participation_row.presence_status
    )
    on conflict (id) do update set
      engagement_side_id = excluded.engagement_side_id,
      commander_id = excluded.commander_id,
      role = excluded.role,
      command_level = excluded.command_level,
      responsibility = excluded.responsibility,
      autonomy = excluded.autonomy,
      joined_year = excluded.joined_year,
      left_year = excluded.left_year,
      presence_status = excluded.presence_status;
  end loop;

  for claim_row in
    select *
    from jsonb_to_recordset(before_state->'claims') as row_data(
      id bigint,
      claim_type text,
      statement text,
      confidence numeric,
      publication_status text,
      created_at timestamptz,
      updated_at timestamptz
    )
  loop
    insert into public.claims (
      id, claim_type, statement, confidence, publication_status, created_at, updated_at
    ) overriding system value values (
      claim_row.id, claim_row.claim_type, claim_row.statement,
      claim_row.confidence, claim_row.publication_status,
      claim_row.created_at, claim_row.updated_at
    )
    on conflict (id) do update set
      claim_type = excluded.claim_type,
      statement = excluded.statement,
      confidence = excluded.confidence,
      publication_status = excluded.publication_status,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at;
  end loop;

  for participation_claim_row in
    select * from jsonb_to_recordset(before_state->'participation_claims')
      as row_data(participation_id bigint, claim_id bigint)
  loop
    insert into public.participation_claims (participation_id, claim_id)
    values (participation_claim_row.participation_id, participation_claim_row.claim_id)
    on conflict do nothing;
  end loop;
  for engagement_claim_row in
    select * from jsonb_to_recordset(before_state->'engagement_claims')
      as row_data(engagement_id bigint, claim_id bigint)
  loop
    insert into public.engagement_claims (engagement_id, claim_id)
    values (engagement_claim_row.engagement_id, engagement_claim_row.claim_id)
    on conflict do nothing;
  end loop;
  for claim_source_row in
    select * from jsonb_to_recordset(before_state->'claim_sources')
      as row_data(claim_id bigint, source_id bigint, relation text, locator text)
  loop
    insert into public.claim_sources (claim_id, source_id, relation, locator)
    values (
      claim_source_row.claim_id, claim_source_row.source_id,
      claim_source_row.relation, claim_source_row.locator
    )
    on conflict (claim_id, source_id) do update set
      relation = excluded.relation,
      locator = excluded.locator;
  end loop;
end;
$$;

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
      or jsonb_typeof(locked_case.payload->'commanders') <> 'array' then
      raise exception 'approved battle requires ordered commander references and payload commanders';
    end if;
    commander_count := jsonb_array_length(mutation->'commanderRefs');
    if commander_count < 2
      or commander_count <> jsonb_array_length(locked_case.payload->'commanders') then
      raise exception 'commander references must align with the staged battle payload';
    end if;
    first_outcome := coalesce(mutation->'battle'->>'outcome', 'unknown');

    for commander_index in 0..commander_count - 1
    loop
      commander_ref := mutation->'commanderRefs'->commander_index;
      payload_commander := locked_case.payload->'commanders'->commander_index;
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

create function public.revert_editorial_event(
  event_id bigint,
  curator_user_id uuid,
  reason text
) returns public.curation_publication_result
language plpgsql
security definer
set search_path = ''
as $$
declare
  original_event public.editorial_events;
  compensating_event_id bigint;
  compensating_job_id bigint;
  source_id bigint;
  target_id bigint;
  source_ref text;
  target_ref text;
begin
  if curator_user_id is null
    or (select auth.uid()) is distinct from curator_user_id
    or not exists (
      select 1
      from public.curator_memberships m
      where m.user_id = (select auth.uid())
        and m.role = 'owner'
    ) then
    raise exception 'reversal requires verified owner membership';
  end if;
  if reason is null or btrim(reason) = '' then
    raise exception 'reversal reason must not be empty';
  end if;

  select e.* into original_event
  from public.editorial_events e
  where e.id = revert_editorial_event.event_id
  for update;
  if not found or original_event.reverts_event_id is not null then
    raise exception 'original editorial event is not reversible';
  end if;

  select e.id, j.id into compensating_event_id, compensating_job_id
  from public.editorial_events e
  join public.ranking_jobs j on j.editorial_event_id = e.id
  where e.reverts_event_id = original_event.id;
  if compensating_event_id is not null then
    return row(compensating_event_id, compensating_job_id)::public.curation_publication_result;
  end if;

  perform 1
  from public.curation_cases c
  where c.id = original_event.case_id
  for update;

  if original_event.action = 'approve_battle' then
    perform curation_private.restore_engagement_state(
      original_event.before_state,
      original_event.after_state
    );
  elsif original_event.action in ('merge_commanders', 'separate_commanders') then
    source_id := (original_event.before_state->'metadata'->>'source_commander_id')::bigint;
    target_id := (original_event.before_state->'metadata'->>'target_commander_id')::bigint;
    source_ref := original_event.before_state->'metadata'->>'source_ref';
    target_ref := original_event.before_state->'metadata'->>'target_ref';
    perform curation_private.restore_identity_state(
      original_event.before_state,
      original_event.after_state
    );
  else
    raise exception 'editorial event action is not reversible: %', original_event.action;
  end if;

  insert into public.editorial_events (
    case_id, actor_type, actor_id, action, before_state, after_state,
    reason, data_revision, model_versions, prompt_versions, reverts_event_id
  ) values (
    original_event.case_id,
    'human',
    curator_user_id::text,
    'revert_' || original_event.action,
    original_event.after_state,
    original_event.before_state,
    reason,
    original_event.data_revision,
    '{}'::jsonb,
    '{}'::jsonb,
    original_event.id
  ) returning id into compensating_event_id;

  if original_event.action in ('merge_commanders', 'separate_commanders') then
    insert into public.commander_identity_links (
      source_commander_id, target_commander_id, source_ref, target_ref,
      link_state, editorial_event_id
    ) values (
      source_id,
      target_id,
      source_ref,
      target_ref,
      case when original_event.action = 'merge_commanders' then 'separated' else 'linked' end,
      compensating_event_id
    );
  end if;

  insert into public.ranking_jobs (
    data_revision, algorithm_version, status, editorial_event_id
  ) values (
    original_event.data_revision || ':event:' || compensating_event_id::text,
    'elo-v1',
    'pending',
    compensating_event_id
  )
  on conflict (editorial_event_id) where editorial_event_id is not null do update
    set editorial_event_id = excluded.editorial_event_id
  returning id into compensating_job_id;

  return row(compensating_event_id, compensating_job_id)::public.curation_publication_result;
end;
$$;

revoke all on function curation_private.reject_identity_history_mutation()
  from public, anon, authenticated, service_role;
revoke all on function curation_private.resolve_commander_ref(text)
  from public, anon, authenticated, service_role;
revoke all on function curation_private.is_strict_entity_ref(jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function curation_private.is_strict_evidence(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function curation_private.is_strict_canonical_mutation(jsonb, text)
  from public, anon, authenticated, service_role;
revoke all on function curation_private.is_strict_publication_decision(jsonb, jsonb, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function curation_private.affected_engagement_claim_ids(text)
  from public, anon, authenticated, service_role;
revoke all on function curation_private.lock_evidence_sources(text[])
  from public, anon, authenticated, service_role;
revoke all on function curation_private.lock_engagement_graph(text, text[])
  from public, anon, authenticated, service_role;
revoke all on function curation_private.capture_engagement_state(text, text[])
  from public, anon, authenticated, service_role;
revoke all on function curation_private.capture_identity_state(bigint, bigint, text, text)
  from public, anon, authenticated, service_role;
revoke all on function curation_private.restore_identity_state(jsonb, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function curation_private.restore_engagement_state(jsonb, jsonb)
  from public, anon, authenticated, service_role;

revoke all on function public.publish_curation_decision(bigint, text, bigint, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.publish_curation_decision(bigint, text, bigint, bigint, text)
  to service_role;

revoke all on function public.revert_editorial_event(bigint, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.revert_editorial_event(bigint, uuid, text)
  to authenticated;

create index ranking_jobs_lease_queue_idx
  on public.ranking_jobs (status, lease_expires_at, created_at, id)
  where status in ('pending', 'leased');

create function public.lease_ranking_job(
  worker_id text,
  lease_seconds integer
) returns public.ranking_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate_id bigint;
  leased_job public.ranking_jobs;
begin
  if worker_id is null or btrim(worker_id) = '' then
    raise exception 'worker_id must not be empty';
  end if;
  if lease_seconds is null or lease_seconds <= 0 then
    raise exception 'lease_seconds must be positive';
  end if;

  select job.id into candidate_id
  from public.ranking_jobs job
  where job.status = 'pending'
    or (
      job.status = 'leased'
      and job.lease_expires_at <= statement_timestamp()
    )
  order by job.created_at, job.id
  for update skip locked
  limit 1;

  if candidate_id is null then
    return null;
  end if;

  update public.ranking_jobs job
  set status = 'leased',
      lease_owner = worker_id,
      lease_expires_at = statement_timestamp() + make_interval(secs => lease_seconds)
  where job.id = candidate_id
  returning job.* into leased_job;

  return leased_job;
end;
$$;

create function public.heartbeat_ranking_job(
  job_id bigint,
  worker_id text,
  lease_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  checked_at timestamptz;
  locked_job public.ranking_jobs;
begin
  if worker_id is null or btrim(worker_id) = '' then
    raise exception 'worker_id must not be empty';
  end if;
  if lease_seconds is null or lease_seconds <= 0 then
    raise exception 'lease_seconds must be positive';
  end if;

  select job.* into locked_job
  from public.ranking_jobs job
  where job.id = heartbeat_ranking_job.job_id
  for update;
  if not found then return false; end if;

  checked_at := clock_timestamp();
  if locked_job.status is distinct from 'leased'
    or locked_job.lease_owner is distinct from worker_id
    or locked_job.lease_expires_at is null
    or locked_job.lease_expires_at <= checked_at then
    return false;
  end if;

  update public.ranking_jobs job
  set lease_expires_at = greatest(
        locked_job.lease_expires_at,
        checked_at + make_interval(secs => lease_seconds)
      )
  where job.id = heartbeat_ranking_job.job_id;
  return true;
end;
$$;

create function public.read_ranking_input(
  job_id bigint,
  worker_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  checked_at timestamptz;
  locked_job public.ranking_jobs;
  ranking_input jsonb;
begin
  select job.* into locked_job
  from public.ranking_jobs job
  where job.id = read_ranking_input.job_id
  for update;
  if not found then
    raise exception 'worker is not the active ranking lease owner';
  end if;

  checked_at := clock_timestamp();
  if locked_job.status is distinct from 'leased'
    or locked_job.lease_owner is distinct from worker_id
    or locked_job.lease_expires_at is null
    or locked_job.lease_expires_at <= checked_at then
    raise exception 'worker is not the active ranking lease owner';
  end if;

  select jsonb_build_object(
    'commanders', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', commander.id,
          'publication_status', commander.publication_status
        ) order by commander.id
      )
      from public.commanders commander
      where commander.publication_status = 'published'
    ), '[]'::jsonb),
    'engagements', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', engagement.id,
          'start_year', engagement.start_year,
          'elo_eligible', engagement.elo_eligible,
          'publication_status', engagement.publication_status
        ) order by engagement.start_year nulls last, engagement.id
      )
      from public.engagements engagement
      where engagement.publication_status = 'published'
        and engagement.elo_eligible
    ), '[]'::jsonb),
    'participations', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', participation.id,
          'engagement_id', engagement.id,
          'engagement_side_id', side.id,
          'commander_id', participation.commander_id,
          'outcome', side.outcome
        ) order by
          engagement.start_year nulls last,
          engagement.id,
          participation.id
      )
      from public.participations participation
      join public.engagement_sides side
        on side.id = participation.engagement_side_id
      join public.engagements engagement
        on engagement.id = side.engagement_id
      where engagement.publication_status = 'published'
        and engagement.elo_eligible
    ), '[]'::jsonb)
  ) into ranking_input;

  if locked_job.status is distinct from 'leased'
    or locked_job.lease_owner is distinct from worker_id
    or locked_job.lease_expires_at <= clock_timestamp() then
    raise exception 'worker is not the active ranking lease owner';
  end if;
  return ranking_input;
end;
$$;

create function public.complete_ranking_job(
  job_id bigint,
  worker_id text,
  input_digest text,
  results jsonb
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  checked_at timestamptz;
  locked_job public.ranking_jobs;
  snapshot_id bigint;
  stored_results jsonb;
begin
  if input_digest is null or input_digest !~ '^sha256:[0-9a-f]{64}$' then
    raise exception 'input_digest must be a sha256 digest';
  end if;
  if results is null or jsonb_typeof(results) <> 'object'
    or results->>'inputDigest' is distinct from input_digest then
    raise exception 'ranking results must contain the exact input digest';
  end if;

  select job.* into locked_job
  from public.ranking_jobs job
  where job.id = complete_ranking_job.job_id
  for update;
  if not found then
    raise exception 'ranking job does not exist';
  end if;

  if locked_job.status = 'completed' then
    select snapshot.id, snapshot.results into snapshot_id, stored_results
    from public.ranking_snapshots snapshot
    where snapshot.data_revision = locked_job.data_revision
      and snapshot.algorithm_version = locked_job.algorithm_version;
    if snapshot_id is null or stored_results is distinct from results then
      raise exception 'completed ranking job snapshot does not match';
    end if;
    return snapshot_id;
  end if;

  checked_at := clock_timestamp();
  if locked_job.status is distinct from 'leased'
    or locked_job.lease_owner is distinct from worker_id
    or locked_job.lease_expires_at is null
    or locked_job.lease_expires_at <= checked_at then
    raise exception 'worker is not the active ranking lease owner';
  end if;

  insert into public.ranking_snapshots (
    data_revision,
    algorithm_version,
    results
  ) values (
    locked_job.data_revision,
    locked_job.algorithm_version,
    results
  )
  on conflict (data_revision, algorithm_version) do nothing
  returning id into snapshot_id;

  if snapshot_id is null then
    select snapshot.id, snapshot.results into snapshot_id, stored_results
    from public.ranking_snapshots snapshot
    where snapshot.data_revision = locked_job.data_revision
      and snapshot.algorithm_version = locked_job.algorithm_version;
    if stored_results is distinct from results then
      raise exception 'ranking snapshot idempotency key contains different results';
    end if;
  end if;

  update public.ranking_jobs job
  set status = 'completed',
      lease_owner = null,
      lease_expires_at = null,
      last_error = null,
      completed_at = checked_at
  where job.id = complete_ranking_job.job_id;
  return snapshot_id;
end;
$$;

create function public.release_ranking_job(
  job_id bigint,
  worker_id text,
  error_text text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  checked_at timestamptz;
  locked_job public.ranking_jobs;
begin
  if worker_id is null or btrim(worker_id) = '' then
    raise exception 'worker_id must not be empty';
  end if;
  if error_text is null or btrim(error_text) = '' then
    raise exception 'error_text must not be empty';
  end if;

  select job.* into locked_job
  from public.ranking_jobs job
  where job.id = release_ranking_job.job_id
  for update;
  if not found then return false; end if;
  if locked_job.status = 'completed' then return true; end if;

  checked_at := clock_timestamp();
  if locked_job.status is distinct from 'leased'
    or locked_job.lease_owner is distinct from worker_id
    or locked_job.lease_expires_at is null
    or locked_job.lease_expires_at <= checked_at then
    return false;
  end if;

  update public.ranking_jobs job
  set status = case
        when job.attempt_count + 1 >= 3 then 'failed'
        else 'pending'
      end,
      lease_owner = null,
      lease_expires_at = null,
      attempt_count = job.attempt_count + 1,
      last_error = error_text,
      completed_at = null
  where job.id = release_ranking_job.job_id;
  return true;
end;
$$;

revoke all on function public.lease_ranking_job(text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.heartbeat_ranking_job(bigint, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.read_ranking_input(bigint, text)
  from public, anon, authenticated, service_role;
revoke all on function public.complete_ranking_job(bigint, text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.release_ranking_job(bigint, text, text)
  from public, anon, authenticated, service_role;

grant execute on function public.lease_ranking_job(text, integer) to service_role;
grant execute on function public.heartbeat_ranking_job(bigint, text, integer) to service_role;
grant execute on function public.read_ranking_input(bigint, text) to service_role;
grant execute on function public.complete_ranking_job(bigint, text, text, jsonb)
  to service_role;
grant execute on function public.release_ranking_job(bigint, text, text)
  to service_role;
