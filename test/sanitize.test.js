import test from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "../src/sanitize.js";

test("redacts secret fields, known values, and bearer text", () => {
  const output = sanitize({ api_key: "abc", authToken: "def", note: "Bearer xyz.123",
    nested: "known-secret-value", input_tokens: 123, output_tokens_details: { thinking: 5 } },
    { knownSecrets: ["known-secret-value"] });
  assert.equal(output.api_key, "[REDACTED]");
  assert.equal(output.authToken, "[REDACTED]");
  assert.equal(output.input_tokens, 123);
  assert.equal(output.output_tokens_details.thinking, 5);
  assert.doesNotMatch(JSON.stringify(output), /xyz|known-secret/);
});

test("bounds stored strings", () => {
  assert.match(sanitize("abcdefgh", { maxString: 4 }), /^abcd…\[truncated/);
});
