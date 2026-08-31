import nodeModule from "node:module";
import { z } from "zod";

import type { IpcChannelCategory } from "../../../electron/ipc/utils";

/**
 * The REAL main-process IPC invoke wrapper for PERF-360..364, in a plain Node
 * process.
 *
 * `enforceIpcSenderValidation()` monkeypatches `ipcMain.handle` globally before
 * any handler is registered, so EVERY invoke channel in the app — roughly 600
 * of them — crosses the same wrapper on the way in. That wrapper validates the
 * sender frame, caps the argument count, and then `JSON.stringify`s the whole
 * argument list through `sizeGuardReplacer` purely to learn how many bytes the
 * payload is, before the handler is entered at all. Roughly sixty channels then
 * pay a zod `safeParse` on top through `typedHandleValidated` →
 * `parseIpcPayload`. Nothing measured any of it: PERF-042..046 measure the
 * utility-host FORK boundary and say so, and this main-process layer sits
 * upstream of every one of those numbers.
 *
 * WHAT IS REAL
 *   - `electron/setup/security.ts` unmodified: `enforceIpcSenderValidation`
 *     installs its real wrapper over the `ipcMain` stand-in, and every measured
 *     invoke runs the real `isTrustedRendererUrl` sender check, the real
 *     `MAX_IPC_ARG_COUNT` cap, the real `validateIpcInvokeEnvelope` with its
 *     real `sizeGuardReplacer` / `bigintSafeReplacer` pass, the real
 *     `PAYLOAD_BUDGETS` lookup through the real `channelToCategory`, the real
 *     `wrapSuccess`, and on the failure side the real `serializeError`,
 *     `sanitizeErrorForRenderer` and packaged-build field strip.
 *   - `electron/ipc/utils.ts` unmodified: handlers are registered through the
 *     real `typedHandle` and `typedHandleValidated`, so `assertIpcSecurityReady`,
 *     the perf-capture branch and the real `parseIpcPayload` → real
 *     `ValidationError` path are all in the loop.
 *   - The real `AppError` from `electron/utils/errorTypes.ts` and the real
 *     `scrubSecrets` patterns behind `sanitizeErrorForRenderer`.
 *   - One of the measured channels is the shipped `terminal:spawn`, so the
 *     category lookup and its real 256 KiB budget are the ones production uses
 *     rather than a number this file invented.
 *
 * WHAT IS NOT, AND CANNOT BE
 *   - **No Electron and no Chromium.** The bare `electron` specifier is remapped
 *     to an inert stub whose `ipcMain` is an in-memory channel map. So Mojo, the
 *     structured clone that carries the arguments across the process boundary,
 *     the 128 MiB Mojo ceiling that backstops the fail-open path, and the
 *     renderer's own `ipcRenderer.invoke` leg are all outside every number here.
 *     **These durations are the main-process wrapper's own cost, not IPC
 *     latency.** A real invoke pays a structured clone of the same arguments
 *     before the wrapper is even entered.
 *   - **`event.senderFrame` is a plain object.** In production it is a
 *     `WebFrameMain` whose `url` getter can throw once the frame is gone; here
 *     it is a string field, so the wrapper's `?.` guard is exercised but the
 *     cross-process property read is not.
 *   - **`electron/services/TelemetryService.ts` is stubbed** to its one member
 *     the wrapper calls, `getCurrentCorrelationId`, which answers `undefined`.
 *     The real module pulls `electron/store.ts` (electron-store on disk) into
 *     the graph for a function that returns an AsyncLocalStorage field. The
 *     consequence for PERF-363: the packaged branch's
 *     `if (correlationId !== undefined)` assignment is not taken, which is also
 *     what happens on any real invoke outside a correlated span.
 *   - **`console.error` is redirected to a counting sink** on the paths that log
 *     (the packaged error branch, and `parseIpcPayload`'s zod issue dump). The
 *     sink is counted and reported, so the branch is proven to have run, but the
 *     real logger's formatting and stderr write are not in the numbers.
 *   - **No fault registry.** `FAULT_MODE_ENABLED` is false outside E2E, so
 *     `applyInvokeFault` is not on the measured path — same as production.
 *   - **One promise tick per invoke.** The installed wrapper is `async`, so each
 *     measured invoke includes one microtask turn. It is identical across every
 *     arm, so the ratios this family reports are unaffected by it.
 */

// --- The bridge the module stubs read ---------------------------------------

