-- Claude Bridge MVP. Independent from every existing coord.codex_* and coord.kilo_* object.
-- The private coord schema remains the ChatGPT SQL connector surface. PostgREST gets only
-- service_role-only security-invoker views and two narrowly scoped RPC wrappers.

create schema if not exists coord;

create table coord.claude_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 160),
  workspace_key text not null default 'host' check (workspace_key ~ '^[a-z][a-z0-9_-]{1,63}$'),
  directory text not null check (left(directory, 1) = '/' and octet_length(directory) <= 4096),
  claude_session_id text unique,
  status text not null default 'ready'
    check (status in ('ready','running','awaiting_approval','error','needs_reconciliation','archived')),
  current_command_id uuid,
  model text,
  last_turn_status text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table coord.claude_commands (
  id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  command_type text not null
    check (command_type in ('create_session','start_turn','interrupt_turn','approval_decision','health_check')),
  session_id uuid references coord.claude_sessions(id) on delete restrict,
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 262144),
  status text not null default 'queued'
    check (status in ('queued','claimed','running','awaiting_approval','succeeded','failed','cancelled','needs_reconciliation')),
  requested_by text not null default 'chatgpt' check (length(btrim(requested_by)) between 1 and 120),
  worker_id text,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts smallint not null default 1 check (max_attempts = 1),
  result jsonb not null default '{}'::jsonb
    check (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 524288),
  error jsonb check (error is null or (jsonb_typeof(error) = 'object' and octet_length(error::text) <= 65536)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  claimed_at timestamptz,
  started_at timestamptz,
  dispatched_at timestamptz,
  finished_at timestamptz,
  check (command_type in ('create_session','health_check') or session_id is not null)
);

alter table coord.claude_sessions add constraint claude_sessions_current_command_fk
  foreign key (current_command_id) references coord.claude_commands(id) on delete set null;

create table coord.claude_events (
  id bigint generated always as identity primary key,
  command_id uuid references coord.claude_commands(id) on delete set null,
  session_id uuid references coord.claude_sessions(id) on delete set null,
  event_type text not null check (length(btrim(event_type)) between 3 and 100),
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  created_at timestamptz not null default now()
);

create table coord.claude_approvals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references coord.claude_sessions(id) on delete cascade,
  command_id uuid not null references coord.claude_commands(id) on delete restrict,
  sdk_request_id text not null unique,
  tool_use_id text not null,
  tool_name text not null check (length(btrim(tool_name)) between 1 and 200),
  detail jsonb not null default '{}'::jsonb
    check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 65536),
  status text not null default 'pending' check (status in ('pending','approved','rejected','orphaned')),
  decision text check (decision is null or decision in ('once','always','reject')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (command_id, tool_use_id)
);

create index claude_commands_queue_idx on coord.claude_commands(created_at) where status = 'queued';
create index claude_commands_session_idx on coord.claude_commands(session_id,created_at desc);
create index claude_sessions_status_idx on coord.claude_sessions(status,updated_at);
create index claude_events_session_idx on coord.claude_events(session_id,id desc);
create index claude_events_command_idx on coord.claude_events(command_id,id desc);
create index claude_approvals_pending_idx on coord.claude_approvals(session_id,created_at) where status = 'pending';

alter table coord.claude_sessions enable row level security;
alter table coord.claude_commands enable row level security;
alter table coord.claude_events enable row level security;
alter table coord.claude_approvals enable row level security;

revoke all on table coord.claude_sessions,coord.claude_commands,coord.claude_events,coord.claude_approvals
  from public,anon,authenticated;
grant usage on schema coord to service_role;
grant select,insert,update,delete on table
  coord.claude_sessions,coord.claude_commands,coord.claude_events,coord.claude_approvals to service_role;
grant usage,select on sequence coord.claude_events_id_seq to service_role;

