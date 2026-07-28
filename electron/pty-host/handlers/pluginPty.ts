import type { HandlerMap, HostContext } from "./types.js";

/**
 * Dispatcher for the raw plugin-PTY lane (#11300). Pure transport: it validates
 * that a message is structurally what it claims and forwards to
 * {@link import("../services/PluginPtyProcessManager.js").PluginPtyProcessManager}.
 * Authorization has already happened in Main — a utility process has no plugin
 * registry and must never try to re-derive it.
 */
export function createPluginPtyHandlers(ctx: HostContext): HandlerMap {
  const { pluginPtyManager } = ctx;

  return {
    "plugin-pty-spawn": (msg) => {
      if (!isRef(msg)) return;
      const options: unknown = msg.options;
      if (typeof options !== "object" || options === null) return;
      const o = options as Record<string, unknown>;
      if (typeof o.command !== "string" || o.command.length === 0) return;
      pluginPtyManager.spawn(msg.id, msg.generation, {
        command: o.command,
        args: Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === "string") : [],
        cwd: typeof o.cwd === "string" && o.cwd.length > 0 ? o.cwd : undefined,
        env: isStringRecord(o.env) ? o.env : {},
        cols: positiveInt(o.cols, DEFAULT_COLS),
        rows: positiveInt(o.rows, DEFAULT_ROWS),
      });
    },

    "plugin-pty-write": (msg) => {
      if (!isRef(msg) || typeof msg.data !== "string") return;
      pluginPtyManager.write(msg.id, msg.generation, msg.data);
    },

    "plugin-pty-resize": (msg) => {
      if (!isRef(msg)) return;
      pluginPtyManager.resize(msg.id, msg.generation, msg.cols, msg.rows);
    },

    "plugin-pty-kill": (msg) => {
      if (!isRef(msg)) return;
      if (msg.signal !== "SIGTERM" && msg.signal !== "SIGKILL") return;
      pluginPtyManager.kill(msg.id, msg.generation, msg.signal);
    },
  };
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** Every plugin-PTY message addresses one incarnation by `(id, generation)`. */
function isRef(msg: { id?: unknown; generation?: unknown }): boolean {
  return (
    typeof msg.id === "string" && msg.id.length > 0 && Number.isInteger(msg.generation as number)
  );
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value).every((v) => typeof v === "string");
}
