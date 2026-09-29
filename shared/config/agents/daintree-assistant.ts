import type { AgentConfig } from "../agentRegistry.js";

// The Daintree CLI assistant is a standalone orchestration agent with its own
// login and backend. Daintree does not configure model providers for it — it
// connects over MCP and discovers its own context, so context-tree injection
// is off. Retired from the assistant picker (`deprecated` tier): it is still
// detected on PATH, but never offered or provisioned as a backend, and a saved
// preference for it is dropped with a notice on the next launch.
export const config: AgentConfig = {
  id: "daintree-assistant",
  name: "Daintree Assistant",
  command: "daintree-assistant",
  color: "#2E7D32",
  iconId: "daintreeassistant",
  supportsContextInjection: false,
  packages: {
    npm: "@daintreehq/daintree-assistant",
  },
  version: {
    args: ["--version"],
    npmPackage: "@daintreehq/daintree-assistant",
  },
  capabilities: {
    resizeStrategy: "settled",
  },
  supports: {
    // The assistant connects over MCP via env vars it reads itself
    // (`DAINTREE_MCP_URL`, `DAINTREE_MCP_TOKEN`, `DAINTREE_PROJECT_ID`,
    // `DAINTREE_WINDOW_ID`) injected at spawn time — no config file is written
    // and no CLI flags are appended. See the daintree-assistant branch in
    // `electron/ipc/handlers/terminal/lifecycle.ts`.
    mcpInjection: "env-only",
    settingsOverlay: false,
    permissionBypass: false,
    trustDialog: false,
    versionProbe: true,
    tier: "deprecated",
  },
  prerequisites: [
    {
      tool: "daintree-assistant",
      label: "Daintree Assistant CLI",
      versionArgs: ["--version"],
      severity: "fatal",
    },
  ],
};
