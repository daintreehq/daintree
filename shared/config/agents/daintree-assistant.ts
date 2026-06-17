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