/**
 * State the `electron` stand-in reads at call time.
 *
 * It lives on `globalThis` rather than in a closure because the stub is loaded
 * as a data: URL module by the resolve hook and shares no scope with this file.
 * `packaged` is a live read so PERF-363 can flip `app.isPackaged` between arms
 * without re-importing the graph.
 */
interface EnvelopeBridge {
  packaged: boolean;
  handlers: Map<string, IpcListener>;
}

type IpcListener = (event: FakeInvokeEvent, ...args: unknown[]) => unknown;

interface FakeInvokeEvent {
  senderFrame?: { url: string };
  sender: { id: number };
}

const BRIDGE_KEY = "__daintreePerfIpcEnvelopeBridge";

function getBridge(): EnvelopeBridge {
  const host = globalThis as unknown as Record<string, unknown>;
  const existing = host[BRIDGE_KEY];
  if (existing !== undefined) return existing as EnvelopeBridge;
  const bridge: EnvelopeBridge = { packaged: false, handlers: new Map() };
  host[BRIDGE_KEY] = bridge;
  return bridge;
}

// Created at module evaluation so the stub module, whenever it is evaluated,
// always finds a bridge rather than racing this file's initialisation.
const bridge = getBridge();

const ELECTRON_STUB_SOURCE = `
const noop = () => undefined;
const bridge = globalThis[${JSON.stringify(BRIDGE_KEY)}];
export const app = {
  get isPackaged() { return bridge.packaged; },
  getPath: () => "/tmp/daintree-perf",
  getVersion: () => "0.0.0-perf",
  getName: () => "Daintree",
  on: noop,
  once: noop,
  whenReady: () => Promise.resolve(),
};
export const ipcMain = {
  handle(channel, listener) { bridge.handlers.set(channel, listener); },
  handleOnce(channel, listener) { bridge.handlers.set(channel, listener); },
  removeHandler(channel) { bridge.handlers.delete(channel); },
  on: noop,
  once: noop,
  removeListener: noop,
  off: noop,
  removeAllListeners: noop,
};
export const session = {
  defaultSession: { setPermissionRequestHandler: noop, setPermissionCheckHandler: noop },
  fromPartition: () => ({ setPermissionRequestHandler: noop, setPermissionCheckHandler: noop }),
};
export const BrowserWindow = class { static getAllWindows() { return []; } static fromWebContents() { return null; } };
export const WebContentsView = class {};
export const webContents = { getAllWebContents: () => [], fromId: () => null };
export const shell = { openExternal: noop };
export const dialog = {};
export const net = {};
export const nativeTheme = { on: noop };
export const utilityProcess = { fork: noop };
export const safeStorage = { isEncryptionAvailable: () => false };
export default { app, ipcMain, session, BrowserWindow, WebContentsView, webContents, shell };
`;

/**
 * `getCurrentCorrelationId` is the only member of `TelemetryService` the
 * measured wrapper calls, and importing the real module drags electron-store
 * onto disk for it. Answering `undefined` matches an uncorrelated invoke.
 */
const TELEMETRY_STUB_SOURCE = `
export function getCurrentCorrelationId() { return undefined; }
export function sanitizePath(value) { return value; }
`;

function dataUrl(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

const ELECTRON_STUB_URL = dataUrl(ELECTRON_STUB_SOURCE);
const TELEMETRY_STUB_URL = dataUrl(TELEMETRY_STUB_SOURCE);

/** Suffix → stub, matched against the resolved URL with its extension removed. */
const STUB_TABLE: ReadonlyArray<readonly [string, string]> = [
  ["/electron/services/TelemetryService", TELEMETRY_STUB_URL],
];

function stubUrlFor(resolvedUrl: string): string | null {
  const withoutExt = String(resolvedUrl)
    .split("?")[0]!
    .replace(/\.(ts|js|mts|mjs)$/, "");
  for (const [suffix, url] of STUB_TABLE) {
    if (withoutExt.endsWith(suffix)) return url;
  }
  return null;
}

const HOOKS_SOURCE = `
const ELECTRON_STUB_URL = ${JSON.stringify(ELECTRON_STUB_URL)};
const STUB_TABLE = ${JSON.stringify(STUB_TABLE)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "electron") return { url: ELECTRON_STUB_URL, shortCircuit: true };
  const resolved = await nextResolve(specifier, context);
  const withoutExt = String(resolved.url).split("?")[0].replace(/\\.(ts|js|mts|mjs)$/, "");
  for (const [suffix, url] of STUB_TABLE) {
    if (withoutExt.endsWith(suffix)) return { url, shortCircuit: true };
  }
  return resolved;
}
`;

let hooksInstalled = false;

/**
 * Remap `electron` and `TelemetryService` so the main-process security and IPC
 * modules load outside Electron. `module.registerHooks` is synchronous and
 * in-thread but landed in Node 22.15 while `.nvmrc` pins 22.13, so
 * `module.register` — whose hooks run in a worker — is the fallback. Under
 * Vitest neither fires because Vite resolves imports itself, which is why the
 * unit test hands {@link perfIpcEnvelopeElectronStub} to `vi.mock` instead.
 */
function installModuleStubs(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  if (process.env.VITEST) return;

  const registerHooks = (
    nodeModule as unknown as {
      registerHooks?: (hooks: {
        resolve: (
          specifier: string,
          context: unknown,
          next: (s: string, c: unknown) => { url: string }
        ) => { url: string; shortCircuit?: boolean };
      }) => void;
    }
  ).registerHooks;

  if (typeof registerHooks === "function") {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "electron") return { url: ELECTRON_STUB_URL, shortCircuit: true };
        const resolved = nextResolve(specifier, context);
        const stub = stubUrlFor(resolved.url);
        return stub ? { url: stub, shortCircuit: true } : resolved;
      },
    });
    return;
  }

  nodeModule.register(dataUrl(HOOKS_SOURCE));
}

