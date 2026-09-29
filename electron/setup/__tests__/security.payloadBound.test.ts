import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, on: vi.fn() }, ipcMain: {}, session: {} }));
vi.mock("../../services/TelemetryService.js", () => ({ getCurrentCorrelationId: vi.fn() }));

import {
  isProvablyWithinPayloadBudget,
  validateIpcInvokeEnvelope,
  PAYLOAD_BUDGETS,
  DEFAULT_PAYLOAD_BUDGET,
} from "../security.js";
import { channelToCategory } from "../../ipc/utils.js";
import { AppError } from "../../utils/errorTypes.js";
import { PLUGIN_INVOKE_MAX_ARGS_BYTES } from "../../../shared/config/pluginBudgets.js";

// Exact measurement exactly as the gate performed it before the fast path:
// null means the old gate failed open (stringify threw, or the payload held a
// binary/Map/Set value).
const UNRELIABLE = Symbol("unreliable");
function exactBytes(args: unknown[]): number | null {
  try {
    return Buffer.byteLength(
      JSON.stringify(args, (_key, value: unknown) => {
        if (
          value !== null &&
          typeof value === "object" &&
          (ArrayBuffer.isView(value) ||
            value instanceof ArrayBuffer ||
            value instanceof Map ||
            value instanceof Set)
        ) {
          throw UNRELIABLE;
        }
        return typeof value === "bigint" ? value.toString() : value;
      }),
      "utf8"
    );
  } catch {
    return null;
  }
}

function referenceOutcome(
  channel: string,
  args: unknown[],
  bytes: number | null = exactBytes(args)
): string {
  const category = channelToCategory[channel];
  const budget = category !== undefined ? PAYLOAD_BUDGETS[category] : DEFAULT_PAYLOAD_BUDGET;
  if (args.length > 8) return "ARG_COUNT_EXCEEDED";
  return bytes !== null && bytes > budget ? `PAYLOAD_TOO_LARGE:${bytes}` : "ok";
}

function actualOutcome(channel: string, args: unknown[]): string {
  try {
    validateIpcInvokeEnvelope(channel, args);
    return "ok";
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    const e = err as AppError;
    return e.code === "PAYLOAD_TOO_LARGE"
      ? `${e.code}:${(e.context as { bytes: number }).bytes}`
      : String(e.code);
  }
}

// The soundness property: whenever the fast path claims "within budget", the
// exact measurement must agree (or the old gate failed open anyway).
function expectBoundSound(args: unknown[], budgets: number[]): void {
  const exact = exactBytes(args);
  for (const budget of budgets) {
    if (budget < 0) continue;
    if (isProvablyWithinPayloadBudget(args, budget) && exact !== null) {
      expect(exact, `budget ${budget}`).toBeLessThanOrEqual(budget);
    }
  }
}

function sweep(args: unknown[]): void {
  const exact = exactBytes(args);
  const budgets = [0, 1, 2, 4, 8, 16, 64, 1024, DEFAULT_PAYLOAD_BUDGET];
  if (exact !== null) {
    for (let d = -8; d <= 8; d++) budgets.push(exact + d);
  }
  expectBoundSound(args, budgets);
}

function xorshift(seed: number): () => number {
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x1_0000_0000;
  };
}

const SPECIAL_UNITS = [
  ...Array.from({ length: 0x20 }, (_, i) => i),
  0x22, // "
  0x5c, // \
  0x7f,
  0x80,
  0x7ff,
  0x800,
  0x2028,
  0x2029,
  0xd800, // lone high surrogate
  0xdbff,
  0xdc00, // lone low surrogate
  0xdfff,
  0xfeff,
  0xffff,
];

