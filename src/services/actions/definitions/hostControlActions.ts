import type { ActionRegistry } from "../actionTypes";
import {
  HostCallArgsSchema,
  HostCallResultSchema,
  HostEnsureProjectArgsSchema,
  HostEnsureProjectResultSchema,
  HostListArgsSchema,
  HostListResultSchema,
  HostSettingsArgsSchema,
  HostSettingsResultSchema,
} from "@shared/types/hostControl";

function mainProcessOnly(id: string): () => Promise<never> {
  return async () => {
    throw new Error(
      `${id} must be invoked through the MCP main-process path, not renderer dispatch.`
    );
  };
}

/**
 * A Shell's assistants' reach into its hosts (#13493), registered here for
 * manifest metadata only — schema, description, tier and audit. Execution
 * lives in the MCP CallTool handler
 * (electron/services/mcp-server/sessionServer.ts): any assistant running in
 * one of this machine's own views may call them (#13468), and they reach
 * hosts over the link from main, and this machine's other projects in
 * process under its own id, `local` (#14024). Delegating to a host's assistant is agent
 * messaging run through `host.call` (#13496), and a host's own named settings
 * are read and changed through `host.settings` (#14167).
 * `run()` throws if the renderer ever invokes it directly.
 */
export function registerHostControlActions(actions: ActionRegistry): void {
  actions.set("host.list", () => ({
    id: "host.list",
    title: "List hosts",
    description:
      "List the hosts this assistant reaches, this machine first as local, as observed: connection, load sample, agent counts and each connected host's projects, which calls name. Null means unmeasured.",
    category: "help",
    kind: "query",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["host", "remote", "assistant", "control", "load"],
    palette: { mode: "hidden" },
    argsSchema: HostListArgsSchema,
    resultSchema: HostListResultSchema,
    mcpOutputSchema: true,
    mcpAnnotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    run: mainProcessOnly("host.list"),
  }));

  actions.set("host.call", () => ({
    id: "host.call",
    title: "Run a tool on a host",
    description:
      "Run a host's own Daintree tool in one of its projects (local reaches another project here) and get its result, such as starting its assistant. Changes are refused while another machine drives that project. ambiguous: resend under its callId, which never runs twice.",
    category: "help",
    kind: "command",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["host", "remote", "call", "tool", "relay", "control"],
    palette: { mode: "hidden" },
    argsSchema: HostCallArgsSchema,
    resultSchema: HostCallResultSchema,
    mcpOutputSchema: true,
    mcpAnnotations: {
      readOnlyHint: false,
      // A resend under its callId is; a new call runs again.
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    run: mainProcessOnly("host.call"),
  }));

  actions.set("host.ensureProject", () => ({
    id: "host.ensureProject",
    title: "Bring this project to a host",
    description:
      "Make sure this project is on a host: its copy found, else cloned there, plus the branch's worktree when asked. Returns the host's projectId to run its tools in. Never pushes, opens a window or runs setup; choices for the person come back as questions. working: call again the same way.",
    category: "help",
    kind: "command",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["host", "remote", "clone", "project", "worktree", "bring"],
    palette: { mode: "hidden" },
    argsSchema: HostEnsureProjectArgsSchema,
    resultSchema: HostEnsureProjectResultSchema,
    mcpOutputSchema: true,
    mcpAnnotations: {
      readOnlyHint: false,
      // A repeat finds what the first made.
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    run: mainProcessOnly("host.ensureProject"),
  }));

  actions.set("host.settings", () => ({
    id: "host.settings",
    title: "Change a host's settings",
    description:
      "Read or change named settings on hosts, such as turning Canopy on across several. preview returns a ticket and changes nothing; apply asks the person to approve exactly that preview, then writes it. Never this machine's own settings.",
    category: "help",
    kind: "command",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["host", "remote", "settings", "canopy", "enable", "configure"],
    palette: { mode: "hidden" },
    argsSchema: HostSettingsArgsSchema,
    resultSchema: HostSettingsResultSchema,
    mcpOutputSchema: true,
    mcpAnnotations: {
      readOnlyHint: false,
      // A repeated preview makes a new ticket and can retire an older one.
      idempotentHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    run: mainProcessOnly("host.settings"),
  }));
}
