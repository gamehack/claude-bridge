import { sanitize } from "./sanitize.js";

const levels = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = "info", knownSecrets = []) {
  const threshold = levels[level] ?? levels.info;
  const write = (name, event, fields = {}) => {
    if (levels[name] < threshold) return;
    const record = sanitize({ time: new Date().toISOString(), level: name, event, ...fields }, { knownSecrets });
    process[name === "error" ? "stderr" : "stdout"].write(`${JSON.stringify(record)}\n`);
  };
  return Object.fromEntries(Object.keys(levels).map((name) => [name, (event, fields) => write(name, event, fields)]));
}