describe("isProvablyWithinPayloadBudget soundness", () => {
  it("never under-counts escape-heavy and multi-byte strings", () => {
    for (const unit of SPECIAL_UNITS) {
      const ch = String.fromCharCode(unit);
      for (const n of [0, 1, 2, 7, 64, 1000]) {
        const str = ch.repeat(n);
        sweep([str]);
        sweep([{ [str]: str }]);
        sweep([[str, str], { k: str }]);
      }
    }
    // Surrogate pairs (4 bytes per 2 units) and mixed lone/paired surrogates.
    sweep(["\ud83d\ude00".repeat(500)]);
    sweep(["\ud83d".repeat(300) + "\ud83d\ude00" + "\ude00".repeat(300)]);
    sweep(["a\ud800b\udc00c".repeat(200)]);
  });

  it("tightest string case: every unit a \\u escape", () => {
    const str = "\u0001".repeat(1000);
    const exact = exactBytes([str])!;
    expect(exact).toBe(6 * 1000 + 4);
    expect(isProvablyWithinPayloadBudget([str], exact - 1)).toBe(false);
    // The bound overshoots by just the spare comma, so the fast path is live here.
    expect(isProvablyWithinPayloadBudget([str], exact + 1)).toBe(true);
    sweep([str]);
  });

  it("tightest object case: many entries whose keys and values are all \\u escapes", () => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) obj["\u0001".repeat(i)] = "\u001f".repeat(i);
    const args = [obj, Object.keys(obj)];
    const exact = exactBytes(args)!;
    expect(isProvablyWithinPayloadBudget(args, exact - 1)).toBe(false);
    expect(isProvablyWithinPayloadBudget(args, exact + 64)).toBe(true);
    sweep(args);
  });

  it("stays conclusive and sound for omitted values and nested empty containers", () => {
    const args = [{ a: undefined, b: [], c: {}, d: [[], [{}]], e: [undefined] }, [], {}];
    const exact = exactBytes(args)!;
    expect(isProvablyWithinPayloadBudget(args, exact + 64)).toBe(true);
    sweep(args);
  });

  it("never under-counts large strings that reach the narrow (3-byte) tier", () => {
    const budget = 64 * 1024;
    // Lengths where 6x overshoots the budget but 3x fits.
    const len = Math.floor(budget / 4);
    for (const unit of SPECIAL_UNITS) {
      const ch = String.fromCharCode(unit);
      const worst = ch.repeat(len);
      const salted = "\u00e9".repeat(len - 1) + ch;
      const ascii = "x".repeat(len - 1) + ch;
      for (const str of [worst, salted, ascii]) {
        expectBoundSound([str], [budget, budget - 1, budget + 1]);
        const exact = exactBytes([str])!;
        expectBoundSound([str], [exact, exact - 1]);
      }
    }
    // Pure 3-byte BMP text is the tightest the narrow tier accepts.
    const bmp = "\u0800".repeat(len);
    const exact = exactBytes([bmp])!;
    expect(exact).toBe(3 * len + 4);
    expect(isProvablyWithinPayloadBudget([bmp], exact + 1)).toBe(true);
    expectBoundSound([bmp], [exact, exact - 1, exact - 2]);
    // Every `\u`-escaped control and every surrogate forces the exact path.
    for (const unit of SPECIAL_UNITS) {
      const str = String.fromCharCode(unit) + "x".repeat(len - 1);
      const shortEscape = [8, 9, 10, 12, 13].includes(unit);
      const wide = (unit < 0x20 && !shortEscape) || (unit >= 0xd800 && unit <= 0xdfff);
      expect(isProvablyWithinPayloadBudget([str], budget), `unit ${unit}`).toBe(!wide);
    }
    // Short escapes are 2 bytes per unit: `\n` and `"` and `\\`.
    sweep(['\n"\\'.repeat(len / 3)]);
  });

  it("never under-counts the longest numbers and non-finite values", () => {
    const numbers = [
      Number("-1.2345678901234567e-6"),
      Number("-1.2345678901234567e-7"),
      -1.7976931348623157e308,
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
      -123456789012345680000,
      -1e21,
      Number.MAX_SAFE_INTEGER,
      -0,
      NaN,
      Infinity,
      -Infinity,
    ];
    for (const n of numbers) {
      expect(String(n).length).toBeLessThanOrEqual(25);
      sweep([n]);
      sweep([[n, n, n]]);
      sweep([{ n }]);
    }
    const rand = xorshift(0x2545f491);
    for (let i = 0; i < 5000; i++) {
      const n = -rand() * 10 ** Math.floor(rand() * 640 - 330);
      expect(String(n).length).toBeLessThanOrEqual(25);
      expectBoundSound([n], [exactBytes([n])!]);
    }
  });

  it("never under-counts sparse arrays, holes, undefined and omitted entries", () => {
    // eslint-disable-next-line no-sparse-arrays
    sweep([[1, , 3]]);
    sweep([new Array(50)]);
    sweep([[undefined, null, undefined]]);
    sweep([{ a: undefined, b: null, c: undefined }]);
    sweep([undefined, undefined]);
    // eslint-disable-next-line no-sparse-arrays
    expect(isProvablyWithinPayloadBudget([[1, , 3]], DEFAULT_PAYLOAD_BUDGET)).toBe(false);
    expect(isProvablyWithinPayloadBudget([[1, undefined, 3]], DEFAULT_PAYLOAD_BUDGET)).toBe(true);
    const huge = new Array(10_000_000);
    expect(isProvablyWithinPayloadBudget([huge], DEFAULT_PAYLOAD_BUDGET)).toBe(false);
  });

  it("defers every non-plain value to the exact path", () => {
    const bail: unknown[] = [
      1n,
      { n: 10n ** 400n },
      Symbol("s"),
      () => 1,
      new Date(0),
      new Map([["a", 1]]),
      new Set([1]),
      new Uint8Array(4),
      new ArrayBuffer(4),
      new DataView(new ArrayBuffer(4)),
      new (class Foo {
        x = 1;
      })(),
      { toJSON: () => "x".repeat(10) },
      Object.assign([1], { toJSON: () => "y" }),
      new String("abc"),
      new Number(1),
      new Boolean(true),
      Object.create({ inherited: 1 }),
      /re/,
      new Error("e"),
      Object.setPrototypeOf([1, 2], null),
      // Boxed primitives serialise as their primitive whatever their prototype.
      Object.setPrototypeOf(new Boolean(false), null),
      Object.setPrototypeOf(new Number(1), Object.prototype),
      Object.setPrototypeOf(new String("s"), Object.prototype),
      new Proxy({}, {}),
      new Proxy([], { get: (t, k) => (k === "length" ? -Infinity : Reflect.get(t, k)) }),
    ];
    for (const value of bail) {
      expect(isProvablyWithinPayloadBudget([value], DEFAULT_PAYLOAD_BUDGET)).toBe(false);
      expect(isProvablyWithinPayloadBudget([{ nested: [value] }], DEFAULT_PAYLOAD_BUDGET)).toBe(
        false
      );
      sweep([value]);
    }
  });

  it("treats null-prototype objects as plain and never under-counts them", () => {
    const o = Object.assign(Object.create(null), { a: "x\u0000", b: [1, 2] });
    expect(isProvablyWithinPayloadBudget([o], DEFAULT_PAYLOAD_BUDGET)).toBe(true);
    sweep([o]);
  });

  function withPrototypeProperty(
    target: object,
    key: PropertyKey,
    descriptor: PropertyDescriptor,
    body: () => void
  ): void {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
    try {
      body();
    } finally {
      if (previous) Object.defineProperty(target, key, previous);
      else delete (target as Record<PropertyKey, unknown>)[key];
    }
  }

  it("bails on an inherited toJSON without invoking it", () => {
    let reads = 0;
    let conclusive: boolean | undefined;
    withPrototypeProperty(
      Object.prototype,
      "toJSON",
      { get: () => (reads++, () => "z".repeat(4096)) },
      () => {
        conclusive = isProvablyWithinPayloadBudget([{}], 1024);
      }
    );
    expect(conclusive).toBe(false);
    expect(reads).toBe(0);

    let outcomes: string[] = [];
    withPrototypeProperty(Object.prototype, "toJSON", { value: () => "z".repeat(4096) }, () => {
      outcomes = [actualOutcome("any:channel", [{}]), referenceOutcome("any:channel", [{}])];
    });
    expect(outcomes[0]).toBe(outcomes[1]);
  });

  it("measures the same value a deterministic getter returns to stringify", () => {
    const big = "g".repeat(5000);
    const obj = {};
    Object.defineProperty(obj, "lazy", { enumerable: true, get: () => big });
    expect(isProvablyWithinPayloadBudget([obj], 1000)).toBe(false);
    sweep([obj]);
    // Non-enumerable and symbol-keyed properties are skipped by both.
    const hidden = { visible: 1 };
    Object.defineProperty(hidden, "secret", { enumerable: false, value: big });
    (hidden as Record<symbol, string>)[Symbol("s")] = big;
    expect(isProvablyWithinPayloadBudget([hidden], 100)).toBe(true);
    sweep([hidden]);
  });

  it("keeps the old fail-open outcome when a getter throws", () => {
    const make = () => ({
      get x(): string {
        throw new Error("boom");
      },
    });
    expect(actualOutcome("any:channel", [make()])).toBe("ok");
    expect(referenceOutcome("any:channel", [make()])).toBe("ok");
  });

  it("bails on array holes, without reaching a prototype getter", () => {
    let reads = 0;
    let conclusive: boolean | undefined;
    withPrototypeProperty(Array.prototype, "1", { get: () => (reads++, "h".repeat(5000)) }, () => {
      // eslint-disable-next-line no-sparse-arrays
      conclusive = isProvablyWithinPayloadBudget([[0, , 2]], DEFAULT_PAYLOAD_BUDGET);
    });
    expect(conclusive).toBe(false);
    expect(reads).toBe(0);
  });

  it("bails on cycles and deep nesting, and stays bounded on exponential DAGs", () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(isProvablyWithinPayloadBudget([cyc], DEFAULT_PAYLOAD_BUDGET)).toBe(false);
    const cycArr: unknown[] = [];
    cycArr.push(cycArr);
    expect(isProvablyWithinPayloadBudget([cycArr], DEFAULT_PAYLOAD_BUDGET)).toBe(false);

    let deep: unknown = "leaf";
    for (let i = 0; i < 200; i++) deep = { d: [deep] };
    expect(isProvablyWithinPayloadBudget([deep], DEFAULT_PAYLOAD_BUDGET)).toBe(false);
    sweep([deep]);

    let dag: unknown = "x".repeat(16);
    for (let i = 0; i < 40; i++) dag = [dag, dag];
    expect(isProvablyWithinPayloadBudget([dag], DEFAULT_PAYLOAD_BUDGET)).toBe(false);
  });

  it("never under-counts seeded random JSON-shaped payloads", () => {
    const rand = xorshift(0x9e3779b9);
    const randUnit = () =>
      rand() < 0.5
        ? SPECIAL_UNITS[Math.floor(rand() * SPECIAL_UNITS.length)]
        : Math.floor(rand() * 0x10000);
    const randString = () =>
      String.fromCharCode(...Array.from({ length: Math.floor(rand() * 40) }, randUnit));
    const randValue = (depth: number): unknown => {
      const r = rand();
      if (depth > 4 || r < 0.35) {
        const p = rand();
        if (p < 0.4) return randString();
        if (p < 0.7) return (rand() - 0.5) * 10 ** Math.floor(rand() * 60 - 30);
        if (p < 0.8) return rand() < 0.5;
        if (p < 0.9) return null;
        return undefined;
      }
      if (r < 0.65) {
        const arr = Array.from({ length: Math.floor(rand() * 6) }, () => randValue(depth + 1));
        if (rand() < 0.2) arr.length += 3;
        return arr;
      }
      const obj: Record<string, unknown> = {};
      const n = Math.floor(rand() * 6);
      for (let i = 0; i < n; i++) obj[randString()] = randValue(depth + 1);
      return obj;
    };
    for (let i = 0; i < 3000; i++) {
      const args = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => randValue(0));
      sweep(args);
    }
  });
});

