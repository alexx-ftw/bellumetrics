begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

create temp table contract_tables (
  table_name text primary key,
  is_staging boolean not null
);
insert into contract_tables (table_name, is_staging) values
  ('commanders', false),
  ('campaigns', false),
  ('engagements', false),
  ('engagement_sides', false),
  ('participations', false),
  ('result_interpretations', false),
  ('sources', false),
  ('claims', false),
  ('claim_sources', false),
  ('commander_claims', false),
  ('engagement_claims', false),
  ('participation_claims', false),
  ('result_interpretation_claims', false),
  ('import_runs', true),
  ('import_records', true);

create temp table contract_privileges (privilege text primary key);
insert into contract_privileges (privilege) values
  ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
  ('REFERENCES'), ('TRIGGER'), ('MAINTAIN');

create temp table contract_sequences (
  sequence_name text primary key,
  is_staging boolean not null
);
insert into contract_sequences (sequence_name, is_staging) values
  ('commanders_id_seq', false),
  ('campaigns_id_seq', false),
  ('engagements_id_seq', false),
  ('engagement_sides_id_seq', false),
  ('participations_id_seq', false),
  ('result_interpretations_id_seq', false),
  ('sources_id_seq', false),
  ('claims_id_seq', false),
  ('import_runs_id_seq', true),
  ('import_records_id_seq', true);

create temp table contract_sequence_privileges (privilege text primary key);
insert into contract_sequence_privileges (privilege) values
  ('USAGE'), ('SELECT'), ('UPDATE');

create temp table contract_policies (
  table_name text primary key,
  policy_name text not null unique
);
insert into contract_policies (table_name, policy_name) values
  ('commanders', 'commanders_public_read'),
  ('campaigns', 'campaigns_public_read'),
  ('engagements', 'engagements_public_read'),
  ('engagement_sides', 'engagement_sides_public_read'),
  ('participations', 'participations_public_read'),
  ('result_interpretations', 'result_interpretations_public_read'),
  ('sources', 'sources_public_read'),
  ('claims', 'claims_public_read'),
  ('claim_sources', 'claim_sources_public_read'),
  ('commander_claims', 'commander_claims_public_read'),
  ('engagement_claims', 'engagement_claims_public_read'),
  ('participation_claims', 'participation_claims_public_read'),
  ('result_interpretation_claims', 'result_interpretation_claims_public_read');

