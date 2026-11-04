import { createClient } from "@supabase/supabase-js";

function checked({ data, error }, operation) {
  if (error) {
    const wrapped = new Error(`${operation}: ${error.message}`);
    wrapped.code = error.code || null;
    throw wrapped;
  }
  return data;
}

export function createStore(config, logger) {
  const client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { "x-client-info": "gamehack-claude-bridge/0.1.0" } },
    realtime: { params: { eventsPerSecond: 5 } }
  });
  const db = client.schema("public");
  return {
    subscribe(wake) {
      return client.channel("claude-bridge-commands")
        .on("postgres_changes", { event: "INSERT", schema: "coord", table: "claude_commands" }, wake)
        .subscribe((status, error) => {
          if (status === "SUBSCRIBED") wake();
          if (error) logger.warn("realtime.error", { message: error.message });
        });
    },
    async unsubscribe(channel) {
      if (channel) await client.removeChannel(channel);
      client.realtime.disconnect();
    },
    async claim(worker, lease) {
      const data = checked(await db.rpc("claude_claim_next_command", { p_worker_id: worker, p_lease_seconds: lease }), "claim");
      return Array.isArray(data) ? data[0] || null : data;
    },
    async createSession(values) {
      return checked(await db.from("claude_sessions").insert(values).select("*").single(), "createSession");
    },
    async session(id) {
      return checked(await db.from("claude_sessions").select("*").eq("id", id).maybeSingle(), "session");
    },
    async updateSession(id, values) {
      return checked(await db.from("claude_sessions").update({ ...values, updated_at: new Date().toISOString() })
        .eq("id", id).select("*").single(), "updateSession");
    },
    async updateCommand(id, values) {
      return checked(await db.from("claude_commands").update({ ...values, updated_at: new Date().toISOString() })
        .eq("id", id).select("*").single(), "updateCommand");
    },
    async command(id) {
      return checked(await db.from("claude_commands").select("*").eq("id", id).maybeSingle(), "command");
    },
    async expiredClaims() {
      const time = new Date().toISOString();
      return checked(await db.from("claude_commands").update({ status: "needs_reconciliation",
        error: { name: "LeaseExpired", message: "Claim state is uncertain; command was not replayed" },
        finished_at: time, lease_expires_at: null, updated_at: time })
        .eq("status", "claimed").lt("lease_expires_at", time).select("*"), "expiredClaims") || [];
    },
    async recoverOrphans() {
      return checked(await db.rpc("claude_reconcile_orphaned_work"), "recoverOrphans") || [];
    },
    async event(values) { checked(await db.from("claude_events").insert(values), "event"); },
    async createApproval(values) {
      return checked(await db.from("claude_approvals").insert(values).select("*").single(), "createApproval");
    },
    async approval(id) {
      return checked(await db.from("claude_approvals").select("*").eq("id", id).maybeSingle(), "approval");
    },
    async updateApproval(id, values) {
      return checked(await db.from("claude_approvals").update(values).eq("id", id).select("*").single(), "updateApproval");
    }
  };
}
