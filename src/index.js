import { Bridge } from "./bridge.js";
import { ClaudeClient } from "./claude-client.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { createStore } from "./store.js";
import { errorObject } from "./sanitize.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, [config.supabaseServiceRoleKey]);
  const bridge = new Bridge(config, createStore(config, logger), new ClaudeClient(config), logger);
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info("process.signal", { signal });
    void bridge.stop().then(() => { process.exitCode = 0; }).catch((error) => {
      logger.error("bridge.stop_failed", { error: errorObject(error, [config.supabaseServiceRoleKey]) });
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  await bridge.start();
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ level: "fatal", event: "startup_failed", error: errorObject(error) })}\n`);
  process.exitCode = 1;
});
