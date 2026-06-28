import type { AgentConfig } from "../agentRegistry.js";

// The Daintree CLI assistant is a standalone orchestration agent with its own
// login and backend. Daintree does not configure model providers for it — it
// connects over MCP and discovers its own context, so context-tree injection
// is off. Wired at `stable` tier: structurally enabled, auto-detected on PATH
// by CliAvailabilityService, and surfaced in the assistant picker.
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
    tier: "stable",
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
