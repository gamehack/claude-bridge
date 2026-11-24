import { spawn } from "node:child_process";
import { loadConfig } from "./config.js";
import { sanitize } from "./sanitize.js";
import { claudeEnvironment } from "./claude-client.js";

const config = loadConfig();
const prompt = process.env.CLAUDE_DIAGNOSTIC_PROMPT;
if (!prompt || prompt.length > 4000) throw new Error("Set CLAUDE_DIAGNOSTIC_PROMPT (max 4000 chars)");
const args = ["-p", prompt, "--output-format", "json", "--max-turns", "1"];
if (process.env.CLAUDE_DIAGNOSTIC_SESSION_ID) args.push("--resume", process.env.CLAUDE_DIAGNOSTIC_SESSION_ID);
const child = spawn(config.claudeExecutable, args, { cwd: config.defaultDirectory,
  stdio: ["ignore", "pipe", "inherit"], env: claudeEnvironment(config) });
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.once("close", (code) => {
  if (code !== 0) process.exitCode = code || 1;
  else process.stdout.write(`${JSON.stringify(sanitize(JSON.parse(output),
    { maxString: 12000, knownSecrets: [config.supabaseServiceRoleKey] }), null, 2)}\n`);
});