installModuleStubs();

const noop = (): undefined => undefined;

/** The same stand-in as a module object, for `vi.mock("electron", ...)`. */
export const perfIpcEnvelopeElectronStub = {
  app: {
    get isPackaged(): boolean {
      return getBridge().packaged;
    },
    getPath: () => "/tmp/daintree-perf",
    getVersion: () => "0.0.0-perf",
    getName: () => "Daintree",
    on: noop,
    once: noop,
    whenReady: () => Promise.resolve(),
  },
  ipcMain: {
    handle(channel: string, listener: IpcListener) {
      getBridge().handlers.set(channel, listener);
    },
    handleOnce(channel: string, listener: IpcListener) {
      getBridge().handlers.set(channel, listener);
    },
    removeHandler(channel: string) {
      getBridge().handlers.delete(channel);
    },
    on: noop,
    once: noop,
    removeListener: noop,
    off: noop,
    removeAllListeners: noop,
  },
  session: {
    defaultSession: { setPermissionRequestHandler: noop, setPermissionCheckHandler: noop },
    fromPartition: () => ({
      setPermissionRequestHandler: noop,
      setPermissionCheckHandler: noop,
    }),
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
    static fromWebContents() {
      return null;
    }
  },
  WebContentsView: class {},
  webContents: { getAllWebContents: () => [], fromId: () => null },
  shell: { openExternal: noop },
  dialog: {},
  net: {},
  nativeTheme: { on: noop },
  utilityProcess: { fork: noop },
  safeStorage: { isEncryptionAvailable: () => false },
};

// --- Channels ----------------------------------------------------------------

/** Uncategorised, so the real `DEFAULT_PAYLOAD_BUDGET` (1 MiB) applies. */
export const PLAIN_CHANNEL = "perf:envelope-plain";
/** Registered through the raw `ipcMain.handle`, for the apparatus self-check. */
export const PROBE_CHANNEL = "perf:envelope-probe";
/** What the probe listener returns, bare and unwrapped. */
export const PROBE_RESULT = "perf-envelope-probe-result";
/** Registered through the real `typedHandleValidated` with a real zod schema. */
export const VALIDATED_CHANNEL = "perf:envelope-validated";
/** Handler throws, so the wrapper's catch arm is the subject. */
export const THROWING_CHANNEL = "perf:envelope-throw";
/**
 * A SHIPPED channel, so the real `channelToCategory` lookup resolves to
 * `terminalSpawn` and the byte gate uses production's own 256 KiB budget rather
 * than one this fixture chose.
 */
export const CATEGORY_CHANNEL = "terminal:spawn";

/** Trusted in both production and development: the app's own origin. */
export const TRUSTED_SENDER_URL = "app://daintree/index.html";
export const UNTRUSTED_SENDER_URL = "https://not-daintree.example/index.html";

/** Planted into the thrown error's message; `sanitizePaths` must collapse it. */
export const PLANTED_PATH = "/Users/perf-fixture/daintree/secrets/token.txt";
/** Planted alongside it; `scrubSecrets`' github-pat pattern must redact it. */
export const PLANTED_SECRET = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;

// --- Product module views ----------------------------------------------------

