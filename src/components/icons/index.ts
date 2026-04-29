export { DaintreeIcon } from "./DaintreeIcon";
export { McpServerIcon } from "./McpServerIcon";
export * from "./brands";

// Daintree's product-concept icons resolve to Lucide icons. Re-exported
// here so callsites can import from `@/components/icons` consistently.
// Each was chosen to fit the metaphor.
export {
  Activity, // project pulse / live activity heartbeat
  BellDot, // watch alert / notify on completion
  FolderGit2, // git worktree (single)
  Folders, // copy tree / file hierarchy capture (two overlapping folders)
  Layers, // worktree overview (multiple worktrees, stacked)
  Plug, // agent (integration that plugs into the host system)
  Sprout, // origin / first step (main worktree, first agent launch)
  Workflow, // terminal recipe / scripted command sequence
} from "lucide-react";
