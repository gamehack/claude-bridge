import { validateCommand } from "./commands.js";
import { errorObject, sanitize } from "./sanitize.js";
import { summarizeSdkMessage } from "./claude-client.js";

const now = () => new Date().toISOString();
const terminal = new Set(["succeeded", "failed", "cancelled", "needs_reconciliation"]);

export class Bridge {
  constructor(config, store, claude, logger) {
    this.config = config;
    this.store = store;
    this.claude = claude;
    this.logger = logger;
    this.active = new Map();
    this.busy = false;
    this.stopped = false;
    this.timer = null;
    this.channel = null;
  }

  async start() {
    await this.claude.health();
    const recovered = await this.store.recoverOrphans();
    if (recovered.length) this.logger.warn("bridge.orphans_reconciled", { count: recovered.length });
    this.channel = this.store.subscribe(() => this.wake());
    this.timer = setInterval(() => this.wake(), this.config.pollIntervalMs);
    this.wake();
    this.logger.info("bridge.started", { bridge_id: this.config.bridgeId,
      default_directory: this.config.defaultDirectory, sdk_primary: true });
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    await this.store.unsubscribe(this.channel).catch(() => {});
    for (const active of this.active.values()) {
      active.cancelReason = "shutdown";
      active.abortController.abort(new Error("Bridge shutting down"));
      active.query?.close?.();
    }
    await Promise.allSettled([...this.active.values()].map((active) => active.task));
    this.logger.info("bridge.stopped");
  }

  wake() {
    if (this.stopped || this.busy) return;
    void this.tick().catch((error) => this.logger.error("bridge.tick_failed",
      { error: errorObject(error, [this.config.supabaseServiceRoleKey]) }));
  }

