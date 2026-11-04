import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeClient, summarizeSdkMessage } from "../src/claude-client.js";

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
