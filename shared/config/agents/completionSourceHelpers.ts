import type { CompletionEnvName, CompletionLocation } from "../../types/completionSources.js";

/**
 * The standard project/user/global search locations an agent keeps its
 * commands or skills under. Mirrors the hand-rolled `get<Agent>SearchPaths`
 * builders the discovery engine replaced, one-for-one:
 *  - project `<projectRoot>/<dotDir>/<sub>`
 *  - user native `<CONFIG_ENV | ~/<dotDir>>/<sub>`
 *  - user XDG `<XDG_CONFIG_HOME | ~/.config>/<lowerName>/<sub>`
 *  - global app-support (macOS per-user + system, Windows ProgramData)
 *  - global system dirs (Linux `/etc`, `/usr/local/share`)
 *
 * `locationPrecedence` reproduces the former array order's later-wins rule
 * within a scope: XDG beats native user; the system app-support/`/usr/local`
 * dir beats the per-user/`/etc` one.
 */
export function standardConfigLocations(opts: {
  /** Project + home-relative fallback dir, e.g. ".claude". */
  dotDir: string;
  /** Final segment appended in every location, e.g. "commands" or "skills". */
  sub: string;
  /** User override env for the home dir, e.g. "CLAUDE_CONFIG_DIR". */
  configDirEnv: CompletionEnvName;
  /** Lowercase name under XDG + Linux system paths, e.g. "claude". */
  lowerName: string;
  /** Capitalised name under macOS/Windows app-support, e.g. "Claude". */
  appName: string;
}): CompletionLocation[] {
  const { dotDir, sub, configDirEnv, lowerName, appName } = opts;
  return [
    {
      id: `project:${sub}`,
      scope: "project",
      base: { type: "projectRoot" },
      segments: [dotDir, sub],
      locationPrecedence: 0,
    },
    {
      id: `user-native:${sub}`,
      scope: "user",
      base: {
        type: "env",
        name: configDirEnv,
        fallback: { type: "homeRelative", segments: [dotDir] },
      },
      segments: [sub],
      locationPrecedence: 0,
    },
    {
      id: `user-xdg:${sub}`,
      scope: "user",
      base: {
        type: "env",
        name: "XDG_CONFIG_HOME",
        fallback: { type: "homeRelative", segments: [".config"] },
      },
      segments: [lowerName, sub],
      locationPrecedence: 1,
    },
    {
      id: `global-user-app-support:${sub}`,
      scope: "global",
      base: { type: "homeRelative", segments: ["Library", "Application Support"] },
      segments: [appName, sub],
      platforms: ["darwin"],
      locationPrecedence: 0,
    },
    {
      id: `global-system-app-support:${sub}`,
      scope: "global",
      base: { type: "absolute", path: "/Library/Application Support" },
      segments: [appName, sub],
      platforms: ["darwin"],
      locationPrecedence: 1,
    },
    {
      id: `global-programdata:${sub}`,
      scope: "global",
      base: {
        type: "env",
        name: "ProgramData",
        fallback: { type: "absolute", path: "C:\\ProgramData" },
      },
      segments: [appName, sub],
      platforms: ["win32"],
      locationPrecedence: 0,
    },
    {
      id: `global-etc:${sub}`,
      scope: "global",
      base: { type: "absolute", path: "/etc" },
      segments: [lowerName, sub],
      platforms: ["linux"],
      locationPrecedence: 0,
    },
    {
      id: `global-usr-local:${sub}`,
      scope: "global",
      base: { type: "absolute", path: "/usr/local/share" },
      segments: [lowerName, sub],
      platforms: ["linux"],
      locationPrecedence: 1,
    },
  ];
}
