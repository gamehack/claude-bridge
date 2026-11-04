import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("migration isolates tables and fails closed on crash replay", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20261104000000_claude_bridge.sql", import.meta.url), "utf8");
  assert.match(sql, /enable row level security/g);
  assert.match(sql, /security_invoker=true/g);
  assert.match(sql, /needs_reconciliation/);
  assert.match(sql, /attempts < max_attempts/);
  assert.match(sql, /from public,anon,authenticated/);
  assert.match(sql, /supabase_realtime add table coord\.claude_commands/);
});

test("systemd template uses ubuntu, Node 24, no port, and an existing environment file", async () => {
  const unit = await readFile(new URL("../deploy/claude-bridge.service.in", import.meta.url), "utf8");
  assert.match(unit, /User=ubuntu/);
  assert.match(unit, /\/opt\/nodejs-v24\.21\.0\/bin\/node/);
  assert.match(unit, /EnvironmentFile=\/etc\/kilo-bridge\/bridge\.env/);
  assert.doesNotMatch(unit, /ListenStream|Environment=SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(unit, /ProtectSystem|ProtectHome|ReadWritePaths|PrivateDevices/);
});
