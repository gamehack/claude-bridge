# Claude Bridge

Claude Bridge is a small, self-hosted worker that turns durable Supabase commands into real
[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) turns. It is an
independent MIT-licensed service: no HTTP listener, no extra database, no Claude daemon, and no
changes to Codex Bridge or Kilo Bridge.

The worker consumes `create_session`, `start_turn`, `interrupt_turn`, `approval_decision`, and
`health_check`. Claude's SDK session ID is persisted and passed back through `resume` for genuine
multi-turn conversations. Tool permission requests block in `canUseTool` until a human submits an
explicit decision. An interrupt aborts and closes the live SDK query.

## Safety and durability

- Private `coord.claude_*` tables use RLS with no anon/authenticated policies.
- PostgREST objects are security-invoker views/RPCs granted only to `service_role`.
- Commands require a unique UUID idempotency key and are claimed atomically with a lease.
- Realtime is only a wake-up hint; a 15-second poll is the recovery path.
- A crash after dispatch produces `needs_reconciliation`. External work is never auto-replayed.
- SDK token deltas are counted but not stored. Persisted events and errors are sanitized and bounded.
- The bridge never changes the configured provider, model, credentials, or Claude user settings.

## Requirements

- Ubuntu service user `ubuntu`
- Node.js 24+
- Claude Code CLI and `@anthropic-ai/claude-agent-sdk` 0.3.318
- Existing Supabase project with the private `coord` schema and a server-side `service_role` key

## Install

~~~bash
git clone https://github.com/gamehack/claude-bridge /opt/claude-bridge
cd /opt/claude-bridge
PATH=/opt/nodejs-v24.21.0/bin:$PATH npm ci
PATH=/opt/nodejs-v24.21.0/bin:$PATH npm test
~~~

Apply `supabase/migrations/20261104000000_claude_bridge.sql` through the existing Supabase SQL
management channel. Do not add `coord` to PostgREST's exposed schemas.

The supplied service template runs as the existing `ubuntu` account and opens no port. Its default
`EnvironmentFile` is `/etc/kilo-bridge/bridge.env`, reusing the already provisioned server-side
Supabase variables without copying their values into this repository:

~~~bash
cd /opt/claude-bridge
NODE_BIN=/opt/nodejs-v24.21.0/bin/node \
  ENV_FILE=/etc/kilo-bridge/bridge.env \
  bash deploy/install-systemd.sh
~~~

See [ChatGPT operations](docs/chatgpt-operations.md) for the command protocol.

## CLI diagnostic fallback

SDK execution is primary. The diagnostic command deliberately never runs automatically after an
uncertain SDK failure, because doing so could duplicate side effects. An operator can run a bounded
Claude CLI JSON check explicitly:

~~~bash
CLAUDE_DIAGNOSTIC_PROMPT='Reply with exactly BRIDGE_OK.' npm run diagnose
~~~

Set `CLAUDE_DIAGNOSTIC_SESSION_ID` to diagnose `--resume`. Output passes through the same sanitizer.

## Development

~~~bash
npm ci
npm run check
npm test
~~~

Environment variables are documented in `.env.example`. `workspace_key` is only a label; every
session directory must be an absolute path and access is governed solely by Ubuntu permissions.

## License

MIT
