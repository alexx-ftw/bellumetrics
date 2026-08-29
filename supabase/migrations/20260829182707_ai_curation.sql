create table public.curator_memberships (
  user_id uuid primary key,
  role text not null,
  created_at timestamptz not null default now()
);

create table public.curation_cases (
  id bigint generated always as identity primary key,
  case_key text not null unique,
  entity_type text not null,
  source_revision text not null,
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'leased', 'awaiting_human', 'approved', 'rejected', 'published', 'failed')),
  priority integer not null default 0,
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ai_reviews (
  id bigint generated always as identity primary key,
  case_id bigint not null references public.curation_cases(id) on delete restrict,
  review_role text not null check (review_role in ('proposer', 'reviewer')),
  model text not null,
  prompt_version text not null,
  evidence jsonb not null,
  decision jsonb not null,
  created_at timestamptz not null default now()
);

create table public.editorial_events (
  id bigint generated always as identity primary key,
  case_id bigint not null references public.curation_cases(id) on delete restrict,
  actor_type text not null,
  actor_id text,
  action text not null,
  before_state jsonb,
  after_state jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create table public.ranking_jobs (
  id bigint generated always as identity primary key,
  data_revision text not null,
  algorithm_version text not null,
  status text not null default 'pending'
    check (status in ('pending', 'leased', 'completed', 'failed')),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.ranking_snapshots (
  id bigint generated always as identity primary key,
  data_revision text not null,
  algorithm_version text not null,
  results jsonb not null,
  created_at timestamptz not null default now(),
  unique (data_revision, algorithm_version)
);

alter table public.curator_memberships enable row level security;
alter table public.curation_cases enable row level security;
alter table public.ai_reviews enable row level security;
alter table public.editorial_events enable row level security;
alter table public.ranking_jobs enable row level security;
alter table public.ranking_snapshots enable row level security;

revoke all privileges on table public.curator_memberships, public.curation_cases,
  public.ai_reviews, public.editorial_events, public.ranking_jobs,
  public.ranking_snapshots from anon, authenticated, service_role;
revoke all privileges on sequence public.curation_cases_id_seq,
  public.ai_reviews_id_seq, public.editorial_events_id_seq,
  public.ranking_jobs_id_seq, public.ranking_snapshots_id_seq
  from anon, authenticated, service_role;

grant select on table public.curator_memberships, public.curation_cases,
  public.ai_reviews, public.editorial_events, public.ranking_jobs,
  public.ranking_snapshots to authenticated;

create policy curator_memberships_owner_read on public.curator_memberships
  for select to authenticated
  using (user_id = auth.uid() and role = 'owner');

create policy curation_cases_owner_read on public.curation_cases
  for select to authenticated
  using (exists (
    select 1 from public.curator_memberships m
    where m.user_id = auth.uid() and m.role = 'owner'
  ));

create policy ai_reviews_owner_read on public.ai_reviews
  for select to authenticated
  using (exists (
    select 1 from public.curator_memberships m
    where m.user_id = auth.uid() and m.role = 'owner'
  ));

create policy editorial_events_owner_read on public.editorial_events
  for select to authenticated
  using (exists (
    select 1 from public.curator_memberships m
    where m.user_id = auth.uid() and m.role = 'owner'
  ));

create policy ranking_jobs_owner_read on public.ranking_jobs
  for select to authenticated
  using (exists (
    select 1 from public.curator_memberships m
    where m.user_id = auth.uid() and m.role = 'owner'
  ));

create policy ranking_snapshots_owner_read on public.ranking_snapshots
  for select to authenticated
  using (exists (
    select 1 from public.curator_memberships m
    where m.user_id = auth.uid() and m.role = 'owner'
  ));

create function public.enqueue_curation_case(
  p_case_key text,
  p_entity_type text,
  p_source_revision text,
  p_payload jsonb
) returns public.curation_cases
language plpgsql
security definer
set search_path = public
as $$
declare
  queued_case public.curation_cases;
begin
  insert into public.curation_cases as target (
    case_key,
    entity_type,
    source_revision,
    payload
  ) values (
    p_case_key,
    p_entity_type,
    p_source_revision,
    p_payload
  )
  on conflict (case_key) do update
    set payload = excluded.payload,
        updated_at = now()
    where target.status not in ('approved', 'rejected', 'published', 'failed')
  returning * into queued_case;

  if queued_case.id is null then
    select * into queued_case
    from public.curation_cases
    where case_key = p_case_key;
  end if;

  return queued_case;
end;
$$;

revoke all on function public.enqueue_curation_case(text, text, text, jsonb) from public;
grant execute on function public.enqueue_curation_case(text, text, text, jsonb) to service_role;

create function public.lease_curation_case(
  worker_id text,
  lease_seconds integer
) returns public.curation_cases
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  candidate_id bigint;
  leased_case public.curation_cases;
begin
  if worker_id is null or btrim(worker_id) = '' then
    raise exception 'worker_id must not be empty';
  end if;
  if lease_seconds is null or lease_seconds <= 0 then
    raise exception 'lease_seconds must be positive';
  end if;

  select c.id into candidate_id
  from public.curation_cases c
  where c.status = 'pending'
    or (
      c.status = 'leased'
      and c.lease_expires_at <= statement_timestamp()
    )
  order by c.priority desc, c.created_at, c.id
  for update skip locked
  limit 1;

  if candidate_id is null then
    return null;
  end if;

  update public.curation_cases c
  set status = 'leased',
      lease_owner = worker_id,
      lease_expires_at = statement_timestamp() + make_interval(secs => lease_seconds),
      updated_at = statement_timestamp()
  where c.id = candidate_id
  returning c.* into leased_case;

  return leased_case;
end;
$$;

create function public.heartbeat_curation_case(
  case_id bigint,
  worker_id text,
  lease_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  checked_at timestamptz;
  locked_case public.curation_cases;
begin
  if worker_id is null or btrim(worker_id) = '' then
    raise exception 'worker_id must not be empty';
  end if;
  if lease_seconds is null or lease_seconds <= 0 then
    raise exception 'lease_seconds must be positive';
  end if;

  select c.* into locked_case
  from public.curation_cases c
  where c.id = case_id
  for update;

  if not found then
    return false;
  end if;

  checked_at := clock_timestamp();
  if locked_case.status is distinct from 'leased'
    or locked_case.lease_owner is distinct from worker_id
    or locked_case.lease_expires_at is null
    or locked_case.lease_expires_at <= checked_at then
    return false;
  end if;

  update public.curation_cases c
  set lease_expires_at = greatest(
        locked_case.lease_expires_at,
        checked_at + make_interval(secs => lease_seconds)
      ),
      updated_at = checked_at
  where c.id = case_id;

  return true;
end;
$$;

create function public.release_curation_case(
  case_id bigint,
  worker_id text,
  outcome text,
  error_text text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  checked_at timestamptz;
  locked_case public.curation_cases;
begin
  if worker_id is null or btrim(worker_id) = '' then
    raise exception 'worker_id must not be empty';
  end if;
  if outcome not in ('approved', 'rejected', 'awaiting_human', 'technical_failure') then
    raise exception 'unsupported curation outcome: %', outcome;
  end if;

  select c.* into locked_case
  from public.curation_cases c
  where c.id = case_id
  for update;

  if not found then
    return false;
  end if;

  checked_at := clock_timestamp();
  if outcome <> 'technical_failure' and locked_case.status = outcome then
    return true;
  end if;
  if locked_case.status is distinct from 'leased'
    or locked_case.lease_owner is distinct from worker_id
    or locked_case.lease_expires_at is null
    or locked_case.lease_expires_at <= checked_at then
    return false;
  end if;

  if outcome = 'technical_failure' then
    update public.curation_cases c
    set status = case
          when c.attempt_count + 1 >= 3 then 'awaiting_human'
          else 'pending'
        end,
        lease_owner = null,
        lease_expires_at = null,
        attempt_count = c.attempt_count + 1,
        last_error = error_text,
        updated_at = checked_at
    where c.id = case_id;

    return true;
  end if;

  update public.curation_cases c
  set status = outcome,
      lease_owner = null,
      lease_expires_at = null,
      last_error = case when outcome in ('approved', 'rejected') then null else error_text end,
      updated_at = checked_at
  where c.id = case_id;

  return true;
end;
$$;

create function public.record_ai_review(
  case_id bigint,
  worker_id text,
  review_role text,
  model text,
  prompt_version text,
  evidence jsonb,
  decision jsonb
) returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  checked_at timestamptz;
  locked_case public.curation_cases;
  review_id bigint;
begin
  select c.* into locked_case
  from public.curation_cases c
  where c.id = case_id
  for update;

  if not found then
    raise exception 'worker is not the active lease owner';
  end if;

  checked_at := clock_timestamp();
  if locked_case.status is distinct from 'leased'
    or locked_case.lease_owner is distinct from worker_id
    or locked_case.lease_expires_at is null
    or locked_case.lease_expires_at <= checked_at then
    raise exception 'worker is not the active lease owner';
  end if;

  insert into public.ai_reviews (
    case_id,
    review_role,
    model,
    prompt_version,
    evidence,
    decision
  ) values (
    case_id,
    review_role,
    model,
    prompt_version,
    evidence,
    decision
  )
  returning id into review_id;

  return review_id;
end;
$$;

create function public.read_curation_reviews(
  case_id bigint,
  worker_id text
) returns table (
  review_role text,
  model text,
  prompt_version text,
  evidence jsonb,
  decision jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  checked_at timestamptz;
  locked_case public.curation_cases;
begin
  select c.* into locked_case
  from public.curation_cases c
  where c.id = case_id
  for update;

  if not found then
    raise exception 'worker is not the active lease owner';
  end if;

  checked_at := clock_timestamp();
  if locked_case.status is distinct from 'leased'
    or locked_case.lease_owner is distinct from worker_id
    or locked_case.lease_expires_at is null
    or locked_case.lease_expires_at <= checked_at then
    raise exception 'worker is not the active lease owner';
  end if;

  return query
  select r.review_role, r.model, r.prompt_version, r.evidence, r.decision
  from public.ai_reviews r
  where r.case_id = read_curation_reviews.case_id
  order by r.created_at, r.id;
end;
$$;

revoke all on function public.lease_curation_case(text, integer) from public;
revoke all on function public.heartbeat_curation_case(bigint, text, integer) from public;
revoke all on function public.release_curation_case(bigint, text, text, text) from public;
revoke all on function public.record_ai_review(bigint, text, text, text, text, jsonb, jsonb) from public;
revoke all on function public.read_curation_reviews(bigint, text) from public;

grant execute on function public.lease_curation_case(text, integer) to service_role;
grant execute on function public.heartbeat_curation_case(bigint, text, integer) to service_role;
grant execute on function public.release_curation_case(bigint, text, text, text) to service_role;
grant execute on function public.record_ai_review(bigint, text, text, text, text, jsonb, jsonb)
  to service_role;
grant execute on function public.read_curation_reviews(bigint, text) to service_role;
