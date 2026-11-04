const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|service[_-]?role)/i;
const SECRET_TEXT = [
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(sk|key|token|secret)[-_][A-Za-z0-9_-]{12,}\b/gi,
  /([?&](?:key|token|secret|signature)=)[^&\s]+/gi
];

export function redactText(value, knownSecrets = []) {
  let text = String(value);
  for (const secret of knownSecrets) {
    if (typeof secret === "string" && secret.length >= 8) text = text.split(secret).join("[REDACTED]");
  }
  for (const pattern of SECRET_TEXT) text = text.replace(pattern, (_, prefix = "") => `${prefix || ""}[REDACTED]`);
  return text;
}

export function sanitize(value, { maxString = 12000, knownSecrets = [], depth = 0 } = {}) {
  if (depth > 8) return "[TRUNCATED]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const clean = redactText(value, knownSecrets);
    return clean.length > maxString ? `${clean.slice(0, maxString)}…[truncated ${clean.length - maxString} chars]` : clean;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item,
    { maxString, knownSecrets, depth: depth + 1 }));
  if (typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : sanitize(item,
        { maxString, knownSecrets, depth: depth + 1 });
    }
    return output;
  }
  return sanitize(String(value), { maxString, knownSecrets, depth: depth + 1 });
}

export function errorObject(error, knownSecrets = []) {
  return sanitize({
    name: error?.name || "Error",
    message: error?.message || String(error),
    code: error?.code || null
  }, { maxString: 2000, knownSecrets });
}
