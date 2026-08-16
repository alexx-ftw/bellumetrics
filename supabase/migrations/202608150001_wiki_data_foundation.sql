create table public.commanders (
  id bigint generated always as identity primary key,
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  display_name text not null check (length(btrim(display_name)) > 0),
  wikidata_qid text check (wikidata_qid is null or wikidata_qid ~ '^Q[1-9][0-9]*$'),
  birth_year integer,
  death_year integer,
  historicity_status text not null default 'documented'
    check (historicity_status in ('documented', 'disputed', 'legendary')),
  publication_status text not null default 'pending'
    check (publication_status in ('pending', 'published', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (death_year is null or birth_year is null or death_year >= birth_year)
);

create unique index commanders_wikidata_qid_uidx
  on public.commanders (wikidata_qid)
  where wikidata_qid is not null;
create index commanders_publication_name_idx
  on public.commanders (publication_status, display_name);

create table public.campaigns (
  id bigint generated always as identity primary key,
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title text not null check (length(btrim(title)) > 0),
  wikidata_qid text check (wikidata_qid is null or wikidata_qid ~ '^Q[1-9][0-9]*$'),
  start_year integer,
  end_year integer,
  publication_status text not null default 'pending'
    check (publication_status in ('pending', 'published', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_year is null or start_year is null or end_year >= start_year)
);

create unique index campaigns_wikidata_qid_uidx
  on public.campaigns (wikidata_qid)
  where wikidata_qid is not null;
create index campaigns_publication_title_idx
  on public.campaigns (publication_status, title);

create table public.engagements (
  id bigint generated always as identity primary key,
  campaign_id bigint references public.campaigns(id) on delete set null,
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title text not null check (length(btrim(title)) > 0),
  wikidata_qid text check (wikidata_qid is null or wikidata_qid ~ '^Q[1-9][0-9]*$'),
  start_year integer,
  end_year integer,
  date_display text,
  date_precision text not null default 'unknown'
    check (date_precision in ('exact', 'day', 'month', 'year', 'range', 'circa', 'unknown')),
  elo_eligible boolean not null default false,
  publication_status text not null default 'pending'
    check (publication_status in ('pending', 'published', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_year is null or start_year is null or end_year >= start_year)
);

create index engagements_campaign_id_idx on public.engagements (campaign_id);
create unique index engagements_wikidata_qid_uidx
  on public.engagements (wikidata_qid)
  where wikidata_qid is not null;
create index engagements_publication_year_idx
  on public.engagements (publication_status, start_year, title);

create table public.engagement_sides (
  id bigint generated always as identity primary key,
  engagement_id bigint not null references public.engagements(id) on delete cascade,
  position smallint not null check (position > 0),
  label text not null check (length(btrim(label)) > 0),
  outcome text not null default 'unknown'
    check (outcome in ('victory', 'defeat', 'draw', 'inconclusive', 'disputed', 'unknown')),
  unique (engagement_id, position)
);

create index engagement_sides_engagement_id_idx
  on public.engagement_sides (engagement_id);

create table public.participations (
  id bigint generated always as identity primary key,
  engagement_side_id bigint not null references public.engagement_sides(id) on delete cascade,
  commander_id bigint not null references public.commanders(id) on delete restrict,
  role text not null default ''::text,
  command_level text not null default 'unknown'
    check (command_level in ('strategic', 'operational', 'tactical', 'political', 'unknown')),
  responsibility numeric(5,4) check (responsibility between 0 and 1),
  autonomy numeric(5,4) check (autonomy between 0 and 1),
  joined_year integer,
  left_year integer,
  presence_status text not null default 'unknown'
    check (presence_status in ('present', 'remote', 'partial', 'absent', 'disputed', 'unknown')),
  unique (engagement_side_id, commander_id, role),
  check (left_year is null or joined_year is null or left_year >= joined_year)
);

create index participations_engagement_side_id_idx
  on public.participations (engagement_side_id);
create index participations_commander_id_idx
  on public.participations (commander_id);

create table public.result_interpretations (
  id bigint generated always as identity primary key,
  engagement_id bigint not null references public.engagements(id) on delete cascade,
  label text not null check (length(btrim(label)) > 0),
  summary text not null check (length(btrim(summary)) > 0),
  is_primary boolean not null default false,
  confidence numeric(5,4) check (confidence between 0 and 1),
  publication_status text not null default 'pending'
    check (publication_status in ('pending', 'published', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index result_interpretations_engagement_id_idx
  on public.result_interpretations (engagement_id);
create unique index result_interpretations_primary_uidx
  on public.result_interpretations (engagement_id)
  where is_primary;

create table public.sources (
  id bigint generated always as identity primary key,
  source_type text not null
    check (source_type in ('primary', 'academic', 'specialist', 'official', 'popular', 'dubious', 'dataset')),
  author_or_institution text,
  title text not null check (length(btrim(title)) > 0),
  publication text,
  publication_year integer,
  url text,
  locator text,
  accessed_on date,
  external_slug text,
  publication_status text not null default 'pending'
    check (publication_status in ('pending', 'published', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index sources_external_slug_uidx
  on public.sources (external_slug)
  where external_slug is not null;
create index sources_publication_title_idx
  on public.sources (publication_status, title);

create table public.claims (
  id bigint generated always as identity primary key,
  claim_type text not null,
  statement text not null check (length(btrim(statement)) > 0),
  confidence numeric(5,4) check (confidence between 0 and 1),
  publication_status text not null default 'pending'
    check (publication_status in ('pending', 'published', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index claims_publication_type_idx
  on public.claims (publication_status, claim_type);

create table public.claim_sources (
  claim_id bigint not null references public.claims(id) on delete cascade,
  source_id bigint not null references public.sources(id) on delete restrict,
  relation text not null default 'supports'
    check (relation in ('supports', 'contradicts', 'context')),
  locator text,
  primary key (claim_id, source_id)
);

create index claim_sources_source_id_idx on public.claim_sources (source_id);

create table public.commander_claims (
  commander_id bigint not null references public.commanders(id) on delete cascade,
  claim_id bigint not null references public.claims(id) on delete cascade,
  primary key (commander_id, claim_id)
);

create index commander_claims_claim_id_idx on public.commander_claims (claim_id);

create table public.engagement_claims (
  engagement_id bigint not null references public.engagements(id) on delete cascade,
  claim_id bigint not null references public.claims(id) on delete cascade,
  primary key (engagement_id, claim_id)
);

create index engagement_claims_claim_id_idx on public.engagement_claims (claim_id);

create table public.participation_claims (
  participation_id bigint not null references public.participations(id) on delete cascade,
  claim_id bigint not null references public.claims(id) on delete cascade,
  primary key (participation_id, claim_id)
);

create index participation_claims_claim_id_idx on public.participation_claims (claim_id);

create table public.result_interpretation_claims (
  result_interpretation_id bigint not null references public.result_interpretations(id) on delete cascade,
  claim_id bigint not null references public.claims(id) on delete cascade,
  primary key (result_interpretation_id, claim_id)
);

create index result_interpretation_claims_claim_id_idx
  on public.result_interpretation_claims (claim_id);

create table public.import_runs (
  id bigint generated always as identity primary key,
  source_dataset text not null,
  source_version text not null,
  source_url text not null,
  license_name text not null,
  attribution text not null,
  status text not null default 'importing'
    check (status in ('importing', 'staged', 'failed')),
  row_counts jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text,
  unique (source_dataset, source_version)
);

create index import_runs_status_started_idx
  on public.import_runs (status, started_at);

create table public.import_records (
  id bigint generated always as identity primary key,
  import_run_id bigint not null references public.import_runs(id) on delete cascade,
  entity_type text not null
    check (entity_type in ('battle', 'commander', 'war', 'faction', 'source')),
  external_id text not null,
  wikidata_qid text check (wikidata_qid is null or wikidata_qid ~ '^Q[1-9][0-9]*$'),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  staged_at timestamptz not null default now(),
  unique (import_run_id, entity_type, external_id)
);

create index import_records_import_run_id_idx
  on public.import_records (import_run_id);
create index import_records_entity_external_idx
  on public.import_records (entity_type, external_id);
create index import_records_wikidata_qid_idx
  on public.import_records (wikidata_qid)
  where wikidata_qid is not null;

alter table public.commanders enable row level security;
alter table public.campaigns enable row level security;
alter table public.engagements enable row level security;
alter table public.engagement_sides enable row level security;
alter table public.participations enable row level security;
alter table public.result_interpretations enable row level security;
alter table public.sources enable row level security;
alter table public.claims enable row level security;
alter table public.claim_sources enable row level security;
alter table public.commander_claims enable row level security;
alter table public.engagement_claims enable row level security;
alter table public.participation_claims enable row level security;
alter table public.result_interpretation_claims enable row level security;
alter table public.import_runs enable row level security;
alter table public.import_records enable row level security;

grant usage on schema public to anon, authenticated, service_role;
revoke all privileges on table public.commanders, public.campaigns,
  public.engagements, public.engagement_sides, public.participations,
  public.result_interpretations, public.sources, public.claims,
  public.claim_sources, public.commander_claims, public.engagement_claims,
  public.participation_claims, public.result_interpretation_claims
  from anon, authenticated;
revoke all privileges on sequence public.commanders_id_seq,
  public.campaigns_id_seq, public.engagements_id_seq,
  public.engagement_sides_id_seq, public.participations_id_seq,
  public.result_interpretations_id_seq, public.sources_id_seq,
  public.claims_id_seq from anon, authenticated;
grant select on public.commanders, public.campaigns, public.engagements,
  public.engagement_sides, public.participations, public.result_interpretations,
  public.sources, public.claims, public.claim_sources, public.commander_claims,
  public.engagement_claims, public.participation_claims,
  public.result_interpretation_claims to anon, authenticated;
revoke all privileges on table public.import_runs, public.import_records
  from anon, authenticated;
revoke all privileges on sequence public.import_runs_id_seq,
  public.import_records_id_seq from anon, authenticated;
grant select, insert, update on table public.import_runs, public.import_records
  to service_role;
grant usage, select on sequence public.import_runs_id_seq,
  public.import_records_id_seq to service_role;

create policy commanders_public_read on public.commanders for select
  using (publication_status = 'published');
create policy campaigns_public_read on public.campaigns for select
  using (publication_status = 'published');
create policy engagements_public_read on public.engagements for select
  using (
    publication_status = 'published'
    and (
      campaign_id is null
      or exists (
        select 1 from public.campaigns
        where campaigns.id = engagements.campaign_id
          and campaigns.publication_status = 'published'
      )
    )
  );
create policy engagement_sides_public_read on public.engagement_sides for select
  using (exists (
    select 1
    from public.engagements
    left join public.campaigns on campaigns.id = engagements.campaign_id
    where engagements.id = engagement_sides.engagement_id
      and engagements.publication_status = 'published'
      and (engagements.campaign_id is null or campaigns.publication_status = 'published')
  ));
create policy participations_public_read on public.participations for select
  using (exists (
    select 1
    from public.engagement_sides
    join public.engagements on engagements.id = engagement_sides.engagement_id
    left join public.campaigns on campaigns.id = engagements.campaign_id
    join public.commanders on commanders.id = participations.commander_id
    where engagement_sides.id = participations.engagement_side_id
      and engagements.publication_status = 'published'
      and (engagements.campaign_id is null or campaigns.publication_status = 'published')
      and commanders.publication_status = 'published'
  ));
create policy result_interpretations_public_read on public.result_interpretations for select
  using (
    publication_status = 'published'
    and exists (
      select 1
      from public.engagements
      left join public.campaigns on campaigns.id = engagements.campaign_id
      where engagements.id = result_interpretations.engagement_id
        and engagements.publication_status = 'published'
        and (engagements.campaign_id is null or campaigns.publication_status = 'published')
    )
  );
create policy sources_public_read on public.sources for select
  using (publication_status = 'published');
create policy claims_public_read on public.claims for select
  using (publication_status = 'published');
create policy claim_sources_public_read on public.claim_sources for select
  using (exists (
    select 1
    from public.claims
    join public.sources on sources.id = claim_sources.source_id
    where claims.id = claim_sources.claim_id
      and claims.publication_status = 'published'
      and sources.publication_status = 'published'
  ));
create policy commander_claims_public_read on public.commander_claims for select
  using (exists (
    select 1
    from public.claims
    join public.commanders on commanders.id = commander_claims.commander_id
    where claims.id = commander_claims.claim_id
      and claims.publication_status = 'published'
      and commanders.publication_status = 'published'
  ));
create policy engagement_claims_public_read on public.engagement_claims for select
  using (exists (
    select 1
    from public.claims
    join public.engagements on engagements.id = engagement_claims.engagement_id
    left join public.campaigns on campaigns.id = engagements.campaign_id
    where claims.id = engagement_claims.claim_id
      and claims.publication_status = 'published'
      and engagements.publication_status = 'published'
      and (engagements.campaign_id is null or campaigns.publication_status = 'published')
  ));
create policy participation_claims_public_read on public.participation_claims for select
  using (exists (
    select 1
    from public.claims
    join public.participations on participations.id = participation_claims.participation_id
    join public.engagement_sides on engagement_sides.id = participations.engagement_side_id
    join public.engagements on engagements.id = engagement_sides.engagement_id
    left join public.campaigns on campaigns.id = engagements.campaign_id
    join public.commanders on commanders.id = participations.commander_id
    where claims.id = participation_claims.claim_id
      and claims.publication_status = 'published'
      and engagements.publication_status = 'published'
      and (engagements.campaign_id is null or campaigns.publication_status = 'published')
      and commanders.publication_status = 'published'
  ));
create policy result_interpretation_claims_public_read
  on public.result_interpretation_claims for select
  using (exists (
    select 1
    from public.claims
    join public.result_interpretations
      on result_interpretations.id = result_interpretation_claims.result_interpretation_id
    join public.engagements on engagements.id = result_interpretations.engagement_id
    left join public.campaigns on campaigns.id = engagements.campaign_id
    where claims.id = result_interpretation_claims.claim_id
      and claims.publication_status = 'published'
      and result_interpretations.publication_status = 'published'
      and engagements.publication_status = 'published'
      and (engagements.campaign_id is null or campaigns.publication_status = 'published')
  ));
