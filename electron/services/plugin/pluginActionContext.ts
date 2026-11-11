import type { ActionSource } from "../../../shared/types/actions.js";
import type { PluginActionContext } from "../../../shared/types/plugin.js";

const ACTION_SOURCES: ReadonlySet<string> = new Set<ActionSource>([
  "user",
  "keybinding",
  "menu",
  "agent",
  "context-menu",
  "plugin",
]);

const CONTEXT_KEYS: ReadonlySet<string> = new Set(["dispatchSource", "origin", "approval"]);

/**
 * The context a handler gets when nothing attested its dispatch: a panel's own
 * `plugin.invoke`, an event route, a call from another plugin. Says nothing
 * about a person or an assistant, because nothing here saw either.
 */
export const UNATTESTED_PLUGIN_ACTION_CONTEXT: PluginActionContext = Object.freeze({
  dispatchSource: "plugin",
});

/**
 * Validate a dispatch context sent across a process boundary and rebuild it as a
 * fresh frozen object holding only the fields the contract names (#16751).
 * Throws on anything else: an unknown key, a value outside its literal, or a
 * combination no host surface produces. Only the agent source has an MCP
 * session to name, and a plugin's own dispatch has no confirm dialog to answer.
 */
export function parsePluginActionContext(raw: unknown): PluginActionContext {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Plugin action context must be an object");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!CONTEXT_KEYS.has(key)) throw new Error(`Plugin action context has unknown field "${key}"`);
  }
  const { dispatchSource, origin, approval } = record;
  if (typeof dispatchSource !== "string" || !ACTION_SOURCES.has(dispatchSource)) {
    throw new Error("Plugin action context has an invalid dispatchSource");
  }
  if (origin !== undefined && origin !== "assistant") {
    throw new Error("Plugin action context has an invalid origin");
  }
  if (approval !== undefined && approval !== "person") {
    throw new Error("Plugin action context has an invalid approval");
  }
  if (origin !== undefined && dispatchSource !== "agent") {
    throw new Error('Plugin action context origin requires dispatchSource "agent"');
  }
  if (approval !== undefined && dispatchSource === "plugin") {
    throw new Error('Plugin action context approval is never set for dispatchSource "plugin"');
  }
  return Object.freeze({
    dispatchSource: dispatchSource as ActionSource,
    ...(origin !== undefined ? { origin } : {}),
    ...(approval !== undefined ? { approval } : {}),
  });
}