/**
 * Structural views of the two product modules this fixture drives.
 *
 * `typedHandle` and `typedHandleValidated` are generic over
 * `K extends keyof IpcInvokeMap`, which is a compile-time constraint on the
 * channel NAME. A benchmark channel cannot satisfy a literal union of the app's
 * shipped channels, and widening the app's map to admit one would be a product
 * edit. The runtime path is untouched by the cast: both helpers treat the
 * channel as a string and register through the same wrapped `ipcMain.handle`.
 */
type LooseTypedHandle = (channel: string, handler: (...args: unknown[]) => unknown) => () => void;
type LooseTypedHandleValidated = (
  channel: string,
  schema: z.ZodTypeAny,
  handler: (payload: unknown) => unknown
) => () => void;

export interface EnvelopeModules {
  enforceIpcSenderValidation: () => void;
  validateIpcInvokeEnvelope: (channel: string, args: unknown[]) => void;
  sanitizeErrorForRenderer: (message: string) => string;
  MAX_IPC_ARG_COUNT: number;
  DEFAULT_PAYLOAD_BUDGET: number;
  budgetForChannel: (channel: string) => number;
  typedHandle: LooseTypedHandle;
  typedHandleValidated: LooseTypedHandleValidated;
}

// --- Envelopes ---------------------------------------------------------------

/**
 * The envelope shape the wrapper answers with. Narrow on purpose: only the
 * members the predicates read, so this never becomes a second copy of
 * `SerializedError`.
 */
export interface EnvelopeError {
  name?: string;
  message?: string;
  code?: string;
  userMessage?: string;
  stack?: string;
  path?: string;
  context?: unknown;
  cause?: unknown;
  properties?: unknown;
  correlationId?: string;
}

export interface Envelope {
  __daintreeIpcEnvelope?: true;
  ok?: boolean;
  data?: unknown;
  error?: EnvelopeError;
}

/** What the plain and category handlers answer with, so a round trip is O(1). */
interface EchoResult {
  echo: unknown;
  argCount: number;
}

// --- Harness -----------------------------------------------------------------

export interface EnvelopeHarness {
  modules: EnvelopeModules;
  /** Invoke through the wrapper with a trusted sender frame. */
  invoke: (channel: string, ...args: unknown[]) => Promise<Envelope>;
  /** Invoke with a chosen sender URL; `null` omits `senderFrame` entirely. */
  invokeAs: (senderUrl: string | null, channel: string, args: unknown[]) => Promise<Envelope>;
  /** True when the registered listener is NOT the one handed to `typedHandle`. */
  wrapperInstalled: boolean;
  /** Production's own byte budget for a channel, via the real category table. */
  budgetFor: (channel: string) => number;
  setPackaged: (packaged: boolean) => void;
  /** Redirect `console.error` to a counter; returns the restore function. */
  captureConsoleErrors: () => () => number;
  /** The payload the validated channel's schema last parsed successfully. */
  lastValidatedPayload: () => unknown;
}

let harnessPromise: Promise<EnvelopeHarness> | null = null;

function plainHandler(...args: unknown[]): EchoResult {
  return { echo: args[0], argCount: args.length };
}

/**
 * A payload schema of realistic width for a validated channel — the shipped
 * ones sit between four and twenty fields. Written here rather than imported
 * so the corpus this family prices is stable when a product schema is edited.
 */
export const VALIDATED_SCHEMA = z.object({
  terminalId: z.string().min(1),
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
  cwd: z.string().min(1),
  agentId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  shell: z.string().optional(),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  restore: z.boolean(),
  label: z.string().max(256),
});

export const VALIDATED_SCHEMA_FIELD_COUNT = 12;

export function validPayloadForSchema(pad: string): Record<string, unknown> {
  return {
    terminalId: "term-perf-0",
    projectId: "proj-perf-0",
    worktreeId: "wt-perf-0",
    cwd: "/tmp/daintree-perf/worktree",
    agentId: "claude",
    cols: 120,
    rows: 40,
    shell: "/bin/zsh",
    args: ["--perf", "--envelope"],
    env: { PATH: "/usr/bin:/bin", HOME: "/tmp/daintree-perf", DAINTREE_PAD: pad },
    restore: false,
    label: "perf envelope validated channel",
  };
}

/** Fails `cols: z.number().int().positive()` and nothing else. */
export function invalidPayloadForSchema(pad: string): Record<string, unknown> {
  return { ...validPayloadForSchema(pad), cols: -1 };
}

