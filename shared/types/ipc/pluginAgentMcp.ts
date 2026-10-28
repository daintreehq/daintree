/**
 * How much of a plugin's agent tools a project's agents may use: none, the
 * host's read-only database tools, or those and the plugin's own tools. For a
 * plugin whose tools come in declared groups, the level covers its database
 * tools alone; each group is allowed on its own.
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
  /** Some of its declared database queries write; only read and write access serves them. */
  hasDatabaseWrites?: true;
  /**
   * An installed plugin with databases: they are one set of files shared by
   * every project, and the host's database tools can't filter them by project,
   * so any level that includes those tools lets agents here read what the
   * plugin stored for the user's other projects.
   */
  sharedAcrossProjects?: true;
  /** The plugin's own `agentMcp` endpoint, when it declares one. */
  pluginTools?: { name: string; description?: string };
  /**
   * The groups the plugin's own tools come in, when it declares any. No level
   * reaches them; `access` is then about its database tools alone.
   */
  toolGroups?: ProjectAgentToolGroup[];
  access: AgentMcpAccess;
  source: AgentMcpAccessSource;
  /** Installed plugins only: the access every project without its own answer gets. */
  allProjectsAccess?: AgentMcpAccess;
  /** Installed plugins with tool groups only: the groups every project without its own answer gets. */
  allProjectsGroups?: string[];
  /** Project plugins only: what the repository's `.daintree/mcp.json` sets, when it names the plugin. */
  repositoryAccess?: AgentMcpAccess;
  /**
   * An answer given before access levels existed keeps the plugin's own tools
   * on and its database tools off; any new choice replaces it.
   */
  databasesWithheld?: boolean;
  /**
   * The plugin's own tools are on from a choice that predates declared writes
   * (an answer kept per endpoint, or a repository's endpoint list), which never
   * covers them; choosing read and write includes them.
   */
  writesWithheld?: true;
  /**
   * How much of the plugin's tools the user lets this project's Daintree
   * Assistant use. Never more than `access` takes effect, and only the user
   * sets it: nothing in the repository and no default for every project does.
   */
  assistantAccess: AgentMcpAccess;
  /**
   * False for a plugin whose access is on for this project but that no running
   * plugin currently offers here (it was disabled, uninstalled or changed its
   * manifest). The answer is kept, so it is listed and can be turned off; it
   * can't be turned back on until the plugin offers tools again.
   */
  available: boolean;
}

/** One declared group of a plugin's own tools, and who may use it in this project. */
export interface ProjectAgentToolGroup {
  id: string;
  name: string;
  description?: string;
  /** What the plugin says the group's tools do. Its own description; nothing the host checked. */
  access: "read" | "write";
  /** This project's agents may use it. */
  allowed: boolean;
  /**
   * The user allowed this project's Daintree Assistant to use it. Reaches the
   * Assistant only while `allowed` holds too; kept on record, and switchable
   * off, while it doesn't.
   */
  assistantAllowed: boolean;
  /**
   * Allowed once as reading tools, and the plugin now says they change things
   * (or the other way round): off until allowed again.
   */
  reclassified?: true;
}

export interface ProjectAgentToolsSnapshot {
  plugins: ProjectAgentToolPlugin[];
  /**
   * Agents reach plugin tools over Daintree's MCP listener, so access that is
   * on does nothing while the listener is switched off.
   */
  mcpServerEnabled: boolean;
  /**
   * Agents running in this project whose plugin tools no longer match what a
   * launch would get now: access was widened, or a plugin came back with a
   * different set of tools. Their tools only change when they are relaunched.
   * A reload that kept the same tools never lists an agent here.
   */
  relaunchNeeded: AgentToolsRelaunchSession[];
}

/** One running agent that would get different plugin tools if it were relaunched. */
export interface AgentToolsRelaunchSession {
  terminalId: string;
  /** The plugins whose tools it would gain or whose tools changed. */
  pluginDisplayNames: string[];
}

/**
 * Where a plugin's agent tools stand for one launch that requires them:
 * - `ready`: handed to this launch with a live credential.
 * - `unsupported-format`: the agent has no way to be handed MCP servers.
 * - `disabled-access`: the plugin runs here, but its agent tools are off in this project.
 * - `pending-load`: plugins were still loading when the launch stopped waiting.
 * - `unavailable`: loading finished and the plugin isn't running here or offers no agent tools.
 * - `listener-failed`: Daintree's MCP listener couldn't start.
 * - `config-failed`: preparing the agent's MCP configuration failed.
 * - `revoked`: access or the plugin changed while the launch was being prepared.
 */
export type RequiredPluginToolsState =
  | "ready"
  | "unsupported-format"
  | "disabled-access"
  | "pending-load"
  | "unavailable"
  | "listener-failed"
  | "config-failed"
  | "revoked";

export const REQUIRED_PLUGIN_TOOLS_STATES: readonly RequiredPluginToolsState[] = [
  "ready",
  "unsupported-format",
  "disabled-access",
  "pending-load",
  "unavailable",
  "listener-failed",
  "config-failed",
  "revoked",
];

export interface RequiredPluginToolStatus {
  pluginInstanceId: string;
  pluginDisplayName: string;
  state: RequiredPluginToolsState;
}

/** The structured detail a launch refused for missing required plugin tools carries. */
export interface RequiredPluginToolsError {
  code: "REQUIRED_PLUGIN_TOOLS_UNAVAILABLE";
  tools: RequiredPluginToolStatus[];
}

export type SetProjectAgentToolAccessPayload =
  | {
      pluginInstanceId: string;
      /** Null clears the answer at that scope, so the plugin follows the next one down. */
      access: AgentMcpAccess | null;
      /** `"all-projects"` is for installed plugins only. */
      scope: "project" | "all-projects";
      /**
       * The ids of every tool group to allow, replacing those allowed now.
       * Absent keeps the groups this project's agents have now.
       */
      groups?: string[];
    }
  | {
      pluginInstanceId: string;
      /** No more than this project's agents have; off is always accepted. */
      access: AgentMcpAccess;
      /** The project's Daintree Assistant. */
      scope: "assistant";
      /** As for the project: every tool group the Assistant may use, none of them more than the agents have. */
      groups?: string[];
    };
