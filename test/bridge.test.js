import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Bridge } from "../src/bridge.js";

const logger = Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, () => {}]));
const config = { defaultDirectory: "/home/ubuntu", bridgeId: "test", claimLeaseSeconds: 60,
  pollIntervalMs: 10000, maxEventChars: 12000, supabaseServiceRoleKey: "known-test-secret" };

class MemoryStore {
  constructor() { this.sessions = new Map(); this.commands = new Map(); this.approvals = new Map(); this.events = []; }
  async createSession(values) { const row = { id: randomUUID(), claude_session_id: null, model: null,
    current_command_id: null, ...values }; this.sessions.set(row.id, row); return row; }
  async session(id) { return this.sessions.get(id) || null; }
  async updateSession(id, values) { const row = { ...this.sessions.get(id), ...values }; this.sessions.set(id, row); return row; }
  async updateCommand(id, values) { const row = { ...this.commands.get(id), id, ...values }; this.commands.set(id, row); return row; }
  async command(id) { return this.commands.get(id) || null; }
  async event(values) { this.events.push(values); }
  async createApproval(values) { const row = { id: randomUUID(), ...values }; this.approvals.set(row.id, row); return row; }
  async approval(id) { return this.approvals.get(id) || null; }
  async updateApproval(id, values) { const row = { ...this.approvals.get(id), ...values }; this.approvals.set(id, row); return row; }
}

function iterable(generator, close = () => {}) {
  return { [Symbol.asyncIterator]: generator, close };
}