async function buildHarness(): Promise<EnvelopeHarness> {
  const securityModule = await import("../../../electron/setup/security");
  const utilsModule = await import("../../../electron/ipc/utils");
  const errorTypes = await import("../../../electron/utils/errorTypes");
  const { ipcMain } = await import("electron");

  // The wrapper rebinds `ipcMain.handle` on every call, so a second call would
  // double-wrap and price the gate twice.
  securityModule.enforceIpcSenderValidation();

  const budgetForChannel = (channel: string): number => {
    const category: IpcChannelCategory | undefined = utilsModule.channelToCategory[channel];
    return category !== undefined
      ? securityModule.PAYLOAD_BUDGETS[category]
      : securityModule.DEFAULT_PAYLOAD_BUDGET;
  };

  const typedHandle = utilsModule.typedHandle as unknown as LooseTypedHandle;
  const typedHandleValidated =
    utilsModule.typedHandleValidated as unknown as LooseTypedHandleValidated;

  let lastValidatedPayload: unknown = undefined;

  typedHandle(PLAIN_CHANNEL, plainHandler);
  typedHandle(CATEGORY_CHANNEL, plainHandler);

  const throwingHandler = (): never => {
    const error = new errorTypes.AppError({
      code: "INTERNAL",
      message: `perf envelope failure reading ${PLANTED_PATH} with ${PLANTED_SECRET}`,
      userMessage: `Could not read ${PLANTED_PATH}.`,
      context: { channel: THROWING_CHANNEL, attempt: 1, path: PLANTED_PATH },
      cause: new Error("perf envelope inner cause"),
    });
    throw error;
  };
  typedHandle(THROWING_CHANNEL, throwingHandler);

  const validatedHandler = (payload: unknown): EchoResult => {
    lastValidatedPayload = payload;
    return { echo: payload, argCount: 1 };
  };
  typedHandleValidated(VALIDATED_CHANNEL, VALIDATED_SCHEMA, validatedHandler);

  // Apparatus self-check, in the spirit of the spawn observer's: register a
  // listener through the RAW `ipcMain.handle` that returns a bare string, then
  // invoke it. `typedHandle` wraps handlers too, so "the registered listener is
  // not the one I passed" proves nothing about the global monkeypatch — only an
  // envelope appearing around a bare return value does. If
  // `enforceIpcSenderValidation` were not installed, the probe would answer with
  // the string itself.
  const probeListener = (): string => PROBE_RESULT;
  ipcMain.handle(PROBE_CHANNEL, probeListener);

  const invokeAs = async (
    senderUrl: string | null,
    channel: string,
    args: unknown[]
  ): Promise<Envelope> => {
    const listener = bridge.handlers.get(channel);
    if (listener === undefined) {
      throw new Error(`perf envelope fixture: no handler registered for ${channel}`);
    }
    const event: FakeInvokeEvent =
      senderUrl === null
        ? { sender: { id: 1 } }
        : { senderFrame: { url: senderUrl }, sender: { id: 1 } };
    return (await listener(event, ...args)) as Envelope;
  };

  const probeEnvelope = await invokeAs(TRUSTED_SENDER_URL, PROBE_CHANNEL, []);
  const wrapperInstalled =
    probeEnvelope?.__daintreeIpcEnvelope === true &&
    probeEnvelope.ok === true &&
    probeEnvelope.data === PROBE_RESULT;

  return {
    modules: {
      enforceIpcSenderValidation: securityModule.enforceIpcSenderValidation,
      validateIpcInvokeEnvelope: securityModule.validateIpcInvokeEnvelope,
      sanitizeErrorForRenderer: securityModule.sanitizeErrorForRenderer,
      MAX_IPC_ARG_COUNT: securityModule.MAX_IPC_ARG_COUNT,
      DEFAULT_PAYLOAD_BUDGET: securityModule.DEFAULT_PAYLOAD_BUDGET,
      budgetForChannel,
      typedHandle,
      typedHandleValidated,
    },
    invoke: (channel, ...args) => invokeAs(TRUSTED_SENDER_URL, channel, args),
    invokeAs,
    wrapperInstalled,
    budgetFor: budgetForChannel,
    setPackaged: (packaged: boolean) => {
      bridge.packaged = packaged;
    },
    captureConsoleErrors: () => {
      const original = console.error;
      let count = 0;
      console.error = () => {
        count += 1;
      };
      return () => {
        console.error = original;
        return count;
      };
    },
    lastValidatedPayload: () => lastValidatedPayload,
  };
}