describe("validateIpcInvokeEnvelope parity with the exact-only gate", () => {
  // Each budget is paired with a channel that carries it, so the boundary
  // payloads (up to 4 MiB) are only measured where they sit on the boundary.
  const boundaries: Array<[channel: string, budget: number]> = [
    ["any:channel", DEFAULT_PAYLOAD_BUDGET],
    ["terminal:spawn", PAYLOAD_BUDGETS.terminalSpawn],
    ["git:get-file-diff", PAYLOAD_BUDGETS.gitOps],
    ["copytree:get-file-tree", PAYLOAD_BUDGETS.fileOps],
    ["artifact:save-to-file", PAYLOAD_BUDGETS.artifactOps],
  ];
  const channels = boundaries.map(([channel]) => channel);

  function payloadsAround(budget: number): unknown[][] {
    // Strings whose exact size lands on either side of the budget, for each
    // per-unit width, so the fast path and the exact path both get exercised
    // at the boundary.
    const out: unknown[][] = [];
    for (const [ch, width] of [
      ["x", 1],
      ["\u00e9", 2],
      ["\u0800", 3],
      ["\ud83d\ude00", 2],
      ["\n", 2],
      ["\u0001", 6],
      ["\ud800", 6],
    ] as const) {
      const n = Math.floor((budget - 4) / width / ch.length);
      for (const d of [-2, -1, 0, 1, 2]) {
        const count = Math.max(0, n + d);
        out.push([ch.repeat(count)]);
        out.push([{ path: "/p", content: ch.repeat(Math.max(0, count - 8)) }]);
      }
    }
    out.push([{ data: "x".repeat(budget), n: 1n }]);
    out.push([{ blob: new Uint8Array(budget + 10) }]);
    out.push([new Map([["k", "x".repeat(budget + 10)]])]);
    out.push([{ when: new Date(0), text: "x".repeat(budget) }]);
    out.push(Array.from({ length: 8 }, () => "y".repeat(Math.floor(budget / 8))));
    out.push(Array.from({ length: 9 }, () => 1));
    return out;
  }

  it.each(boundaries)(
    "rejects exactly what the exact-only gate rejected, with the same byte count (%s at %i bytes)",
    (channel, budget) => {
      for (const args of payloadsAround(budget)) {
        expect(actualOutcome(channel, args)).toBe(referenceOutcome(channel, args));
      }
    }
  );

  it("agrees with the exact-only gate on channels whose budget is not under test", () => {
    // The smallest budget's boundary payloads must be accepted identically by
    // every roomier channel, and a mid-size budget's boundary payloads must be
    // rejected by a tighter channel with the same byte count.
    for (const args of payloadsAround(PAYLOAD_BUDGETS.terminalSpawn)) {
      const bytes = exactBytes(args);
      for (const channel of channels) {
        expect(actualOutcome(channel, args)).toBe(referenceOutcome(channel, args, bytes));
      }
    }
    for (const args of payloadsAround(PAYLOAD_BUDGETS.gitOps)) {
      expect(actualOutcome("terminal:spawn", args)).toBe(referenceOutcome("terminal:spawn", args));
    }
  });
});

