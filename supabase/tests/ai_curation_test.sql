begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
grant usage on schema extensions to authenticated;

create temp table curation_contract_tables (table_name text primary key);
insert into curation_contract_tables (table_name) values
  ('curator_memberships'),
  ('curation_cases'),
  ('ai_reviews'),
  ('commander_identity_links'),
  ('editorial_events'),
  ('ranking_jobs'),
  ('ranking_snapshots');

create temp table curation_contract_values (
  case_key text primary key,
  valid_state_case_key text not null,
  invalid_state_case_key text not null,
  data_revision text not null,
  algorithm_version text not null
);
insert into curation_contract_values (
  case_key,
  valid_state_case_key,
  invalid_state_case_key,
  data_revision,
  algorithm_version
)
select
  format('ai-curation-contract-owner-visible-case-%s', txid_current()),
  format('ai-curation-contract-valid-state-case-%s', txid_current()),
  format('ai-curation-contract-invalid-state-case-%s', txid_current()),
  format('ai-curation-contract-data-v1-%s', txid_current()),
  format('ai-curation-contract-elo-v1-%s', txid_current());
grant select on curation_contract_values to authenticated;

create temp table curation_queue_values (
  high_old_key text primary key,
  high_new_key text not null,
  expired_key text not null,
  review_key text not null,
  release_key text not null,
  retry_key text not null,
  delayed_heartbeat_key text not null,
  delayed_review_key text not null,
  delayed_release_key text not null
);
insert into curation_queue_values (
  high_old_key,
  high_new_key,
  expired_key,
  review_key,
  release_key,
  retry_key,
  delayed_heartbeat_key,
  delayed_review_key,
  delayed_release_key
)
select
  format('ai-curation-queue-high-old-%s', txid_current()),
  format('ai-curation-queue-high-new-%s', txid_current()),
  format('ai-curation-queue-expired-%s', txid_current()),
  format('ai-curation-queue-review-%s', txid_current()),
  format('ai-curation-queue-release-%s', txid_current()),
  format('ai-curation-queue-retry-%s', txid_current()),
  format('ai-curation-queue-delayed-heartbeat-%s', txid_current()),
  format('ai-curation-queue-delayed-review-%s', txid_current()),
  format('ai-curation-queue-delayed-release-%s', txid_current());

insert into public.curator_memberships (user_id, role)
values ('00000000-0000-0000-0000-000000000001', 'owner')
on conflict (user_id) do update set role = excluded.role;
insert into public.curation_cases (case_key, entity_type, source_revision, payload)
select case_key, 'battle', 'source-v1', '{}'::jsonb
from curation_contract_values
on conflict (case_key) do update set payload = excluded.payload;
insert into public.ai_reviews (case_id, review_role, model, prompt_version, evidence, decision)
select id, 'proposer', 'test-model', 'v1', '[]'::jsonb, '{}'::jsonb
from public.curation_cases
where case_key = (select case_key from curation_contract_values);
insert into public.editorial_events (case_id, actor_type, action)
select id, 'system', 'created'
from public.curation_cases
where case_key = (select case_key from curation_contract_values);
insert into public.ranking_jobs (data_revision, algorithm_version)
select data_revision, algorithm_version from curation_contract_values;
insert into public.ranking_snapshots (data_revision, algorithm_version, results)
select data_revision, algorithm_version, '[]'::jsonb from curation_contract_values
on conflict (data_revision, algorithm_version) do update set results = excluded.results;

