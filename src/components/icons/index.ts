export { DaintreeIcon } from "./DaintreeIcon";
export { McpServerIcon } from "./McpServerIcon";
export * from "./AgentStateCircles";
export { BrandMark } from "./BrandMark";
export { BrandSurface, BrandSurfaceReset, useBrandSurface } from "./BrandSurface";
export * from "./brands";

// Daintree's product-concept icons resolve to Lucide icons. Re-exported
// here so callsites can import from `@/components/icons` consistently.
// Each was chosen to fit the metaphor.
export {
  Activity, // project pulse / live activity heartbeat
  ArrowDownAZ, // alphabetical sort order (A to Z)
  ArrowLeftRight, // a settings search hit that lives in the other scope — following it switches scope
  ArrowUpDown, // card organization — pinning, collapsing and reordering a worktree row
  AtSign, // @file reference handed to an agent's prompt
  BellDot, // watch alert / notify on completion
  ChartNoAxesColumn, // frecency sort order ("Most used" — decayed access score)
  CircleCheck, // finished run — blue awaiting review, neutral once acknowledged (Pilot's review and done bands)
  CircleDashed, // run the user snoozed — quiet until it wakes (Pilot's snoozed band)
  CircleDot, // shell that is alive and doing nothing, so the amber hollow circle means waiting and only waiting (Pilot's idle band)
  CircleHelp, // workspace whose metadata is missing (removed while its agents ran)
  CirclePause, // run the user parked — shelved on purpose (Pilot's parked band)
  CircleSlash, // agent stopped on an error, distinct in shape from a waiting one (Pilot's blocked band)
  Clock, // recency sort order (most recently opened first)
  FileText, // view selected file path in the read-only file viewer
  Folder, // the project a scoped setting belongs to (settings scope: project)
  FolderGit2, // git worktree (single)
  FolderOpen, // reveal in file manager (Finder / Explorer / file manager)
  FolderOutput, // worktree living outside the project directory (external)
  FolderTree, // Daintree's own file browser panel (the worktree file tree)
  Folders, // copy tree / file hierarchy capture (two overlapping folders)
  GitBranchPlus, // per-project worktree setup — creating branches, not browsing them
  GitPullRequest, // forge provider / code-host plugin category
  Globe, // application-wide scope — the setting belongs to Daintree, not one project
  History, // resume closed session / session history
  Layers, // worktree overview (multiple worktrees, stacked)
  LayoutPanelTop, // workspace plugin category (panels, notes)
  Link2Off, // detach the issue linked to a worktree
  Menu, // the application menu, surfaced in-app where the native menu bar can't render
  Moon, // sleep a project — shut it down the way quitting does, restored on reopen
  Network, // Subagent tree — a parent session's spawned child sessions
  Package, // plugin (a packaged extension) — plugin tray, unresolved plugin glyphs
  Plug, // agent (integration that plugs into the host system)
  Plus, // the toolbar launcher — "make me a new thing" (agent, panel)
  ServerCog, // a worktree's runtime — dev-server and remote-environment lifecycle
  Sprout, // origin / first step (main worktree, first agent launch)
  TriangleAlert, // a setting failing validation — a shape, not a hue, so it survives forced colors
  Workflow, // terminal recipe / scripted command sequence
} from "lucide-react";