select plan(14);
select ok(
  not exists (select 1 from contract_tables t where to_regclass(format('public.%s', t.table_name)) is null),
  format('all 15 contract tables exist; missing: %s', coalesce((
    select string_agg(t.table_name, ', ' order by t.table_name)
    from contract_tables t
    where to_regclass(format('public.%s', t.table_name)) is null
  ), 'none'))
);
select ok(
  not exists (
    select 1 from contract_tables t
    left join pg_class c on c.oid = to_regclass(format('public.%s', t.table_name))
    where c.relrowsecurity is not true
  ),
  format('RLS is active on every contract table; missing: %s', coalesce((
    select string_agg(t.table_name, ', ' order by t.table_name)
    from contract_tables t
    left join pg_class c on c.oid = to_regclass(format('public.%s', t.table_name))
    where c.relrowsecurity is not true
  ), 'none'))
);
select ok(
  not exists (
    select 1 from contract_tables t
    where not t.is_staging and not has_table_privilege('anon', format('public.%s', t.table_name), 'SELECT')
  ),
  format('anon has SELECT on every canonical table; missing: %s', coalesce((
    select string_agg(t.table_name, ', ' order by t.table_name)
    from contract_tables t
    where not t.is_staging and not has_table_privilege('anon', format('public.%s', t.table_name), 'SELECT')
  ), 'none'))
);
select ok(
  not exists (
    select 1 from contract_tables t
    where not t.is_staging and not has_table_privilege('authenticated', format('public.%s', t.table_name), 'SELECT')
  ),
  format('authenticated has SELECT on every canonical table; missing: %s', coalesce((
    select string_agg(t.table_name, ', ' order by t.table_name)
    from contract_tables t
    where not t.is_staging and not has_table_privilege('authenticated', format('public.%s', t.table_name), 'SELECT')
  ), 'none'))
);
select ok(
  not exists (
    select 1 from contract_tables t cross join contract_privileges p
    where not t.is_staging and p.privilege <> 'SELECT'
      and has_table_privilege('anon', format('public.%s', t.table_name), p.privilege)
  ),
  format('anon has no canonical write privileges; offending: %s', coalesce((
    select string_agg(format('%s/%s', t.table_name, p.privilege), ', ' order by t.table_name, p.privilege)
    from contract_tables t cross join contract_privileges p
    where not t.is_staging and p.privilege <> 'SELECT'
      and has_table_privilege('anon', format('public.%s', t.table_name), p.privilege)
  ), 'none'))
);
select ok(
  not exists (
    select 1 from contract_tables t cross join contract_privileges p
    where not t.is_staging and p.privilege <> 'SELECT'
      and has_table_privilege('authenticated', format('public.%s', t.table_name), p.privilege)
  ),
  format('authenticated has no canonical write privileges; offending: %s', coalesce((
    select string_agg(format('%s/%s', t.table_name, p.privilege), ', ' order by t.table_name, p.privilege)
    from contract_tables t cross join contract_privileges p
    where not t.is_staging and p.privilege <> 'SELECT'
      and has_table_privilege('authenticated', format('public.%s', t.table_name), p.privilege)
  ), 'none'))
);
select ok(
  not exists (
    select 1 from contract_tables t cross join contract_privileges p
    where t.is_staging and has_table_privilege('anon', format('public.%s', t.table_name), p.privilege)
  ),
  format('anon has no staging privileges; offending: %s', coalesce((
    select string_agg(format('%s/%s', t.table_name, p.privilege), ', ' order by t.table_name, p.privilege)
    from contract_tables t cross join contract_privileges p
    where t.is_staging and has_table_privilege('anon', format('public.%s', t.table_name), p.privilege)
  ), 'none'))
);
select ok(
  not exists (
    select 1 from contract_tables t cross join contract_privileges p
    where t.is_staging and has_table_privilege('authenticated', format('public.%s', t.table_name), p.privilege)
  ),
  format('authenticated has no staging privileges; offending: %s', coalesce((
    select string_agg(format('%s/%s', t.table_name, p.privilege), ', ' order by t.table_name, p.privilege)
    from contract_tables t cross join contract_privileges p
    where t.is_staging and has_table_privilege('authenticated', format('public.%s', t.table_name), p.privilege)
  ), 'none'))
);
select ok(
  not exists (
    select 1
    from (values ('anon'), ('authenticated')) as roles(role_name)
    cross join contract_sequences s
    cross join contract_sequence_privileges p
    where has_sequence_privilege(
      roles.role_name,
      format('public.%s', s.sequence_name),
      p.privilege
    )
  ),
  'browser roles have no canonical or staging identity-sequence privileges'
);
select ok(
  not exists (
    select 1
    from (values ('import_runs'), ('import_records')) as staging(table_name)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE')) as required(privilege)
    where not has_table_privilege(
      'service_role',
      format('public.%s', staging.table_name),
      required.privilege
    )
  ),
  'service_role has the staging table privileges required by the importer'
);
select ok(
  not exists (
    select 1
    from contract_sequences s
    cross join (values ('USAGE'), ('SELECT')) as required(privilege)
    where s.is_staging
      and not has_sequence_privilege(
        'service_role',
        format('public.%s', s.sequence_name),
        required.privilege
      )
  ),
  'service_role has explicit staging identity-sequence privileges'
);
select ok(
  not exists (
    select 1
    from contract_policies expected
    where not exists (
      select 1
      from pg_policies actual
      where actual.schemaname = 'public'
        and actual.tablename = expected.table_name
        and actual.policyname = expected.policy_name
        and actual.cmd = 'SELECT'
    )
  ),
  'every canonical table has its expected public read policy'
);
select ok(
  not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename in ('import_runs', 'import_records')
  ),
  'staging tables have no client policies'
);
select ok(
  exists (
    with current_run as (
      select id, row_counts
      from public.import_runs
      where source_dataset = 'the-war-atlas' and status = 'staged'
      order by completed_at desc nulls last, id desc
      limit 1
    )
    select 1
    from current_run r
    where jsonb_typeof(r.row_counts->'manifest'->'battle') = 'number'
      and jsonb_typeof(r.row_counts->'actual') = 'object'
      and (r.row_counts->'manifest'->>'battle')::bigint = (
        select count(*) from public.import_records records
        where records.import_run_id = r.id and records.entity_type = 'battle'
      )
      and not exists (
        select 1
        from jsonb_each(r.row_counts->'actual') stored(entity_type, entity_count)
        where not case
          when jsonb_typeof(stored.entity_count) = 'number' then
            (stored.entity_count #>> '{}')::bigint = (
              select count(*)
              from public.import_records records
              where records.import_run_id = r.id
                and records.entity_type = stored.entity_type
            )
          else false
        end
      )
      and not exists (
        select 1
        from public.import_records records
        where records.import_run_id = r.id
          and not (r.row_counts->'actual' ? records.entity_type)
      )
  ),
  'current staged The War Atlas run counts match its import records'
);
select * from finish();
rollback;
