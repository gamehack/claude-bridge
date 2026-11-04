import test from "node:test";
import assert from "node:assert/strict";
import { validateCommand } from "../src/commands.js";

const config = { defaultDirectory: "/home/ubuntu" };
const sessionId = "123e4567-e89b-42d3-a456-426614174000";

test("accepts any absolute session directory without an allowlist", () => {
  assert.deepEqual(validateCommand({ command_type: "create_session",
    payload: { title: "Work", directory: "/opt/a-project", workspace_key: "host" } }, config),
  { title: "Work", directory: "/opt/a-project", workspaceKey: "host" });
});

test("rejects relative directories", () => {
  assert.throws(() => validateCommand({ command_type: "create_session",
    payload: { directory: "relative" } }, config), /absolute/);
});

test("validates turn and approval commands", () => {
  assert.equal(validateCommand({ command_type: "start_turn", session_id: sessionId,
    payload: { text: "Continue." } }, config).text, "Continue.");
  assert.equal(validateCommand({ command_type: "approval_decision", session_id: sessionId,
    payload: { approval_id: "123e4567-e89b-42d3-a456-426614174001", decision: "reject" } }, config).decision, "reject");
});

test("rejects an implicit approval mode", () => {
  assert.throws(() => validateCommand({ command_type: "approval_decision", session_id: sessionId,
    payload: { approval_id: "123e4567-e89b-42d3-a456-426614174001", decision: "auto" } }, config), /decision/);
});