/** Load the graph and register the benchmark channels. Once per process. */
export function loadEnvelopeHarness(): Promise<EnvelopeHarness> {
  harnessPromise ??= buildHarness();
  return harnessPromise;
}

// --- Independent byte arithmetic --------------------------------------------

/**
 * What the subject's byte gate must arrive at, computed without it.
 *
 * Plain `JSON.stringify` with NO replacer, so this shares no code with
 * `sizeGuardReplacer` and takes V8's iterative serializer rather than the
 * recursive one a replacer forces. For every payload class the scenarios
 * measure — plain objects, arrays and strings — the two produce byte-identical
 * output, which is exactly the equality PERF-360's predicate asserts.
 */
export function jsonArgBytes(args: unknown[]): number {
  return Buffer.byteLength(JSON.stringify(args), "utf8");
}

/**
 * Build an argument list whose {@link jsonArgBytes} is EXACTLY `targetBytes`.
 *
 * The pad is ASCII, so one byte per character and the correction converges in
 * two passes. Exactness is what makes the budget-boundary oracle worth having:
 * a payload one byte under the budget must be accepted and one byte over must
 * be rejected, and a wrapper whose arithmetic drifts by a single byte fails one
 * side or the other.
 */
export function padToExactBytes(build: (pad: string) => unknown[], targetBytes: number): unknown[] {
  let padLength = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const args = build("x".repeat(padLength));
    const bytes = jsonArgBytes(args);
    if (bytes === targetBytes) return args;
    const next = padLength + (targetBytes - bytes);
    if (next < 0) {
      throw new Error(`perf envelope fixture: ${targetBytes} bytes is below the shape's own floor`);
    }
    padLength = next;
  }
  throw new Error(`perf envelope fixture: could not pad to exactly ${targetBytes} bytes`);
}

// --- Payload shapes ----------------------------------------------------------

export type PayloadShape = "flat" | "wide" | "deep" | "array";

export const WIDE_KEY_COUNT = 1_500;
/**
 * Deep enough to be a genuinely nested payload and far short of the depth at
 * which `JSON.stringify` WITH a replacer overflows the stack (measured at
 * between 5,000 and 20,000 on this runtime). PERF-364 owns the overflow case.
 */
export const DEEP_CHAIN_DEPTH = 2_000;
export const ARRAY_ROW_COUNT = 900;

/**
 * The byte size every shape in PERF-361 is padded to, so the four arms differ
 * only in structure. It sits above each shape's own unpadded floor — the widest
 * is `array` at roughly 38 KiB — because a target below the floor would silently
 * become "whatever that shape's minimum happens to be".
 */
export const SHAPE_TARGET_BYTES = 64 * 1024;

function flatArgs(pad: string): unknown[] {
  return [{ id: "perf-flat", channel: PLAIN_CHANNEL, payload: pad }];
}

function wideArgs(pad: string): unknown[] {
  const record: Record<string, unknown> = {};
  for (let index = 0; index < WIDE_KEY_COUNT; index += 1) {
    record[`field${index}`] = `value-${index}`;
  }
  record.pad = pad;
  return [record];
}

function deepArgs(pad: string): unknown[] {
  let node: Record<string, unknown> = { leaf: true, pad };
  for (let depth = 0; depth < DEEP_CHAIN_DEPTH; depth += 1) {
    node = { child: node };
  }
  return [node];
}

function arrayArgs(pad: string): unknown[] {
  const rows: unknown[] = [];
  for (let index = 0; index < ARRAY_ROW_COUNT; index += 1) {
    rows.push({ id: index, name: `row-${index}`, size: index * 7, ok: index % 2 === 0 });
  }
  return [{ rows, pad }];
}

const SHAPE_BUILDERS: Record<PayloadShape, (pad: string) => unknown[]> = {
  flat: flatArgs,
  wide: wideArgs,
  deep: deepArgs,
  array: arrayArgs,
};

/** An argument list of the named shape, padded to exactly `targetBytes`. */
export function buildShapedArgs(shape: PayloadShape, targetBytes: number): unknown[] {
  return padToExactBytes(SHAPE_BUILDERS[shape], targetBytes);
}

/** A flat argument list of exactly `targetBytes`, the size-sweep corpus. */
export function buildSizedArgs(targetBytes: number): unknown[] {
  return padToExactBytes(flatArgs, targetBytes);
}

// --- Deep-chain arithmetic (PERF-364) ---------------------------------------

