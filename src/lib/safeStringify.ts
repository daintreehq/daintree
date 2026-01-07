/**
 * Safely stringify a value, handling BigInt, circular references, and other non-serializable types.
 */
export function safeStringify(value: unknown, space?: string | number): string {
  const seen = new WeakSet<object>();

  const replacer = (_key: string, val: unknown): unknown => {
    if (typeof val === "bigint") {
      return val.toString();
    }
    if (typeof val === "symbol") {
      return val.toString();
    }
    if (typeof val === "function") {
      return `[Function: ${val.name || "anonymous"}]`;
    }
    if (val instanceof Error) {
      return {
        name: val.name,
        message: val.message,
        stack: val.stack,
      };
    }
    if (val !== null && typeof val === "object") {
      if (seen.has(val)) {
        return "[Circular]";
      }
      seen.add(val);
    }
    return val;
  };

  try {
    return JSON.stringify(value, replacer, space);
  } catch {
    try {
      return String(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
}
