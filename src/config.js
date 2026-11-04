import os from "node:os";
import path from "node:path";
import { accessSync, constants } from "node:fs";
import { randomUUID } from "node:crypto";

function positiveInt(value, fallback, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

export function loadConfig(env = process.env, { checkExecutable = true } = {}) {
  const url = new URL(env.SUPABASE_URL || "https://example.supabase.co");
  if (url.protocol !== "https:") throw new Error("SUPABASE_URL must use HTTPS");
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");

  const claudeExecutable = env.CLAUDE_EXECUTABLE || "/home/ubuntu/.local/bin/claude";
  if (!path.isAbsolute(claudeExecutable) || claudeExecutable.includes("\0")) {
    throw new Error("CLAUDE_EXECUTABLE must be an absolute path");
  }
  if (checkExecutable) accessSync(claudeExecutable, constants.X_OK);

  const defaultDirectory = env.CLAUDE_DEFAULT_DIRECTORY || "/home/ubuntu";
  if (!path.isAbsolute(defaultDirectory) || defaultDirectory.includes("\0")) {
    throw new Error("CLAUDE_DEFAULT_DIRECTORY must be an absolute path");
  }

  return {
    supabaseUrl: url.origin,
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    claudeExecutable: path.resolve(claudeExecutable),
    defaultDirectory: path.resolve(defaultDirectory),
    bridgeId: env.BRIDGE_ID || `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    pollIntervalMs: positiveInt(env.BRIDGE_POLL_INTERVAL_MS, 15000, "BRIDGE_POLL_INTERVAL_MS", { min: 1000, max: 300000 }),
    claimLeaseSeconds: positiveInt(env.BRIDGE_CLAIM_LEASE_SECONDS, 60, "BRIDGE_CLAIM_LEASE_SECONDS", { min: 15, max: 300 }),
    maxEventChars: positiveInt(env.BRIDGE_MAX_EVENT_CHARS, 12000, "BRIDGE_MAX_EVENT_CHARS", { min: 1000, max: 50000 }),
    logLevel: env.LOG_LEVEL || "info"
  };
}
