import test from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "../src/sanitize.js";

test("redacts secret fields, known values, and bearer text", () => {
  const output = sanitize({ api_key: "abc", note: "Bearer xyz.123", nested: "known-secret-value" },
    { knownSecrets: ["known-secret-value"] });
  assert.equal(output.api_key, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(output), /xyz|known-secret/);
});

test("bounds stored strings", () => {
  assert.match(sanitize("abcdefgh", { maxString: 4 }), /^abcd…\[truncated/);
});
