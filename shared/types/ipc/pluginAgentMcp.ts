/**
 * How much of a plugin's agent tools a project's agents may use: none, the
 * host's read-only database tools, or those and the plugin's own tools.
 */
export const AGENT_MCP_ACCESS_LEVELS = ["off", "read-only", "read-write"] as const;
export type AgentMcpAccess = (typeof AGENT_MCP_ACCESS_LEVELS)[number];

/** Where a plugin's effective access in a project comes from. */
export type AgentMcpAccessSource =
  /** The user's own answer for this project. */
  | "project"
  /** An installed plugin following the user's answer for every project. */
  | "all-projects"
  /** A project plugin following the repository's `.daintree/mcp.json`. */
  | "repository"
  /** Nobody said anything: off. */
  | "default";

/**
 * One plugin as a project's settings see it: what agent tools it offers, and
 * how much of them this project's agents may use.
 */
export interface ProjectAgentToolPlugin {
  /** Plugin instance key — what access is stored against. */
  pluginInstanceId: string;
  pluginDisplayName: string;
  origin: "installed" | "project";
  /** The plugin declares databases, so the host offers read-only tools for them. */
  hasDatabases: boolean;
  /**
   * An installed plugin with databases: they are one set of files shared by
   * every project, and the host's database tools can't filter them by project,
   * so any level that includes those tools lets agents here read what the
   * plugin stored for the user's other projects.
   */
  sharedAcrossProjects?: true;
  /** The plugin's own `agentMcp` endpoint, when it declares one. */
  pluginTools?: { name: string; description?: string };
  access: AgentMcpAccess;
  source: AgentMcpAccessSource;
  /** Installed plugins only: the access every project without its own answer gets. */
  allProjectsAccess?: AgentMcpAccess;
  /** Project plugins only: what the repository's `.daintree/mcp.json` sets, when it names the plugin. */
  repositoryAccess?: AgentMcpAccess;
  /**
   * An answer given before access levels existed keeps the plugin's own tools
   * on and its database tools off; any new choice replaces it.
   */
  databasesWithheld?: boolean;
  /**
   * False for a plugin whose access is on for this project but that no running
   * plugin currently offers here (it was disabled, uninstalled or changed its
   * manifest). The answer is kept, so it is listed and can be turned off; it
   * can't be turned back on until the plugin offers tools again.
   */
  available: boolean;
}

export interface ProjectAgentToolsSnapshot {
  plugins: ProjectAgentToolPlugin[];
  /**
   * Agents reach plugin tools over Daintree's MCP listener, so access that is
   * on does nothing while the listener is switched off.
   */
  mcpServerEnabled: boolean;
}

export interface SetProjectAgentToolAccessPayload {
  pluginInstanceId: string;
  /** Null clears the answer at that scope, so the plugin follows the next one down. */
  access: AgentMcpAccess | null;
  /** `"all-projects"` is for installed plugins only. */
  scope: "project" | "all-projects";
}
