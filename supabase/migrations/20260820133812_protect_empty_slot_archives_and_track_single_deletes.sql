alter table public.slot_deletion_batches
  drop constraint if exists slot_deletion_batches_kind_check;

alter table public.slot_deletion_batches
  add constraint slot_deletion_batches_kind_check
  check (kind in ('cutoff_empty', 'all', 'day_empty', 'day_all', 'single'));

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
  if p_kind not in ('cutoff_empty', 'all', 'day_empty', 'day_all', 'single') then
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
  where s.id = any(coalesce(p_slot_ids, array[]::uuid[]))
    and (
      p_kind not in ('cutoff_empty', 'day_empty')
      or not exists (
        select 1 from public.reservations r where r.slot_id = s.id
      )
    );

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
