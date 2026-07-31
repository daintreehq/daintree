export { DaintreeIcon } from "./DaintreeIcon";
export { McpServerIcon } from "./McpServerIcon";
export * from "./AgentStateCircles";
export { BrandMark } from "./BrandMark";
export * from "./brands";

// Daintree's product-concept icons resolve to Lucide icons. Re-exported
// here so callsites can import from `@/components/icons` consistently.
// Each was chosen to fit the metaphor.
export {
  Activity, // project pulse / live activity heartbeat
  ArrowDownAZ, // alphabetical sort order (A to Z)
  AtSign, // @file reference handed to an agent's prompt
  BellDot, // watch alert / notify on completion
  ChartNoAxesColumn, // frecency sort order ("Most used" — decayed access score)
  CircleCheck, // finished run awaiting review (Pilot's review band)
  Clock, // recency sort order (most recently opened first)
  FileText, // view selected file path in the read-only file viewer
  FolderGit2, // git worktree (single)
  FolderOpen, // reveal in file manager (Finder / Explorer / file manager)
  FolderOutput, // worktree living outside the project directory (external)
  FolderTree, // Daintree's own file browser panel (the worktree file tree)
  Folders, // copy tree / file hierarchy capture (two overlapping folders)
  GitPullRequest, // forge provider / code-host plugin category
  History, // resume closed session / session history
  Layers, // worktree overview (multiple worktrees, stacked)
  LayoutPanelTop, // workspace plugin category (panels, notes)
  MessageCircleQuestion, // run waiting on the user for an answer (Pilot's needs-you band)
  OctagonAlert, // run blocked after a failure, where input may not unblock it
  Package, // plugin (a packaged extension) — plugin tray, unresolved plugin glyphs
  Plug, // agent (integration that plugs into the host system)
  Radar, // the fleet overview itself — everything in flight, seen at once
  Sprout, // origin / first step (main worktree, first agent launch)
  Workflow, // terminal recipe / scripted command sequence
} from "lucide-react";