  async tick() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      for (const command of await this.store.expiredClaims()) {
        await this.event(command, "command.lease_expired", {});
      }
      for (let count = 0; count < 10 && !this.stopped; count++) {
        const command = await this.store.claim(this.config.bridgeId, this.config.claimLeaseSeconds);
        if (!command) break;
        await this.execute(command);
      }
    } finally {
      this.busy = false;
    }
  }

  async execute(command) {
    try {
      const input = validateCommand(command, this.config);
      switch (command.command_type) {
        case "create_session": return await this.createSession(command, input);
        case "start_turn": return await this.startTurn(command, input);
        case "interrupt_turn": return await this.interruptTurn(command);
        case "approval_decision": return await this.approvalDecision(command, input);
        case "health_check": return await this.healthCheck(command);
      }
    } catch (error) {
      const uncertain = Boolean(command.dispatched_at);
      await this.store.updateCommand(command.id, { status: uncertain ? "needs_reconciliation" : "failed",
        error: errorObject(error, [this.config.supabaseServiceRoleKey]), finished_at: now(), lease_expires_at: null });
      if (uncertain && command.session_id) await this.store.updateSession(command.session_id,
        { status: "needs_reconciliation", current_command_id: null });
      await this.event(command, uncertain ? "command.needs_reconciliation" : "command.failed",
        errorObject(error, [this.config.supabaseServiceRoleKey]));
      this.logger.warn("command.failed", { command_id: command.id, uncertain,
        error: errorObject(error, [this.config.supabaseServiceRoleKey]) });
    }
  }

  async createSession(command, { title, directory, workspaceKey }) {
    command.dispatched_at = now();
    await this.store.updateCommand(command.id, { dispatched_at: command.dispatched_at });
    const session = await this.store.createSession({ title, directory, workspace_key: workspaceKey, status: "ready" });
    command.session_id = session.id;
    await this.store.updateCommand(command.id, { session_id: session.id });
    await this.finish(command, "succeeded", { session_id: session.id, directory, workspace_key: workspaceKey });
  }

  async startTurn(command, { text }) {
    const session = await this.store.session(command.session_id);
    if (!session || session.status !== "ready" || this.active.has(session.id)) throw new Error("Claude session is not ready");

    const dispatchedAt = now();
    command.dispatched_at = dispatchedAt;
    await this.store.updateSession(session.id, { status: "running", current_command_id: command.id });
    await this.store.updateCommand(command.id, { status: "running", started_at: dispatchedAt,
      dispatched_at: dispatchedAt, lease_expires_at: null,
      result: { claude_session_id_before: session.claude_session_id || null } });
    await this.event(command, "turn.started", { resumed: Boolean(session.claude_session_id) });

    const abortController = new AbortController();
    const active = { session, command, abortController, query: null, approvals: new Map(),
      cancelReason: null, task: null, streamEvents: 0, systemEvents: 0, storedEvents: 0 };
    this.active.set(session.id, active);
    active.task = this.runTurn(active, text);
    void active.task.catch((error) => this.logger.error("turn.unhandled", { session_id: session.id,
      error: errorObject(error, [this.config.supabaseServiceRoleKey]) }));
  }

  async runTurn(active, text) {
    const { session, command, abortController } = active;
    let sdkResult = null;
    let model = session.model || null;
    try {
      active.query = this.claude.startTurn({ text, directory: session.directory,
        resume: session.claude_session_id || undefined, abortController,
        canUseTool: (toolName, input, options) => this.requestApproval(active, toolName, input, options) });

      for await (const message of active.query) {
        if (message?.session_id && (!session.claude_session_id || session.claude_session_id !== message.session_id)) {
          session.claude_session_id = message.session_id;
          await this.store.updateSession(session.id, { claude_session_id: message.session_id });
        }
        if (message?.type === "system" && message.subtype === "init") model = message.model || model;
        if (message?.type === "assistant" && message.message?.model) model = message.message.model;
        if (message?.type === "stream_event") {
          active.streamEvents++;
          if (active.streamEvents === 1) await this.event(command, "sdk.stream_started",
            summarizeSdkMessage(message, this.config.maxEventChars));
          continue;
        }
        if (message?.type === "system" && message.subtype !== "init") {
          active.systemEvents++;
          continue;
        }
        if (["system", "assistant", "result"].includes(message?.type) && active.storedEvents < 50) {
          active.storedEvents++;
          await this.event(command, `sdk.${message.type}`,
            summarizeSdkMessage(message, this.config.maxEventChars));
        }
        if (message?.type === "result") sdkResult = message;
      }
      if (!sdkResult) throw new Error("Claude SDK stream ended without a result message");

      const failed = sdkResult.subtype !== "success" || Boolean(sdkResult.is_error);
      const result = sanitize({
        claude_session_id: session.claude_session_id,
        final_message: typeof sdkResult.result === "string" ? sdkResult.result : null,
        model,
        usage: sdkResult.usage || null,
        model_usage: sdkResult.modelUsage || null,
        total_cost_usd: sdkResult.total_cost_usd ?? null,
        duration_ms: sdkResult.duration_ms ?? null,
        num_turns: sdkResult.num_turns ?? null,
        stop_reason: sdkResult.stop_reason || null,
        stream_event_count: active.streamEvents,
        omitted_system_event_count: active.systemEvents
      }, { maxString: 50000, knownSecrets: [this.config.supabaseServiceRoleKey] });
      await this.store.updateCommand(command.id, { status: failed ? "failed" : "succeeded", result,
        error: failed ? sanitize({ name: "ClaudeResultError", errors: sdkResult.errors || [],
          message: sdkResult.result || "Claude turn failed" }, { maxString: 2000 }) : null,
        finished_at: now(), lease_expires_at: null });
      await this.store.updateSession(session.id, { status: failed ? "error" : "ready", model,
        current_command_id: null, last_turn_status: failed ? "failed" : "succeeded" });
      await this.event(command, "turn.completed", { failed, model, stream_event_count: active.streamEvents,
        omitted_system_event_count: active.systemEvents });
    } catch (error) {
      const operatorCancelled = active.cancelReason === "operator";
      const status = operatorCancelled ? "cancelled" : "needs_reconciliation";
      await this.store.updateCommand(command.id, { status,
        error: operatorCancelled ? null : errorObject(error, [this.config.supabaseServiceRoleKey]),
        finished_at: now(), lease_expires_at: null });
      await this.store.updateSession(session.id, { status: operatorCancelled ? "ready" : "needs_reconciliation",
        current_command_id: null, last_turn_status: status });
      await this.event(command, operatorCancelled ? "turn.cancelled" : "turn.needs_reconciliation",
        operatorCancelled ? {} : errorObject(error, [this.config.supabaseServiceRoleKey]));
    } finally {
      for (const [approvalId, pending] of active.approvals) {
        pending.resolve({ behavior: "deny", message: "Claude turn ended before approval", interrupt: true,
          toolUseID: pending.toolUseID });
        await this.store.updateApproval(approvalId, { status: "orphaned", resolved_at: now() }).catch(() => {});
      }
      active.approvals.clear();
      active.query?.close?.();
      this.active.delete(session.id);
      this.wake();
    }
  }

  async requestApproval(active, toolName, input, options) {
    const detail = sanitize({ tool_name: toolName, input, title: options.title,
      display_name: options.displayName, description: options.description,
      blocked_path: options.blockedPath, decision_reason: options.decisionReason,
      suggestions: options.suggestions, default_to_no: options.defaultToNo,
      suppress_always_allow_rule: options.suppressAlwaysAllowRule },
    { maxString: this.config.maxEventChars, knownSecrets: [this.config.supabaseServiceRoleKey] });
    const approval = await this.store.createApproval({ session_id: active.session.id,
      command_id: active.command.id, sdk_request_id: options.requestId,
      tool_use_id: options.toolUseID, tool_name: toolName, detail, status: "pending" });
    await this.store.updateSession(active.session.id, { status: "awaiting_approval" });
    await this.store.updateCommand(active.command.id, { status: "awaiting_approval" });
    await this.event(active.command, "approval.requested", { approval_id: approval.id, tool_name: toolName,
      title: options.title || null });

    return await new Promise((resolve) => {
      const onAbort = () => {
        resolve({ behavior: "deny", message: "Claude turn interrupted", interrupt: true,
          toolUseID: options.toolUseID });
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      active.approvals.set(approval.id, { toolUseID: options.toolUseID, input,
        suggestions: options.suggestions || [], resolve: (decision) => {
          options.signal.removeEventListener("abort", onAbort);
          resolve(decision);
        } });
      if (options.signal.aborted) onAbort();
    });
  }

  async approvalDecision(command, { approvalId, decision }) {
    const approval = await this.store.approval(approvalId);
    if (!approval || approval.session_id !== command.session_id || approval.status !== "pending") {
      throw new Error("Approval is not pending in this session");
    }
    const active = this.active.get(command.session_id);
    const pending = active?.approvals.get(approvalId);
    if (!active || !pending) throw new Error("Approval is orphaned from the live Claude SDK process");

    command.dispatched_at = now();
    await this.store.updateCommand(command.id, { dispatched_at: command.dispatched_at });
    await this.store.updateApproval(approvalId, { status: decision === "reject" ? "rejected" : "approved",
      decision, resolved_at: now() });
    active.approvals.delete(approvalId);
    pending.resolve(decision === "reject"
      ? { behavior: "deny", message: "Human operator rejected this tool use", toolUseID: pending.toolUseID }
      : { behavior: "allow", updatedInput: pending.input,
        ...(decision === "always" && pending.suggestions.length ? { updatedPermissions: pending.suggestions } : {}),
        toolUseID: pending.toolUseID });
    await this.store.updateSession(command.session_id, { status: "running" });
    await this.store.updateCommand(active.command.id, { status: "running" });
    await this.event(command, "approval.resolved", { approval_id: approvalId, decision });
    await this.finish(command, "succeeded", { approval_id: approvalId, decision });
  }

  async interruptTurn(command) {
    const active = this.active.get(command.session_id);
    if (!active || terminal.has(active.command.status)) throw new Error("Session has no active Claude SDK turn");
    command.dispatched_at = now();
    await this.store.updateCommand(command.id, { dispatched_at: command.dispatched_at });
    active.cancelReason = "operator";
    active.abortController.abort(new Error("Interrupted by operator"));
    active.query?.close?.();
    await active.task;
    await this.finish(command, "succeeded", { interrupt_accepted: true,
      interrupted_command_id: active.command.id });
  }

  async healthCheck(command) {
    const health = await this.claude.health();
    await this.finish(command, "succeeded", { ...health, active_turns: this.active.size });
  }

  async finish(command, status, result) {
    await this.store.updateCommand(command.id, { status, result, error: null, finished_at: now(), lease_expires_at: null });
    await this.event(command, `command.${status}`, { status });
  }

  async event(command, eventType, payload) {
    await this.store.event({ command_id: command.id, session_id: command.session_id || null,
      event_type: eventType, payload: sanitize(payload, { maxString: this.config.maxEventChars,
        knownSecrets: [this.config.supabaseServiceRoleKey] }) });
  }
}