create function coord.claude_claim_next_command(p_worker_id text,p_lease_seconds integer default 60)
returns setof coord.claude_commands
language plpgsql security definer
set search_path = pg_catalog,coord,pg_temp
as $$
declare v_command coord.claude_commands%rowtype;
begin
  if p_worker_id is null or length(btrim(p_worker_id)) < 1 or length(p_worker_id) > 180 then
    raise exception 'invalid worker id';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 15 or p_lease_seconds > 300 then
    raise exception 'lease must be between 15 and 300 seconds';
  end if;
  with candidate as (
    select id from coord.claude_commands
    where status = 'queued' and attempts < max_attempts
    order by case command_type when 'interrupt_turn' then 0 when 'approval_decision' then 1 else 2 end,
      created_at asc
    for update skip locked limit 1
  )
  update coord.claude_commands command
  set status='claimed',worker_id=p_worker_id,claimed_at=clock_timestamp(),
      lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      attempts=command.attempts+1,updated_at=clock_timestamp()
  from candidate where command.id=candidate.id returning command.* into v_command;
  if found then return next v_command; end if;
end;
$$;

revoke all on function coord.claude_claim_next_command(text,integer) from public,anon,authenticated;
grant execute on function coord.claude_claim_next_command(text,integer) to service_role;

-- Called exactly once on worker startup. Running work cannot be safely replayed because an
-- external tool may already have taken effect. Pending approvals lose their live callback.
create function coord.claude_reconcile_orphaned_work()
returns table(command_id uuid,session_id uuid)
language plpgsql security definer
set search_path = pg_catalog,coord,pg_temp
as $$
begin
  update coord.claude_approvals
  set status='orphaned',resolved_at=clock_timestamp()
  where status='pending';

  return query
  with changed as (
    update coord.claude_commands
    set status='needs_reconciliation',
        error=jsonb_build_object('name','WorkerRestart','message','Live Claude SDK process was lost; command was not replayed'),
        lease_expires_at=null,finished_at=clock_timestamp(),updated_at=clock_timestamp()
    where status in ('running','awaiting_approval')
    returning id,coord.claude_commands.session_id
  ), sessions as (
    update coord.claude_sessions s
    set status='needs_reconciliation',current_command_id=null,updated_at=clock_timestamp()
    where s.id in (select c.session_id from changed c where c.session_id is not null)
    returning s.id
  )
  select changed.id,changed.session_id from changed;
end;
$$;

revoke all on function coord.claude_reconcile_orphaned_work() from public,anon,authenticated;
grant execute on function coord.claude_reconcile_orphaned_work() to service_role;

create view public.claude_sessions with (security_invoker=true) as select * from coord.claude_sessions;
create view public.claude_commands with (security_invoker=true) as select * from coord.claude_commands;
create view public.claude_events with (security_invoker=true) as select * from coord.claude_events;
create view public.claude_approvals with (security_invoker=true) as select * from coord.claude_approvals;

revoke all on table public.claude_sessions,public.claude_commands,public.claude_events,public.claude_approvals
  from public,anon,authenticated;
grant select,insert,update,delete on table
  public.claude_sessions,public.claude_commands,public.claude_events,public.claude_approvals to service_role;

create function public.claude_claim_next_command(p_worker_id text,p_lease_seconds integer default 60)
returns setof public.claude_commands language sql security invoker set search_path=pg_catalog,pg_temp
as $$ select * from coord.claude_claim_next_command(p_worker_id,p_lease_seconds); $$;
revoke all on function public.claude_claim_next_command(text,integer) from public,anon,authenticated;
grant execute on function public.claude_claim_next_command(text,integer) to service_role;

create function public.claude_reconcile_orphaned_work()
returns table(command_id uuid,session_id uuid) language sql security invoker set search_path=pg_catalog,pg_temp
as $$ select * from coord.claude_reconcile_orphaned_work(); $$;
revoke all on function public.claude_reconcile_orphaned_work() from public,anon,authenticated;
grant execute on function public.claude_reconcile_orphaned_work() to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname='supabase_realtime'
       and schemaname='coord' and tablename='claude_commands') then
    alter publication supabase_realtime add table coord.claude_commands;
  end if;
end;
$$;

comment on table coord.claude_commands is 'Durable Claude Agent SDK commands; dispatched work is never automatically replayed.';
comment on table coord.claude_events is 'Sanitized and bounded lifecycle events; raw token deltas are intentionally omitted.';
comment on table coord.claude_approvals is 'Human tool approvals tied to a live SDK callback; no automatic approval or timeout approval.';
notify pgrst,'reload schema';