/**
 * A plain-object chain `{"a":{"a":...{"a":1}}}` nested `depth` levels.
 *
 * Built iteratively, and its serialized size is known WITHOUT serializing it:
 * the array brackets are 2 bytes, each level contributes the 5 bytes of `{"a":`
 * plus its closing `}`, and the innermost value `1` is 1 byte. That arithmetic
 * is what lets PERF-364 state how large a payload slipped past the byte gate
 * unmeasured, on a payload the gate could not measure and neither can this
 * fixture.
 */
export function buildDeepChainArgs(depth: number): unknown[] {
  let node: unknown = 1;
  for (let level = 0; level < depth; level += 1) {
    node = { a: node };
  }
  return [node];
}

export function deepChainArgBytes(depth: number): number {
  return depth * 6 + 3;
}

/**
 * Whether `JSON.stringify` overflows the stack on a chain this deep when a
 * replacer is supplied.
 *
 * The probe uses an IDENTITY replacer, not the product's guard: a replacer of
 * any kind moves V8 off its iterative serializer onto the recursive one, and
 * that — not anything in `sizeGuardReplacer` — is what sets the depth ceiling.
 * The scenario reads this to decide whether its corpus still exercises the
 * fail-open path it claims to, rather than assuming a stack size.
 */
export function deepChainOverflowsStringify(depth: number): boolean {
  try {
    JSON.stringify(buildDeepChainArgs(depth), (_key, value: unknown) => value);
    return false;
  } catch {
    return true;
  }
}

// --- Structural comparison ---------------------------------------------------

/** Deep structural equality over JSON-shaped values. Bounded by construction. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
}

// --- Shared graders ----------------------------------------------------------

/**
 * The core wrapper terms every scenario in this family declares.
 *
 * Each accumulator covers ONE operation the wrapper performs on every invoke,
 * so an operation that is deleted cannot hide behind an aggregate that another
 * operation still satisfies:
 *
 *   `wrapperInstallMisses`  — the global monkeypatch is still in place, checked
 *                             by identity against the listener that was handed
 *                             to `typedHandle`.
 *   `senderTrustMisses`     — the frame check, graded in BOTH directions: an
 *                             untrusted origin and an absent frame must be
 *                             rejected, and the trusted origin must pass.
 *   `argCountMisses`        — the `MAX_IPC_ARG_COUNT` cap, both directions: the
 *                             cap itself accepted, one over it rejected.
 *   `byteMeasurementMisses` — the `JSON.stringify` size pass, pinned to the
 *                             byte on the real budget: a payload of exactly the
 *                             budget accepted, exactly one byte more rejected
 *                             with the byte count the wrapper measured equal to
 *                             this fixture's own arithmetic.
 *   `roundTripMisses`       — the listener really ran and `wrapSuccess` carried
 *                             its result back unchanged.
 *
 * A wrapper stubbed to return immediately scores on every rejecting term; one
 * stubbed to throw scores on every accepting term.
 */
export interface CoreGrade {
  wrapperInstallMisses: number;
  senderTrustMisses: number;
  argCountMisses: number;
  byteMeasurementMisses: number;
  roundTripMisses: number;
}

export function emptyCoreGrade(): CoreGrade {
  return {
    wrapperInstallMisses: 0,
    senderTrustMisses: 0,
    argCountMisses: 0,
    byteMeasurementMisses: 0,
    roundTripMisses: 0,
  };
}

function isOk(envelope: Envelope | undefined): boolean {
  return envelope?.__daintreeIpcEnvelope === true && envelope.ok === true;
}

function isRejected(envelope: Envelope | undefined): boolean {
  return envelope?.__daintreeIpcEnvelope === true && envelope.ok === false;
}

/** O(1) proof that the listener received our exact arguments object back. */
export function echoedInput(envelope: Envelope | undefined, sent: unknown): boolean {
  if (!isOk(envelope)) return false;
  const data = envelope?.data as EchoResult | undefined;
  return data !== undefined && data.echo === sent;
}

/**
 * Run the shared two-directional probes against the real wrapper.
 *
 * Every expectation here is arithmetic this fixture did itself — the exact byte
 * count, the budget read off the product's own constant table, the arg-count
 * cap — never a second call into the subject asking it what it thinks.
 */