select plan(60);
select ok(
  not exists (
    select 1 from curation_contract_tables t
    where to_regclass(format('public.%s', t.table_name)) is null
  ),
  'all curation contract tables exist'
);
select ok(
  not exists (
    select 1
    from curation_contract_tables t
    join pg_class c on c.oid = to_regclass(format('public.%s', t.table_name))
    where c.relrowsecurity is not true
  ),
  'RLS is enabled on every curation table'
);
select ok(
  not exists (
    select 1 from curation_contract_tables t
    where has_table_privilege('anon', format('public.%s', t.table_name), 'SELECT')
  ),
  'anon has no curation table access'
);
select ok(
  not exists (
    select 1
    from curation_contract_tables t
    cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) as writes(privilege)
    where has_table_privilege('authenticated', format('public.%s', t.table_name), writes.privilege)
  ),
  'browser roles have no direct curation writes'
);
select ok(
  not exists (
    select 1
    from curation_contract_tables t
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as direct_table_access(privilege)
    where has_table_privilege('service_role', format('public.%s', t.table_name), direct_table_access.privilege)
  ),
  'worker service role has no direct curation table access'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select is(
  (select count(*)::integer from public.curation_cases
    where case_key = (select case_key from curation_contract_values)),
  1,
  'owner membership can read curation cases'
);
select is(
  (select count(*)::integer from public.ai_reviews
    where case_id = (select id from public.curation_cases
      where case_key = (select case_key from curation_contract_values))),
  1,
  'owner membership can read AI reviews'
);
select is(
  (select count(*)::integer from public.editorial_events
    where case_id = (select id from public.curation_cases
      where case_key = (select case_key from curation_contract_values))),
  1,
  'owner membership can read editorial events'
);
select is(
  (select count(*)::integer from public.ranking_jobs
    where (data_revision, algorithm_version) = (
      select data_revision, algorithm_version from curation_contract_values)),
  1,
  'owner membership can read ranking jobs'
);
select is(
  (select count(*)::integer from public.ranking_snapshots
    where (data_revision, algorithm_version) = (
      select data_revision, algorithm_version from curation_contract_values)),
  1,
  'owner membership can read ranking snapshots'
);

reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
set local role authenticated;
select is(
  (select count(*)::integer from public.curation_cases
    where case_key = (select case_key from curation_contract_values)),
  0,
  'non-owner memberships cannot read curation cases'
);
reset role;

select throws_ok(
  $$insert into public.curation_cases (case_key, entity_type, source_revision, payload)
    select case_key, 'battle', 'source-v1', '{}'::jsonb from curation_contract_values$$,
  '23505',
  null,
  'case_key is unique'
);
select lives_ok(
  $$insert into public.curation_cases (case_key, entity_type, source_revision, payload, status)
    select valid_state_case_key, 'battle', 'source-v1', '{}'::jsonb, 'awaiting_human'
    from curation_contract_values$$,
  'curation cases accept valid finite states'
);
select throws_ok(
  $$insert into public.curation_cases (case_key, entity_type, source_revision, payload, status)
    select invalid_state_case_key, 'battle', 'source-v1', '{}'::jsonb, 'invented'
    from curation_contract_values$$,
  '23514',
  null,
  'curation cases reject invalid states'
);
select throws_ok(
  $$insert into public.ai_reviews (case_id, review_role, model, prompt_version, evidence, decision)
    select id, 'arbiter', 'test-model', 'v1', '[]'::jsonb, '{}'::jsonb
    from public.curation_cases
    where case_key = (select case_key from curation_contract_values)$$,
  '23514',
  null,
  'AI reviews reject invalid review roles'
);
select throws_ok(
  $$insert into public.ranking_jobs (data_revision, algorithm_version, status)
    values ('data-v2', 'elo-v1', 'invented')$$,
  '23514',
  null,
  'ranking jobs reject invalid states'
);

select lives_ok(
  $$insert into public.ranking_jobs (data_revision, algorithm_version, status)
    values ('data-v2', 'elo-v1', 'completed')$$,
  'ranking jobs accept valid finite states'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select throws_ok(
  $$update public.ai_reviews set model = 'browser-model'
    where case_id = (select id from public.curation_cases
      where case_key = (select case_key from curation_contract_values))$$,
  '42501',
  null,
  'browser roles cannot modify AI reviews'
);
select throws_ok(
  $$delete from public.editorial_events
    where case_id = (select id from public.curation_cases
      where case_key = (select case_key from curation_contract_values))$$,
  '42501',
  null,
  'browser roles cannot delete editorial events'
);
reset role;

select ok(
  not exists (
    select 1
    from (values
      ('public.lease_curation_case(text,integer)'),
      ('public.heartbeat_curation_case(bigint,text,integer)'),
      ('public.release_curation_case(bigint,text,text,text)'),
      ('public.record_ai_review(bigint,text,text,text,text,jsonb,jsonb)'),
      ('public.publish_curation_decision(bigint,text,bigint,bigint,text)')
    ) as rpc(signature)
    cross join (values ('anon'), ('authenticated'), ('service_role')) as roles(role_name)
    where has_function_privilege(roles.role_name, rpc.signature, 'EXECUTE')
      is distinct from (roles.role_name = 'service_role')
  ),
  'only the worker service role can execute curation queue RPCs'
);

update public.curation_cases
set status = 'awaiting_human', lease_owner = null, lease_expires_at = null
where status in ('pending', 'leased');

insert into public.curation_cases (
  case_key, entity_type, source_revision, payload, priority, created_at
) values
  ((select high_old_key from curation_queue_values), 'battle', 'source-v1', '{}'::jsonb,
    1000, '2026-08-24 01:00:00+00'),
  ((select high_new_key from curation_queue_values), 'battle', 'source-v1', '{}'::jsonb,
    1000, '2026-08-24 02:00:00+00');

select is(
  (public.lease_curation_case('queue-worker-a', 300)).case_key,
  (select high_old_key from curation_queue_values),
  'lease chooses the oldest case at the highest priority'
);
select is(
  (public.lease_curation_case('queue-worker-b', 300)).case_key,
  (select high_new_key from curation_queue_values),
  'a second worker does not receive the active first lease'
);
select is(
  public.heartbeat_curation_case(
    (select id from public.curation_cases
      where case_key = (select high_old_key from curation_queue_values)),
    'queue-worker-b',
    600
  ),
  false,
  'a foreign worker cannot heartbeat a lease'
);
select is(
  public.heartbeat_curation_case(
    (select id from public.curation_cases
      where case_key = (select high_old_key from curation_queue_values)),
    'queue-worker-a',
    600
  ),
  true,
  'the active owner can heartbeat a lease'
);
update public.curation_cases
set lease_expires_at = now() - interval '1 second'
where case_key = (select high_old_key from curation_queue_values);
select is(
  public.heartbeat_curation_case(
    (select id from public.curation_cases
      where case_key = (select high_old_key from curation_queue_values)),
    'queue-worker-a',
    600
  ),
  false,
  'a heartbeat cannot revive an expired lease'
);

insert into public.curation_cases (
  case_key, entity_type, source_revision, payload, status, priority,
  lease_owner, lease_expires_at
)
select expired_key, 'battle', 'source-v1', '{}'::jsonb, 'leased', 2000,
  'dead-worker', now() - interval '1 minute'
from curation_queue_values;
select is(
  (public.lease_curation_case('queue-worker-c', 300)).lease_owner,
  'queue-worker-c',
  'an expired lease is reclaimable by another worker'
);

insert into public.curation_cases (case_key, entity_type, source_revision, payload, priority)
select review_key, 'battle', 'source-v1', '{}'::jsonb, 3000
from curation_queue_values;
do $$
begin
  perform public.lease_curation_case('review-worker', 300);
end;
$$;
select ok(
  public.record_ai_review(
    (select id from public.curation_cases
      where case_key = (select review_key from curation_queue_values)),
    'review-worker',
    'proposer',
    'test-model',
    'prompt-v1',
    '[{"url":"https://example.test/source"}]'::jsonb,
    '{"action":"approve_battle"}'::jsonb
  ) > 0,
  'the active lease owner can persist an AI review'
);
select throws_ok(
  format(
    $$select public.record_ai_review(%s, 'foreign-worker', 'reviewer',
      'test-model', 'prompt-v1', '[]'::jsonb, '{}'::jsonb)$$,
    (select id from public.curation_cases
      where case_key = (select review_key from curation_queue_values))
  ),
  'P0001',
  'worker is not the active lease owner',
  'a foreign worker cannot persist an AI review'
);

insert into public.curation_cases (case_key, entity_type, source_revision, payload, priority)
select release_key, 'battle', 'source-v1', '{}'::jsonb, 4000
from curation_queue_values;
do $$
begin
  perform public.lease_curation_case('release-worker', 300);
end;
$$;
select is(
  public.release_curation_case(
    (select id from public.curation_cases
      where case_key = (select release_key from curation_queue_values)),
    'foreign-worker', 'approved', null
  ),
  false,
  'a foreign worker cannot release an active case'
);
select is(
  public.release_curation_case(
    (select id from public.curation_cases
      where case_key = (select release_key from curation_queue_values)),
    'release-worker', 'approved', null
  ),
  true,
  'the active worker can complete a case'
);
select is(
  public.release_curation_case(
    (select id from public.curation_cases
      where case_key = (select release_key from curation_queue_values)),
    'release-worker', 'approved', null
  ),
  true,
  'repeating the same completion is idempotent'
);
select is(
  (select status || ':' || attempt_count
    from public.curation_cases
    where case_key = (select release_key from curation_queue_values)),
  'approved:0',
  'successful completion does not count as a failed attempt'
);

insert into public.curation_cases (case_key, entity_type, source_revision, payload, priority)
select retry_key, 'battle', 'source-v1', '{}'::jsonb, 5000
from curation_queue_values;
do $$
begin
  perform public.lease_curation_case('retry-worker-1', 300);
end;
$$;
select is(
  public.release_curation_case(
    (select id from public.curation_cases
      where case_key = (select retry_key from curation_queue_values)),
    'retry-worker-1', 'technical_failure', 'failure 1'
  ),
  true,
  'the first technical failure releases the case for retry'
);
do $$
begin
  perform public.lease_curation_case('retry-worker-2', 300);
end;
$$;
select is(
  public.release_curation_case(
    (select id from public.curation_cases
      where case_key = (select retry_key from curation_queue_values)),
    'retry-worker-2', 'technical_failure', 'failure 2'
  ),
  true,
  'the second technical failure releases the case for retry'
);
do $$
begin
  perform public.lease_curation_case('retry-worker-3', 300);
end;
$$;
select is(
  public.release_curation_case(
    (select id from public.curation_cases
      where case_key = (select retry_key from curation_queue_values)),
    'retry-worker-3', 'technical_failure', 'failure 3'
  ),
  true,
  'the third technical failure completes the retry transition'
);
select is(
  (select status || ':' || attempt_count || ':' || last_error
    from public.curation_cases
    where case_key = (select retry_key from curation_queue_values)),
  'awaiting_human:3:failure 3',
  'the third technical failure escalates to awaiting_human'
);

insert into public.curation_cases (
  case_key, entity_type, source_revision, payload, status, lease_owner, lease_expires_at
)
select delayed_heartbeat_key, 'battle', 'source-v1', '{}'::jsonb, 'leased',
  'delayed-worker', clock_timestamp() + interval '100 milliseconds'
from curation_queue_values;
select is(
  (
    with delayed(case_id) as materialized (
      select c.id
      from public.curation_cases c
      cross join lateral pg_sleep(0.2)
      where c.case_key = (select delayed_heartbeat_key from curation_queue_values)
    )
    select public.heartbeat_curation_case(delayed.case_id, 'delayed-worker', 300)
    from delayed
  ),
  false,
  'heartbeat validates expiry against the wall clock after a delayed statement boundary'
);

insert into public.curation_cases (
  case_key, entity_type, source_revision, payload, status, lease_owner, lease_expires_at
)
select delayed_review_key, 'battle', 'source-v1', '{}'::jsonb, 'leased',
  'delayed-worker', clock_timestamp() + interval '100 milliseconds'
from curation_queue_values;
select throws_ok(
  $$
    with delayed(case_id) as materialized (
      select c.id
      from public.curation_cases c
      cross join lateral pg_sleep(0.2)
      where c.case_key = (select delayed_review_key from curation_queue_values)
    )
    select public.record_ai_review(
      delayed.case_id, 'delayed-worker', 'proposer', 'test-model', 'prompt-v1',
      '[]'::jsonb, '{}'::jsonb
    )
    from delayed
  $$,
  'P0001',
  'worker is not the active lease owner',
  'AI review ownership uses the wall clock after a delayed statement boundary'
);

insert into public.curation_cases (
  case_key, entity_type, source_revision, payload, status, lease_owner, lease_expires_at
)
select delayed_release_key, 'battle', 'source-v1', '{}'::jsonb, 'leased',
  'delayed-worker', clock_timestamp() + interval '100 milliseconds'
from curation_queue_values;
select is(
  (
    with delayed(case_id) as materialized (
      select c.id
      from public.curation_cases c
      cross join lateral pg_sleep(0.2)
      where c.case_key = (select delayed_release_key from curation_queue_values)
    )
    select public.release_curation_case(
      delayed.case_id, 'delayed-worker', 'technical_failure', 'late failure'
    )
    from delayed
  ),
  false,
  'release validates expiry against the wall clock after a delayed statement boundary'
);

select ok(
  not exists (
    select 1
    from (values ('anon'), ('authenticated'), ('service_role')) as roles(role_name)
    where has_function_privilege(
      roles.role_name,
      'public.publish_curation_decision(bigint,text,bigint,bigint,text)',
      'EXECUTE'
    ) is distinct from (roles.role_name = 'service_role')
  ),
  'only service_role can execute transactional publication'
);
select ok(
  not exists (
    select 1
    from (values ('anon'), ('authenticated'), ('service_role')) as roles(role_name)
    where has_function_privilege(
      roles.role_name,
      'public.revert_editorial_event(bigint,uuid,text)',
      'EXECUTE'
    ) is distinct from (roles.role_name = 'authenticated')
  ),
  'only authenticated owners can reach the reversal RPC'
);

create temp table curation_publication_values (
  source_commander_id bigint not null,
  target_commander_id bigint not null,
  case_id bigint not null,
  proposer_review_id bigint,
  reviewer_review_id bigint,
  event_id bigint,
  ranking_job_id bigint
);
grant select on curation_publication_values to authenticated;
with source_commander as (
  insert into public.commanders (slug, display_name, publication_status)
  values (
    format('pgtap-source-%s', txid_current()),
    'pgTAP source commander',
    'published'
  )
  returning id
), target_commander as (
  insert into public.commanders (slug, display_name, publication_status)
  values (
    format('pgtap-target-%s', txid_current()),
    'pgTAP target commander',
    'published'
  )
  returning id
), publication_case as (
  insert into public.curation_cases (
    case_key, entity_type, source_revision, payload, status,
    lease_owner, lease_expires_at
  ) values (
    format('pgtap-publication-%s', txid_current()),
    'commander',
    'pgtap-publication-v1',
    '{}'::jsonb,
    'leased',
    'pgtap-publication-worker',
    clock_timestamp() + interval '5 minutes'
  )
  returning id
)
insert into curation_publication_values (
  source_commander_id, target_commander_id, case_id
)
select source_commander.id, target_commander.id, publication_case.id
from source_commander, target_commander, publication_case;

insert into public.ai_reviews (
  case_id, review_role, model, prompt_version, evidence, decision
)
select
  values.case_id,
  review.review_role,
  'pgtap-model',
  review.prompt_version,
  jsonb_build_array(jsonb_build_object('citation', 'pgTAP identity fixture')),
  jsonb_build_object(
    'action', 'merge_commanders',
    'evidence', jsonb_build_array(jsonb_build_object('citation', 'pgTAP identity fixture')),
    'reason', 'The fixture records identify the same commander.',
    'canonicalMutation', jsonb_build_object(
      'action', 'merge_commanders',
      'source', jsonb_build_object(
        'type', 'commander',
        'id', 'canonical:' || values.source_commander_id::text
      ),
      'target', jsonb_build_object(
        'type', 'commander',
        'id', 'canonical:' || values.target_commander_id::text
      )
    ),
    'dataRevision', 'pgtap-publication-v1',
    'promptVersion', review.prompt_version
  )
from curation_publication_values values
cross join (values
  ('proposer', 'proposer-v1'),
  ('reviewer', 'reviewer-v1')
) as review(review_role, prompt_version);

update curation_publication_values values
set proposer_review_id = reviews.proposer_review_id,
    reviewer_review_id = reviews.reviewer_review_id
from (
  select case_id,
    max(id) filter (where review_role = 'proposer') as proposer_review_id,
    max(id) filter (where review_role = 'reviewer') as reviewer_review_id
  from public.ai_reviews
  group by case_id
) reviews
where reviews.case_id = values.case_id;

select lives_ok(
  format(
    $$select * from public.publish_curation_decision(
      %s, 'pgtap-publication-worker', %s, %s, 'pgtap-model'
    )$$,
    (select case_id from curation_publication_values),
    (select proposer_review_id from curation_publication_values),
    (select reviewer_review_id from curation_publication_values)
  ),
  'compatible reviews publish through one database transaction'
);
update curation_publication_values values
set event_id = event.id,
    ranking_job_id = job.id
from public.editorial_events event
join public.ranking_jobs job on job.editorial_event_id = event.id
where event.case_id = values.case_id
  and event.action = 'merge_commanders';
select ok(
  exists (
    select 1
    from curation_publication_values values
    join public.curation_cases c on c.id = values.case_id
    where c.status = 'published'
      and c.lease_owner is null
      and values.event_id is not null
      and values.ranking_job_id is not null
  ),
  'publication atomically stores the event, terminal case state, and ranking job'
);
select is(
  (
    select link_state
    from public.commander_identity_links
    where editorial_event_id = (select event_id from curation_publication_values)
  ),
  'linked',
  'merge appends an identity link without deleting the source identity'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select lives_ok(
  format(
    $$select * from public.revert_editorial_event(
      %s, '00000000-0000-0000-0000-000000000001', 'pgTAP owner reversal'
    )$$,
    (select event_id from curation_publication_values)
  ),
  'verified owner membership can append a compensating reversal'
);
reset role;
select ok(
  exists (
    select 1
    from public.editorial_events reversal
    where reversal.reverts_event_id = (select event_id from curation_publication_values)
      and reversal.action = 'revert_merge_commanders'
  ),
  'reversal preserves the original event and appends a compensating event'
);
select is(
  (
    select link_state
    from public.commander_identity_links
    where source_commander_id = (
      select source_commander_id from curation_publication_values
    )
    order by id desc
    limit 1
  ),
  'separated',
  'reversal appends the inverse effective identity state'
);
select is(
  (
    select count(*)::integer
    from public.ranking_jobs job
    where job.editorial_event_id in (
      select event.id
      from public.editorial_events event
      where event.case_id = (select case_id from curation_publication_values)
    )
  ),
  2,
  'publication and reversal each enqueue one idempotent ranking job'
);
select throws_ok(
  format(
    $$delete from public.commander_identity_links where source_commander_id = %s$$,
    (select source_commander_id from curation_publication_values)
  ),
  'P0001',
  'commander identity history is append-only',
  'identity links cannot be deleted after publication'
);

create temp table ranking_lifecycle_values (
  job_id bigint primary key,
  snapshot_id bigint
);
grant select, update on ranking_lifecycle_values to service_role;
insert into ranking_lifecycle_values (job_id)
select id
from public.ranking_jobs
where data_revision = (select data_revision from curation_contract_values)
  and algorithm_version = (select algorithm_version from curation_contract_values)
order by id
limit 1;

select ok(
  not exists (
    select 1
    from (values
      ('public.lease_ranking_job(text,integer)'),
      ('public.heartbeat_ranking_job(bigint,text,integer)'),
      ('public.read_ranking_input(bigint,text)'),
      ('public.complete_ranking_job(bigint,text,text,jsonb)'),
      ('public.release_ranking_job(bigint,text,text)')
    ) as functions(signature)
    cross join (values ('anon'), ('authenticated'), ('service_role')) as roles(role_name)
    where has_function_privilege(roles.role_name, functions.signature, 'EXECUTE')
      is distinct from (roles.role_name = 'service_role')
  ),
  'ranking lifecycle RPCs are service-role only'
);

set local role service_role;
select lives_ok(
  format(
    $$select public.lease_ranking_job('pgtap-ranking-worker', 300)
      from ranking_lifecycle_values where job_id = %s$$,
    (select job_id from ranking_lifecycle_values)
  ),
  'ranking worker can lease a pending job'
);
select ok(
  exists (
    select 1
    from public.ranking_jobs job
    join ranking_lifecycle_values values on values.job_id = job.id
    where job.status = 'leased'
      and job.lease_owner = 'pgtap-ranking-worker'
  ),
  'ranking lease records its owner and finite state'
);
select is(
  public.heartbeat_ranking_job(
    (select job_id from ranking_lifecycle_values),
    'another-ranking-worker',
    300
  ),
  false,
  'ranking heartbeat rejects another worker'
);
select is(
  public.heartbeat_ranking_job(
    (select job_id from ranking_lifecycle_values),
    'pgtap-ranking-worker',
    300
  ),
  true,
  'ranking heartbeat renews its own active lease'
);
select ok(
  jsonb_typeof(public.read_ranking_input(
    (select job_id from ranking_lifecycle_values),
    'pgtap-ranking-worker'
  )->'commanders') = 'array'
  and jsonb_typeof(public.read_ranking_input(
    (select job_id from ranking_lifecycle_values),
    'pgtap-ranking-worker'
  )->'engagements') = 'array'
  and jsonb_typeof(public.read_ranking_input(
    (select job_id from ranking_lifecycle_values),
    'pgtap-ranking-worker'
  )->'participations') = 'array',
  'ranking input is a closed three-array payload'
);
select lives_ok(
  format(
    $$select public.complete_ranking_job(
      %s,
      'pgtap-ranking-worker',
      'sha256:%s',
      '{"ratings":[],"battleDeltas":[],"inputDigest":"sha256:%s"}'::jsonb
    )$$,
    (select job_id from ranking_lifecycle_values),
    repeat('a', 64),
    repeat('a', 64)
  ),
  'ranking completion atomically publishes a snapshot'
);
reset role;

update ranking_lifecycle_values values
set snapshot_id = snapshot.id
from public.ranking_jobs job
join public.ranking_snapshots snapshot
  on snapshot.data_revision = job.data_revision
 and snapshot.algorithm_version = job.algorithm_version
where job.id = values.job_id;
select ok(
  exists (
    select 1
    from public.ranking_jobs job
    join ranking_lifecycle_values values on values.job_id = job.id
    where job.status = 'completed'
      and job.completed_at is not null
      and job.lease_owner is null
      and job.lease_expires_at is null
  ),
  'ranking completion clears the lease and records completion'
);
select is(
  (select count(*)::integer
   from public.ranking_snapshots snapshot
   join public.ranking_jobs job
     on job.data_revision = snapshot.data_revision
    and job.algorithm_version = snapshot.algorithm_version
   where job.id = (select job_id from ranking_lifecycle_values)),
  1,
  'ranking completion stores exactly one snapshot'
);
set local role service_role;
select is(
  public.complete_ranking_job(
    (select job_id from ranking_lifecycle_values),
    'pgtap-ranking-worker',
    'sha256:' || repeat('a', 64),
    jsonb_build_object(
      'ratings', '[]'::jsonb,
      'battleDeltas', '[]'::jsonb,
      'inputDigest', 'sha256:' || repeat('a', 64)
    )
  ),
  (select snapshot_id from ranking_lifecycle_values),
  'repeated ranking completion returns the same snapshot'
);
reset role;
select is(
  (select count(*)::integer
   from public.ranking_snapshots snapshot
   join public.ranking_jobs job
     on job.data_revision = snapshot.data_revision
    and job.algorithm_version = snapshot.algorithm_version
   where job.id = (select job_id from ranking_lifecycle_values)),
  1,
  'idempotent completion cannot duplicate the snapshot'
);

select * from finish();
rollback;
