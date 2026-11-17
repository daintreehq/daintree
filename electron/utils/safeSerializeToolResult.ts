/**
 * Serialize an arbitrary tool result to JSON without throwing: BigInt and
 * Symbol coerce to strings, functions to a placeholder, Errors to a plain
 * object, and references that close a cycle to "[Circular]". Falls back to
 * string coercion when JSON.stringify still can't produce output.
 *
 * A value merely reached twice is expanded twice, exactly as the transport's
 * own `JSON.stringify` would — the size that costs is the MCP wire budget's
 * problem, not the serializer's.
 *
 * Lives outside `services/mcp-server/` on purpose: `pluginMcpHash.ts` needs it
 * on the eager boot path, and `mcp-server/shared.ts` value-imports the MCP
 * SDK's `types.js` (full zod schema construction at module init) — keeping the
 * serializer standalone keeps that cost off first paint.
 */
function serializeJson(value: unknown, indent: number): string | undefined {
  // The ancestor chain, not every object ever visited: a set that only grows
  // marks a value referenced twice in *sibling* branches as "[Circular]" even
  // though nothing is cyclic, and that placeholder string then lands where a
  // declared output schema expects an object (#11526).
  const ancestors: object[] = [];

  try {
    return JSON.stringify(
      value,
      function (this: unknown, _key: string, currentValue: unknown) {
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
          // `this` is the object holding this key, so unwinding to it discards
          // the branches already finished and leaves the real ancestor chain.
          const holder = ancestors.lastIndexOf(this as object);
          if (holder !== -1) ancestors.length = holder + 1;
          if (ancestors.includes(currentValue)) {
            return "[Circular]";
          }
          ancestors.push(currentValue);
        }
        return currentValue;
      },
      indent
    );
  } catch {
    return undefined;
  }
}

function serialize(value: unknown, indent: number): string {
  const serialized = serializeJson(value, indent);
  if (serialized !== undefined) return serialized;
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
 * The 2-space-indented form, or `undefined` where {@link safeSerializeToolResult}
 * would fall back to string coercion: for a reader that promises JSON, where a
 * coerced `toString()` could pass for a complete result.
 */
export function trySafeSerializeToolResult(value: unknown): string | undefined {
  return serializeJson(value, 2);
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