export async function gradeCore(harness: EnvelopeHarness): Promise<CoreGrade> {
  const grade = emptyCoreGrade();

  if (!harness.wrapperInstalled) grade.wrapperInstallMisses += 1;

  // Sender frame, both directions.
  const trusted = await harness.invokeAs(TRUSTED_SENDER_URL, PLAIN_CHANNEL, [{ probe: "trusted" }]);
  if (!isOk(trusted)) grade.senderTrustMisses += 1;
  const untrusted = await harness.invokeAs(UNTRUSTED_SENDER_URL, PLAIN_CHANNEL, [
    { probe: "untrusted" },
  ]);
  if (!isRejected(untrusted)) grade.senderTrustMisses += 1;
  const frameless = await harness.invokeAs(null, PLAIN_CHANNEL, [{ probe: "frameless" }]);
  if (!isRejected(frameless)) grade.senderTrustMisses += 1;

  // Argument count, both directions across the cap.
  const atCap = Array.from({ length: harness.modules.MAX_IPC_ARG_COUNT }, (_, i) => ({ i }));
  const overCap = Array.from({ length: harness.modules.MAX_IPC_ARG_COUNT + 1 }, (_, i) => ({ i }));
  const atCapEnvelope = await harness.invoke(PLAIN_CHANNEL, ...atCap);
  if (!isOk(atCapEnvelope)) grade.argCountMisses += 1;
  const atCapData = atCapEnvelope.data as EchoResult | undefined;
  if (atCapData?.argCount !== harness.modules.MAX_IPC_ARG_COUNT) grade.argCountMisses += 1;
  const overCapEnvelope = await harness.invoke(PLAIN_CHANNEL, ...overCap);
  if (!isRejected(overCapEnvelope)) grade.argCountMisses += 1;
  if (overCapEnvelope.error?.code !== "ARG_COUNT_EXCEEDED") grade.argCountMisses += 1;

  // Byte gate, pinned to the byte on the real category budget.
  const budget = harness.budgetFor(CATEGORY_CHANNEL);
  const atBudget = buildSizedArgs(budget);
  const overBudget = buildSizedArgs(budget + 1);
  const atBudgetEnvelope = await harness.invokeAs(TRUSTED_SENDER_URL, CATEGORY_CHANNEL, atBudget);
  if (!isOk(atBudgetEnvelope)) grade.byteMeasurementMisses += 1;
  const overBudgetEnvelope = await harness.invokeAs(
    TRUSTED_SENDER_URL,
    CATEGORY_CHANNEL,
    overBudget
  );
  if (!isRejected(overBudgetEnvelope)) grade.byteMeasurementMisses += 1;
  if (overBudgetEnvelope.error?.code !== "PAYLOAD_TOO_LARGE") grade.byteMeasurementMisses += 1;
  const reportedBytes = readReportedBytes(overBudgetEnvelope);
  if (reportedBytes !== jsonArgBytes(overBudget)) grade.byteMeasurementMisses += 1;

  // Round trip: the listener ran, and the payload came back structurally intact.
  const probe = buildShapedArgs("array", SHAPE_TARGET_BYTES);
  const probeEnvelope = await harness.invokeAs(TRUSTED_SENDER_URL, PLAIN_CHANNEL, probe);
  if (!echoedInput(probeEnvelope, probe[0])) grade.roundTripMisses += 1;
  const twin = buildShapedArgs("array", SHAPE_TARGET_BYTES);
  const echoed = (probeEnvelope.data as EchoResult | undefined)?.echo;
  if (!jsonEqual(echoed, twin[0])) grade.roundTripMisses += 1;

  return grade;
}

/**
 * The byte count the wrapper itself measured, read out of the rejection it
 * raised. `AppError.context` survives `serializeError` on the unpackaged path,
 * and the message carries the same number, so either source proves the gate's
 * arithmetic. The context is preferred; the message is the fallback for a
 * packaged-shaped envelope where context has been stripped.
 */
export function readReportedBytes(envelope: Envelope): number | null {
  const context = envelope.error?.context;
  if (context !== null && typeof context === "object") {
    const bytes = (context as Record<string, unknown>).bytes;
    if (typeof bytes === "number") return bytes;
  }
  const match = /: (\d+) > \d+ bytes$/.exec(envelope.error?.message ?? "");
  return match === null ? null : Number.parseInt(match[1]!, 10);
}

export function coreMisses(grade: CoreGrade): Record<string, number> {
  return {
    wrapperInstallMisses: grade.wrapperInstallMisses,
    senderTrustMisses: grade.senderTrustMisses,
    argCountMisses: grade.argCountMisses,
    byteMeasurementMisses: grade.byteMeasurementMisses,
    roundTripMisses: grade.roundTripMisses,
  };
}
