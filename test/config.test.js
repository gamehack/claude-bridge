import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const env = (patch = {}) => ({ SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "server-test-key", CLAUDE_EXECUTABLE: "/bin/true", ...patch });

test("loads Node worker settings", () => {
  const config = loadConfig(env());
  assert.equal(config.defaultDirectory, "/home/ubuntu");
  assert.equal(config.pollIntervalMs, 15000);
  assert.equal(config.permissionMode, "default");
  assert.equal(config.approvalPolicy, "manual");
});

test("rejects insecure Supabase URLs", () => {
  assert.throws(() => loadConfig(env({ SUPABASE_URL: "http://example.test" })), /HTTPS/);
});

test("rejects relative executable and cwd paths", () => {
  assert.throws(() => loadConfig(env({ CLAUDE_EXECUTABLE: "claude" }), { checkExecutable: false }), /absolute/);
  assert.throws(() => loadConfig(env({ CLAUDE_DEFAULT_DIRECTORY: "project" })), /absolute/);
});

test("explicit unattended mode and policy are validated", () => {
  const config = loadConfig(env({ CLAUDE_PERMISSION_MODE: "bypassPermissions", BRIDGE_APPROVAL_POLICY: "always" }));
  assert.equal(config.permissionMode, "bypassPermissions");
  assert.equal(config.approvalPolicy, "always");
  assert.throws(() => loadConfig(env({ CLAUDE_PERMISSION_MODE: "typo" })), /CLAUDE_PERMISSION_MODE/);
  assert.throws(() => loadConfig(env({ BRIDGE_APPROVAL_POLICY: "typo" })), /BRIDGE_APPROVAL_POLICY/);
});