async function eventually(predicate, message = "condition") {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

async function makeSession(bridge, store) {
  const command = { id: randomUUID(), command_type: "create_session", payload: {
    title: "Test", directory: "/home/ubuntu", workspace_key: "host" } };
  store.commands.set(command.id, command);
  await bridge.createSession(command, { title: "Test", directory: "/home/ubuntu", workspaceKey: "host" });
  return store.sessions.get(store.commands.get(command.id).session_id);
}

test("persists SDK session, model, usage, final result and resumes the next turn", async () => {
  const store = new MemoryStore();
  const calls = [];
  const claude = { startTurn(params) {
    calls.push(params);
    return iterable(async function* () {
      yield { type: "system", subtype: "init", session_id: "claude-sdk-session", model: "configured-model",
        cwd: params.directory, claude_code_version: "2.1.316", permissionMode: "default" };
      yield { type: "stream_event", session_id: "claude-sdk-session", event: { type: "content_block_delta" } };
      yield { type: "result", subtype: "success", session_id: "claude-sdk-session", is_error: false,
        result: calls.length === 1 ? "FIRST_OK" : "SECOND_OK", usage: { input_tokens: 2 },
        modelUsage: { "configured-model": { inputTokens: 2 } }, total_cost_usd: 0.01,
        duration_ms: 10, num_turns: 1, stop_reason: "end_turn" };
    });
  } };
  const bridge = new Bridge(config, store, claude, logger);
  const session = await makeSession(bridge, store);

  for (const text of ["first", "second"]) {
    const command = { id: randomUUID(), command_type: "start_turn", session_id: session.id, payload: { text } };
    store.commands.set(command.id, command);
    await bridge.startTurn(command, { text });
    await eventually(() => !bridge.active.has(session.id), "turn completion");
    assert.equal(store.commands.get(command.id).status, "succeeded");
  }
  assert.equal(calls[0].resume, undefined);
  assert.equal(calls[1].resume, "claude-sdk-session");
  assert.equal(store.sessions.get(session.id).model, "configured-model");
  assert.equal(store.commands.get([...store.commands.keys()].at(-1)).result.final_message, "SECOND_OK");
});

test("canUseTool blocks until an explicit human decision", async () => {
  const store = new MemoryStore();
  let permissionResult;
  const claude = { startTurn(params) {
    return iterable(async function* () {
      yield { type: "system", subtype: "init", session_id: "approval-session", model: "model" };
      permissionResult = await params.canUseTool("Bash", { command: "touch /tmp/test" }, {
        signal: params.abortController.signal, requestId: "request-1", toolUseID: "tool-1",
        suggestions: [{ type: "addRules", rules: [], behavior: "allow", destination: "session" }]
      });
      yield { type: "result", subtype: "success", session_id: "approval-session", is_error: false,
        result: "done", usage: {}, modelUsage: {}, total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
    });
  } };
  const bridge = new Bridge(config, store, claude, logger);
  const session = await makeSession(bridge, store);
  const turn = { id: randomUUID(), command_type: "start_turn", session_id: session.id, payload: { text: "tool" } };
  store.commands.set(turn.id, turn);
  await bridge.startTurn(turn, { text: "tool" });
  await eventually(() => store.approvals.size === 1, "approval request");
  assert.equal(permissionResult, undefined);
  assert.equal(store.sessions.get(session.id).status, "awaiting_approval");

  const approvalId = [...store.approvals.keys()][0];
  const decision = { id: randomUUID(), command_type: "approval_decision", session_id: session.id,
    payload: { approval_id: approvalId, decision: "once" } };
  store.commands.set(decision.id, decision);
  await bridge.approvalDecision(decision, { approvalId, decision: "once" });
  await eventually(() => !bridge.active.has(session.id), "approved turn completion");
  assert.equal(permissionResult.behavior, "allow");
  assert.equal(store.approvals.get(approvalId).status, "approved");
});

test("interrupt aborts and closes the real live SDK query", async () => {
  const store = new MemoryStore();
  let closed = false;
  const claude = { startTurn(params) {
    return iterable(async function* () {
      yield { type: "system", subtype: "init", session_id: "interrupt-session", model: "model" };
      await params.canUseTool("Bash", { command: "sleep 30" }, {
        signal: params.abortController.signal, requestId: "interrupt-request", toolUseID: "interrupt-tool"
      });
    }, () => { closed = true; });
  } };
  const bridge = new Bridge(config, store, claude, logger);
  const session = await makeSession(bridge, store);
  const turn = { id: randomUUID(), command_type: "start_turn", session_id: session.id, payload: { text: "wait" } };
  store.commands.set(turn.id, turn);
  await bridge.startTurn(turn, { text: "wait" });
  await eventually(() => store.approvals.size === 1, "pending SDK approval");

  const interrupt = { id: randomUUID(), command_type: "interrupt_turn", session_id: session.id, payload: {} };
  store.commands.set(interrupt.id, interrupt);
  await bridge.interruptTurn(interrupt);
  assert.equal(closed, true);
  assert.equal(store.commands.get(turn.id).status, "cancelled");
  assert.equal(store.commands.get(interrupt.id).status, "succeeded");
  assert.equal([...store.approvals.values()][0].status, "orphaned");
});

function approvalFixture(overrides = {}) {
  const store = new MemoryStore();
  const bridge = new Bridge({ ...config, approvalPolicy: "always" }, store, {}, logger);
  const abortController = new AbortController();
  const active = { session: { id: randomUUID() }, command: { id: randomUUID() }, abortController,
    approvals: new Map() };
  const options = { signal: abortController.signal, requestId: randomUUID(), toolUseID: randomUUID(),
    suggestions: [{ type: "addRules", rules: [], behavior: "allow", destination: "session" }], ...overrides };
  return { store, bridge, active, options };
}

test("always auto-approves a callback, audits the decision and never waits", async () => {
  const { store, bridge, active, options } = approvalFixture();
  const input = { command: "touch /tmp/claude-bridge-test" };
  const result = await bridge.requestApproval(active, "Bash", input, options);
  assert.deepEqual(result, { behavior: "allow", updatedInput: input,
    updatedPermissions: options.suggestions, toolUseID: options.toolUseID });
  const row = [...store.approvals.values()][0];
  assert.equal(row.status, "approved");
  assert.equal(row.decision, "always");
  assert.equal(row.detail.decision_source, "bridge_auto");
  assert.equal(active.approvals.size, 0);
  assert.equal(store.events[0].payload.source, "bridge_auto");
  assert.equal(store.commands.size, 0);
});

test("always does not fabricate answers to AskUserQuestion", async () => {
  const { store, bridge, active, options } = approvalFixture();
  const result = await bridge.requestApproval(active, "AskUserQuestion", { questions: [] }, options);
  assert.equal(result.behavior, "deny");
  assert.equal([...store.approvals.values()][0].decision, "reject");
});

test("auto approval fails closed after an interrupt during audit", async () => {
  const { store, bridge, active, options } = approvalFixture();
  const event = store.event.bind(store);
  store.event = async (data) => { await event(data); active.abortController.abort(); };
  const result = await bridge.requestApproval(active, "Bash", { command: "true" }, options);
  assert.equal(result.behavior, "deny");
  assert.equal(result.interrupt, true);
  assert.equal([...store.approvals.values()][0].status, "orphaned");
});

test("auto approval does not allow a tool if audit storage fails", async () => {
  const { store, bridge, active, options } = approvalFixture();
  store.createApproval = async () => { throw new Error("audit unavailable"); };
  await assert.rejects(bridge.requestApproval(active, "Bash", { command: "true" }, options), /audit unavailable/);
});

test("explicit SDK confirmation is not treated as an ordinary auto grant", async () => {
  const { store, bridge, active, options } = approvalFixture({ defaultToNo: true });
  const promise = bridge.requestApproval(active, "Bash", { command: "true" }, options);
  await eventually(() => active.approvals.size === 1, "explicit pending approval");
  active.abortController.abort();
  assert.equal((await promise).behavior, "deny");
  assert.equal([...store.approvals.values()][0].status, "pending");
});
