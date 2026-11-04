# ChatGPT operations

Use the existing Supabase SQL management connector against private `coord` tables. Never send these
statements through an anon/authenticated PostgREST client. Keep one idempotency UUID for retries of
the same intended command; query by that UUID after any connector timeout.

## Health check

~~~sql
insert into coord.claude_commands (idempotency_key,command_type,payload)
values ('PUT-NEW-UUID-HERE','health_check','{}'::jsonb)
returning id,status;
~~~

The terminal result includes the installed CLI version and active SDK turn count, never credentials.

## Create a session

There is no allowlist. `directory` must be absolute and the `ubuntu` service user must be able to
access it. `workspace_key` is an informational label.

~~~sql
insert into coord.claude_commands (idempotency_key,command_type,payload)
values (
  'PUT-NEW-UUID-HERE',
  'create_session',
  jsonb_build_object('workspace_key','host','directory','/home/ubuntu','title','Claude work')
)
returning id,status;
~~~

Read `result.session_id` after the command succeeds.

## Start and resume turns

~~~sql
insert into coord.claude_commands (idempotency_key,command_type,session_id,payload)
values (
  'PUT-NEW-UUID-HERE',
  'start_turn',
  'PUT-SESSION-UUID-HERE',
  jsonb_build_object('text','Reply with exactly: FIRST_OK')
)
returning id,status;
~~~

The first turn persists `claude_sessions.claude_session_id`. Every later turn supplies that value to
the SDK `resume` option. A completed command stores `final_message`, model, usage, model usage, cost,
duration, stop reason, and the number of omitted stream delta events in `result`.

Use a new idempotency UUID and the same bridge session UUID for the next message:

~~~sql
insert into coord.claude_commands (idempotency_key,command_type,session_id,payload)
values (
  'PUT-NEW-UUID-HERE',
  'start_turn',
  'PUT-SAME-SESSION-UUID-HERE',
  jsonb_build_object('text','What exact token did you return in the previous turn?')
)
returning id,status;
~~~

## Observe state and events

~~~sql
select id,command_type,status,result,error,created_at,started_at,dispatched_at,finished_at
from coord.claude_commands
where session_id='PUT-SESSION-UUID-HERE'
order by created_at desc limit 20;
~~~

~~~sql
select created_at,event_type,payload
from coord.claude_events
where session_id='PUT-SESSION-UUID-HERE'
order by id desc limit 80;
~~~

Raw token deltas are intentionally not persisted. Do not retry `running`, `awaiting_approval`, or
`needs_reconciliation` commands.

## Tool approvals

The SDK callback stays blocked without a deadline. A timeout or absent operator never approves.

~~~sql
select id,session_id,command_id,tool_name,detail,status,created_at
from coord.claude_approvals
where status='pending'
order by created_at;
~~~

After reviewing `detail`, submit `once`, `always`, or `reject`:

~~~sql
insert into coord.claude_commands (idempotency_key,command_type,session_id,payload)
values (
  'PUT-NEW-UUID-HERE',
  'approval_decision',
  'PUT-SESSION-UUID-HERE',
  jsonb_build_object('approval_id','PUT-APPROVAL-UUID-HERE','decision','once')
)
returning id,status;
~~~

`always` applies only the permission updates proposed by Claude Code. After a worker restart, pending
rows become `orphaned` and cannot be decided because their live SDK callback no longer exists.

## Interrupt

~~~sql
insert into coord.claude_commands (idempotency_key,command_type,session_id,payload)
values ('PUT-NEW-UUID-HERE','interrupt_turn','PUT-SESSION-UUID-HERE','{}'::jsonb)
returning id,status;
~~~

The bridge aborts the `AbortController`, closes the SDK query, waits for it to settle, then succeeds
the interrupt command. The original turn becomes `cancelled`.

## Crash reconciliation

Claimed commands have a lease and one attempt. An expired claim becomes `needs_reconciliation`.
On startup, `running` and `awaiting_approval` commands also become `needs_reconciliation`; the bridge
does not resume their prompt automatically because a tool or API side effect may already have happened.
An operator must inspect the target system and event trail before issuing a distinct new command.
