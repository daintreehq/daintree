import { configure } from "safe-stable-stringify";

const stringify = configure({ bigint: false, circularValue: "[Circular]" });

function replacer(_key: string, val: unknown): unknown {
  if (typeof val === "bigint") return val.toString();
  if (typeof val === "symbol") return val.toString();
  if (typeof val === "function") return `[Function: ${val.name || "anonymous"}]`;
  if (val instanceof Error) return { name: val.name, message: val.message, stack: val.stack };
  return val;
}

export function safeStringify(value: unknown, space?: string | number): string {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  if (value === undefined) return undefined as unknown as string;

  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return stringify(value, replacer, space) as string;
  } catch {
    try {
      return String(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
}
