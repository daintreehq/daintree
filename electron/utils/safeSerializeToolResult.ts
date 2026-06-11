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
export function safeSerializeToolResult(value: unknown): string {
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
      2
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
