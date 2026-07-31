/**
 * Serialize an arbitrary tool result to JSON without throwing: BigInt and
 * Symbol coerce to strings, functions to a placeholder, Errors to a plain
 * object, and circular references to "[Circular]". Falls back to string
 * coercion when JSON.stringify still can't produce output.
 *
 * Lives outside `services/mcp-server/` on purpose: `pluginMcpHash.ts` needs it
 * on the eager boot path, and `mcp-server/shared.ts` value-imports the MCP
 * SDK's `types.js` (full zod schema construction at module init) — keeping the
 * serializer standalone keeps that cost off first paint.
 */
function serialize(value: unknown, indent: number): string {
  const seen = new WeakSet<object>();

  try {
    const serialized = JSON.stringify(
      value,
      (_key, currentValue) => {
        if (typeof currentValue === "bigint") {
          return currentValue.toString();
        }
        if (typeof currentValue === "symbol") {
          return currentValue.toString();
        }
        if (typeof currentValue === "function") {
          return `[Function: ${currentValue.name || "anonymous"}]`;
        }
        if (currentValue instanceof Error) {
          return {
            name: currentValue.name,
            message: currentValue.message,
            stack: currentValue.stack,
          };
        }
        if (currentValue !== null && typeof currentValue === "object") {
          if (seen.has(currentValue)) {
            return "[Circular]";
          }
          seen.add(currentValue);
        }
        return currentValue;
      },
      indent
    );

    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall through to string coercion.
  }

  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * The 2-space-indented form. This output is hashed by `pluginMcpHash.ts` for
 * plugin schema fingerprints (TOFU consent pinning) and audit argument hashes,
 * so its bytes are a persisted contract: changing the indent here silently
 * rotates every stored fingerprint and forces spurious re-consent. Callers that
 * only need the JSON on the wire want `safeSerializeToolResultCompact` instead.
 */
export function safeSerializeToolResult(value: unknown): string {
  return serialize(value, 2);
}

/**
 * The unindented form, for MCP `tools/call` payloads. Pretty-printing costs
 * 25-46% of the response in whitespace no model reads (#11526), and the wire
 * has no reader that needs the indent — but only the wire may use this, never
 * a hash input.
 */
export function safeSerializeToolResultCompact(value: unknown): string {
  return serialize(value, 0);
}
