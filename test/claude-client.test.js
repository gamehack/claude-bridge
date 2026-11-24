import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeClient, summarizeSdkMessage, claudeEnvironment } from "../src/claude-client.js";

test("SDK query uses cwd, resume, default permissions, callback, and configured CLI", () => {
  let captured;
  const query = (params) => { captured = params; return {}; };
  const client = new ClaudeClient({ claudeExecutable: "/home/ubuntu/.local/bin/claude" }, { query });
  const callback = async () => ({ behavior: "deny", message: "no" });
  const controller = new AbortController();
  client.startTurn({ text: "hello", directory: "/opt/project", resume: "sdk-session",
    abortController: controller, canUseTool: callback });
  assert.equal(captured.prompt, "hello");
  assert.equal(captured.options.cwd, "/opt/project");
  assert.equal(captured.options.resume, "sdk-session");
  assert.equal(captured.options.permissionMode, "default");
  assert.equal(captured.options.canUseTool, callback);
  assert.equal(captured.options.pathToClaudeCodeExecutable, "/home/ubuntu/.local/bin/claude");
  assert.equal(captured.options.includePartialMessages, true);
});

test("result summaries retain bounded result and usage", () => {
  const summary = summarizeSdkMessage({ type: "result", subtype: "success", session_id: "s",
    result: "abcdef", usage: { input_tokens: 1 }, modelUsage: { model: { inputTokens: 1 } }, is_error: false }, 3);
  assert.equal(summary.result, "abc");
  assert.equal(summary.result_truncated, true);
  assert.equal(summary.usage.input_tokens, 1);
});

test("explicit bypass mode passes the required SDK opt-in", () => {
  let captured;
  const client = new ClaudeClient({ claudeExecutable: "/bin/true", permissionMode: "bypassPermissions" },
    { query: (params) => { captured = params; return {}; } });
  client.startTurn({ text: "test", directory: "/tmp", abortController: new AbortController() });
  assert.equal(captured.options.permissionMode, "bypassPermissions");
  assert.equal(captured.options.allowDangerouslySkipPermissions, true);
});

test("child environment does not inherit the bridge database secret or its alias", () => {
  const env = claudeEnvironment({ supabaseServiceRoleKey: "test-secret" }, {
    SUPABASE_SERVICE_ROLE_KEY: "test-secret", SUPABASE_SECRET_KEY: "other-secret",
    OTHER_ALIAS: "test-secret", ANTHROPIC_API_KEY: "provider-key", PATH: "/bin"
  });
  assert.deepEqual(env, { ANTHROPIC_API_KEY: "provider-key", PATH: "/bin" });
});
