-- Append a researched opposing side while preserving the original ordered rows.
create function curation_private.valid_participant_extension(raw_payload jsonb, m jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare originals jsonb := coalesce(raw_payload->'commanders','[]'::jsonb);
  c jsonb; i integer := 0; first_side text;
begin
  if not curation_private.valid_participants(m) then return false; end if;
  if jsonb_typeof(originals) is distinct from 'array' then return false; end if;
  if jsonb_array_length(originals)=0 then return true; end if;
  if jsonb_array_length(m->'participants') <= jsonb_array_length(originals) then return false; end if;
  for c in select value from jsonb_array_elements(originals) loop
    if jsonb_typeof(c->'slug') is distinct from 'string' or nullif(c->>'slug','') is null
      or jsonb_typeof(c->'side') is distinct from 'string' or nullif(btrim(c->>'side'),'') is null
      or c->>'side' is distinct from btrim(c->>'side') then return false; end if;
    if i=0 then first_side := c->>'side'; end if;
    if c->>'side' is distinct from first_side
      or m->'participants'->i->'ref'->>'id' is distinct from 'war-atlas:'||(c->>'slug')
      or m->'participants'->i->>'side' is distinct from c->>'side' then return false; end if;
    i := i+1;
  end loop;
  -- Every appended row must supply the absent opposing side.
  while i < jsonb_array_length(m->'participants') loop
    if m->'participants'->i->>'side' = first_side then return false; end if;
    i := i+1;
  end loop;
  return true;
end;
$$;
revoke all on function curation_private.valid_participant_extension(jsonb,jsonb) from public,anon,authenticated;

create or replace function curation_private.effective_battle_commanders(raw_payload jsonb, m jsonb, revision text)
returns jsonb language plpgsql set search_path = '' as $$
declare result jsonb := '[]'; p jsonb; cid bigint; person public.commanders; imported jsonb; ref text; original_count integer; proposal_index integer := 0;
begin
  if not (m ? 'participants') then return raw_payload->'commanders'; end if;
  if not curation_private.valid_participants(m) then raise exception 'invalid participant proposal'; end if;
  if not curation_private.valid_participant_extension(raw_payload,m) then
    raise exception 'participant proposal cannot overwrite original commanders';
  end if;
  original_count := jsonb_array_length(coalesce(raw_payload->'commanders','[]'::jsonb));
  result := coalesce(raw_payload->'commanders','[]'::jsonb);
  for p in select value from jsonb_array_elements(m->'participants') loop
    proposal_index := proposal_index + 1;
    if proposal_index <= original_count then continue; end if;
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

