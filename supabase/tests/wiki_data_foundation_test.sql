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
  ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER');

select plan(10);
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
  exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'commanders' and policyname = 'commanders_public_read'),
  'commander read policy exists'
);
select ok(exists(select 1 from public.import_runs where status = 'staged'), 'a staged import exists');
select * from finish();
rollback;