describe("validateIpcInvokeEnvelope on plugin:invoke", () => {
  const budget = PAYLOAD_BUDGETS.pluginInvoke;

  function outcome(args: unknown[]): string {
    try {
      validateIpcInvokeEnvelope("plugin:invoke", args);
      return "ok";
    } catch (err) {
      return (err as Error).message.split(":")[0]!;
    }
  }

  it("uses the plugin args cap plus bounded headroom, not the default budget", () => {
    expect(channelToCategory["plugin:invoke"]).toBe("pluginInvoke");
    expect(budget).toBeGreaterThan(PLUGIN_INVOKE_MAX_ARGS_BYTES);
    expect(budget - PLUGIN_INVOKE_MAX_ARGS_BYTES).toBeLessThanOrEqual(64 * 1024);
    expect(outcome(["p", "c", "x".repeat(PLUGIN_INVOKE_MAX_ARGS_BYTES)])).toBe("ok");
    expect(outcome(["p", "c", "x".repeat(budget)])).toBe("PLUGIN_PAYLOAD_TOO_LARGE");
  });

  it("counts binary and Map payloads instead of failing open on them", () => {
    expect(outcome(["p", "c", new Uint8Array(budget)])).toBe("PLUGIN_PAYLOAD_TOO_LARGE");
    expect(outcome(["p", "c", new Map([["k", "x".repeat(budget)]])])).toBe(
      "PLUGIN_PAYLOAD_TOO_LARGE"
    );
  });

  it("still enforces the arg-count cap first", () => {
    expect(() => validateIpcInvokeEnvelope("plugin:invoke", Array.from({ length: 9 }))).toThrow(
      AppError
    );
  });
});
