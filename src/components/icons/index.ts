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
  AppWindow, // where an opened folder lands — a window of its own or the current one
  ArrowDown, // a branch behind what it tracks — the same ↓ the upstream badge writes beside the count, so the collapsed alarm and the expanded one name the drift alike
  ArrowDownAZ, // alphabetical sort order (A to Z)
  ArrowLeftRight, // a settings search hit that lives in the other scope — following it switches scope
  ArrowUpDown, // card organization — pinning, collapsing and reordering a worktree row
  AtSign, // @file reference handed to an agent's prompt
  BellDot, // watch alert / notify on completion
  Bot, // a commit author that is a bot account (a `[bot]` name) with no picture — shape says machine where initials would say person
  ChartNoAxesColumn, // frecency sort order ("Most used" — decayed access score)
  CircleCheck, // finished run — blue awaiting review, neutral once acknowledged (Pilot's review and done bands)
  CircleDashed, // run the user snoozed — quiet until it wakes (Pilot's snoozed band)
  CircleDot, // shell that is alive and doing nothing, so the amber hollow circle means waiting and only waiting (Pilot's idle band)
  CircleHelp, // workspace whose metadata is missing (removed while its agents ran)
  CirclePause, // run the user parked — shelved on purpose (Pilot's parked band)
  CircleSlash, // agent stopped on an error, distinct in shape from a waiting one (Pilot's blocked band)
  CircleX, // CI that failed — the cross the PR badge already uses, enclosed so a glyph standing alone reads as a verdict rather than a dismiss control
  Clock, // recency sort order (most recently opened first)
  ClockAlert, // ahead/behind counts older than the fetch cadence says they should be — a clock that is late, distinct from Clock's plain ordering and the rate-limit wait
  CloudOff, // a remote or forge that could not be reached — the same glyph the PR and issue badges show when detection is paused
  Coffee, // Daintree keeping the machine from idle-sleeping while agents work — the long-standing keep-awake metaphor
  FileStack, // artifacts an agent left in a terminal — the code, patches and files pulled from its output
  FileText, // view selected file path in the read-only file viewer
  FolderGit2, // git worktree (single)
  FolderOpen, // reveal in file manager (Finder / Explorer / file manager)
  FolderOutput, // worktree living outside the project directory (external)
  FolderTree, // Daintree's own file browser panel (the worktree file tree)
  Folders, // copy tree / file hierarchy capture (two overlapping folders)
  GitBranchPlus, // per-project worktree setup — creating branches, not browsing them
  GitPullRequest, // forge provider / code-host plugin category
  History, // resume closed session / session history
  Joystick, // a terminal the user handed to an orchestrating agent pane, which drives it until taken back
  KeyRound, // forge credentials that stopped working — a key names what has to be fixed, and it shares a silhouette with nothing else here, so it survives forced colors
  Layers, // worktree overview (multiple worktrees, stacked)
  LayoutPanelTop, // workspace plugin category (panels, notes)
  Link2Off, // detach the issue linked to a worktree
  ListChecks, // bulk selection of forge rows — the preset picker that selects many issues or PRs at once
  MemoryStick, // a terminal host's own memory budget — the governor's app-wide output pause
  Menu, // the application menu, surfaced in-app where the native menu bar can't render
  Moon, // sleep a project — shut it down the way quitting does, restored on reopen
  Network, // Subagent tree — a parent session's spawned child sessions
  Package, // plugin (a packaged extension) — plugin tray, unresolved plugin glyphs
  PanelTop, // the app toolbar — the strip along the top of the window
  Paperclip, // attach files to a composer draft — the same references a drop or a paste inserts
  Plug, // agent (integration that plugs into the host system)
  Plus, // the toolbar launcher — "make me a new thing" (agent, panel)
  Radar, // an agent pane watching other terminals, which Daintree may wake when they change — distinct from BellDot, the user's own watch alert
  ServerCog, // a worktree's runtime — dev-server and remote-environment lifecycle
  Sprout, // origin / first step (main worktree, first agent launch)
  TriangleAlert, // a setting failing validation — a shape, not a hue, so it survives forced colors
  Workflow, // terminal recipe / scripted command sequence
} from "lucide-react";
