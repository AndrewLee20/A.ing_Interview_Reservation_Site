create table if not exists public.slot_deletion_batches (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('cutoff_empty', 'all', 'day_empty', 'day_all')),
  label text,
  created_at timestamptz not null default now(),
  restored_at timestamptz,
  slot_count integer not null check (slot_count >= 0),
  reservation_count integer not null check (reservation_count >= 0),
  slots jsonb not null check (jsonb_typeof(slots) = 'array'),
  reservations jsonb not null check (jsonb_typeof(reservations) = 'array')
);

create index if not exists slot_deletion_batches_created_at_idx
  on public.slot_deletion_batches (created_at desc);

alter table public.slot_deletion_batches enable row level security;

revoke all on table public.slot_deletion_batches from public, anon, authenticated;
grant select, insert, update, delete on table public.slot_deletion_batches to service_role;

create or replace function public.archive_and_delete_interview_slots(
  p_slot_ids uuid[],
  p_kind text,
  p_label text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_slots jsonb;
  v_reservations jsonb;
  v_batch_id uuid;
  v_slot_count integer;
  v_reservation_count integer;
begin
  if p_kind not in ('cutoff_empty', 'all', 'day_empty', 'day_all') then
    raise exception 'unsupported deletion kind: %', p_kind using errcode = '22023';
  end if;

  perform 1
  from public.interview_slots s
  where s.id = any(coalesce(p_slot_ids, array[]::uuid[]))
  order by s.id
  for update;

  perform 1
  from public.reservations r
  where r.slot_id = any(coalesce(p_slot_ids, array[]::uuid[]))
  order by r.id
  for update;

  select coalesce(jsonb_agg(to_jsonb(s) order by s.starts_at, s.id), '[]'::jsonb)
    into v_slots
  from public.interview_slots s
  where s.id = any(coalesce(p_slot_ids, array[]::uuid[]));

  v_slot_count := jsonb_array_length(v_slots);

  if v_slot_count = 0 then
    return jsonb_build_object(
      'batchId', null,
      'deletedCount', 0,
      'reservationCount', 0
    );
  end if;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at, r.id), '[]'::jsonb)
    into v_reservations
  from public.reservations r
  where r.slot_id in (
    select (item ->> 'id')::uuid
    from jsonb_array_elements(v_slots) as item
  );

  v_reservation_count := jsonb_array_length(v_reservations);

  insert into public.slot_deletion_batches (
    kind, label, slot_count, reservation_count, slots, reservations
  )
  values (
    p_kind, nullif(btrim(p_label), ''), v_slot_count, v_reservation_count,
    v_slots, v_reservations
  )
  returning id into v_batch_id;

  delete from public.interview_slots s
  where s.id in (
    select (item ->> 'id')::uuid
    from jsonb_array_elements(v_slots) as item
  );

  return jsonb_build_object(
    'batchId', v_batch_id,
    'deletedCount', v_slot_count,
    'reservationCount', v_reservation_count
  );
end;
$function$;

revoke all on function public.archive_and_delete_interview_slots(uuid[], text, text)
  from public, anon, authenticated;
grant execute on function public.archive_and_delete_interview_slots(uuid[], text, text)
  to service_role;

create or replace function public.restore_interview_slot_deletion(
  p_batch_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_batch public.slot_deletion_batches%rowtype;
begin
  select *
    into v_batch
  from public.slot_deletion_batches
  where id = p_batch_id
  for update;

  if not found then
    raise exception 'deletion batch not found' using errcode = 'P0002';
  end if;

  if v_batch.restored_at is not null then
    raise exception 'deletion batch already restored' using errcode = '23505';
  end if;

  insert into public.interview_slots (
    id, starts_at, ends_at, created_at, note, location
  )
  select x.id, x.starts_at, x.ends_at, x.created_at, x.note, x.location
  from jsonb_to_recordset(v_batch.slots) as x(
    id uuid,
    starts_at timestamptz,
    ends_at timestamptz,
    created_at timestamptz,
    note text,
    location text
  );

  insert into public.reservations (
    id, applicant_id, slot_id, created_at, updated_at
  )
  select x.id, x.applicant_id, x.slot_id, x.created_at, x.updated_at
  from jsonb_to_recordset(v_batch.reservations) as x(
    id uuid,
    applicant_id uuid,
    slot_id uuid,
    created_at timestamptz,
    updated_at timestamptz
  );

  update public.slot_deletion_batches
  set restored_at = now()
  where id = p_batch_id;

  return jsonb_build_object(
    'batchId', p_batch_id,
    'restoredSlotCount', v_batch.slot_count,
    'restoredReservationCount', v_batch.reservation_count
  );
end;
$function$;

revoke all on function public.restore_interview_slot_deletion(uuid)
  from public, anon, authenticated;
grant execute on function public.restore_interview_slot_deletion(uuid)
  to service_role;
