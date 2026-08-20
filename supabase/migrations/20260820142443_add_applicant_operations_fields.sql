alter table public.applicants
  add column if not exists attendance_status text not null default 'pending',
  add column if not exists result_status text not null default 'pending',
  add column if not exists admin_note text,
  add column if not exists admin_updated_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'applicants_attendance_status_check'
      and conrelid = 'public.applicants'::regclass
  ) then
    alter table public.applicants
      add constraint applicants_attendance_status_check
      check (attendance_status in ('pending','attended','absent'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'applicants_result_status_check'
      and conrelid = 'public.applicants'::regclass
  ) then
    alter table public.applicants
      add constraint applicants_result_status_check
      check (result_status in ('pending','passed','rejected','waitlisted'));
  end if;
end
$$;
