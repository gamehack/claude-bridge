-- Covers the session -> current command foreign key for reconciliation and deletes.
create index claude_sessions_current_command_idx
  on coord.claude_sessions(current_command_id)
  where current_command_id is not null;
