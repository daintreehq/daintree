import type { AgentConfig } from "../agentRegistry.js";

// The Daintree CLI assistant is a standalone orchestration agent with its own
// login and backend. Daintree does not configure model providers for it — it
// connects over MCP and discovers its own context, so context-tree injection
// is off. Wired at `experimental` tier: structurally enabled and auto-detected
// on PATH by CliAvailabilityService, but hidden from the stable assistant
// picker until the wiring is validated end to end.
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
    // Placeholder until the assistant launch path is wired end to end. The
    // assistant connects over MCP via env vars it reads itself, not a written
    // config file — `mcpInjection` is a required two-value enum with no
    // env-only option, so this records the nearest intended mechanism. It is
    // inert at `experimental` tier (no project-config is written today).
    mcpInjection: "project-config",
    settingsOverlay: false,
    permissionBypass: false,
    trustDialog: false,
    versionProbe: true,
    tier: "experimental",
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
