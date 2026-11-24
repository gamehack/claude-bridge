import { spawn } from "node:child_process";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

// Keep provider/model configuration while withholding the control-plane secret from children.
// This is environment hygiene, not an OS isolation boundary between processes of the same uid.
export function claudeEnvironment(config, env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) =>
    !["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"].includes(key) &&
    !(config.supabaseServiceRoleKey && value === config.supabaseServiceRoleKey)));
}

export class ClaudeClient {
  constructor(config, { query = sdkQuery } = {}) {
    this.config = config;
    this.query = query;
  }

  startTurn({ text, directory, resume, abortController, canUseTool }) {
    return this.query({
      prompt: text,
      options: {
        cwd: directory,
        ...(resume ? { resume } : {}),
        abortController,
        canUseTool,
        permissionMode: this.config.permissionMode || "default",
        ...(this.config.permissionMode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true } : {}),
        includePartialMessages: true,
        pathToClaudeCodeExecutable: this.config.claudeExecutable,
        env: { ...claudeEnvironment(this.config), CLAUDE_AGENT_SDK_CLIENT_APP: "gamehack-claude-bridge/0.1.0" }
      }
    });
  }

  async health() {
    const version = await new Promise((resolve, reject) => {
      const child = spawn(this.config.claudeExecutable, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"], env: claudeEnvironment(this.config)
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve(stdout.trim().slice(0, 200))
        : reject(new Error(`Claude CLI version check failed (${code}): ${stderr.trim().slice(0, 500)}`)));
    });
    return { sdk: true, cli_version: version, executable: this.config.claudeExecutable };
  }
}

export function summarizeSdkMessage(message, maxChars = 12000) {
  const common = { type: message?.type || "unknown", subtype: message?.subtype || null,
    session_id: message?.session_id || null };
  if (message?.type === "system" && message.subtype === "init") {
    return { ...common, model: message.model || null, cwd: message.cwd || null,
      claude_code_version: message.claude_code_version || null, permission_mode: message.permissionMode || null };
  }
  if (message?.type === "assistant") {
    const content = Array.isArray(message.message?.content) ? message.message.content : [];
    const text = content.filter((block) => block?.type === "text").map((block) => block.text || "").join("\n");
    const tools = content.filter((block) => block?.type === "tool_use").map((block) => ({ name: block.name, id: block.id }));
    return { ...common, model: message.message?.model || null, error: message.error || null,
      text: text.slice(0, maxChars), text_truncated: text.length > maxChars, tools };
  }
  if (message?.type === "result") {
    return { ...common, is_error: Boolean(message.is_error), stop_reason: message.stop_reason || null,
      duration_ms: message.duration_ms ?? null, num_turns: message.num_turns ?? null,
      total_cost_usd: message.total_cost_usd ?? null, usage: message.usage || null,
      model_usage: message.modelUsage || null,
      result: typeof message.result === "string" ? message.result.slice(0, maxChars) : null,
      result_truncated: typeof message.result === "string" && message.result.length > maxChars,
      errors: message.errors || null };
  }
  if (message?.type === "stream_event") {
    return { ...common, event_type: message.event?.type || null };
  }
  return common;
}
