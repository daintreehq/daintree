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
  AlarmClockOff, // a project exempt from automatic sleep — the idle timer never runs out on it
  AppWindow, // where an opened folder or host lands — a window of its own or the current one
  Archive, // file a project away — out of the switcher's main list, everything about it kept
  ArchiveRestore, // bring an archived project back to where it was filed
  ArrowDown, // a branch behind what it tracks — the same ↓ the upstream badge writes beside the count, so the collapsed alarm and the expanded one name the drift alike; also moves a project group down the switcher
  ArrowDownAZ, // alphabetical sort order (A to Z)
  ArrowLeftRight, // a settings search hit that lives in the other scope — following it switches scope
  ArrowUp, // move a project group up the switcher — paired with ArrowDown
  ArrowUpDown, // card organization — pinning, collapsing and reordering a worktree row
  AtSign, // @file reference handed to an agent's prompt
  BellDot, // watch alert / notify on completion
  Blocks, // a dependency branch (deps/) — building blocks, kept apart from the packaged plugin's Package
  BookDashed, // a Scratchpad's notes are temporary — kept only while its terminal is open; the dashed outline reads as a mode, not a warning
  BookmarkCheck, // a review mark — the point a worktree was marked reviewed at, kept to say what's new since
  BookmarkPlus, // a worktree with no review mark yet — marking it sets the first one
  Bot, // a commit author that is a bot account (a `[bot]` name) with no picture — shape says machine where initials would say person
  Cable, // a project attachment — a resource the whole project shares (a tunnel, a test device) that one worktree holds at a time
  CalendarClock, // a project schedule — an agent run set to start on a cadence
  ChartNoAxesColumn, // frecency sort order ("Most used" — decayed access score)
  CheckCheck, // Canopy: the readers think an agent's task is done and Daintree sees it stopped — a suggestion to close it, distinct from the observed finished ring (DoneCircle)
  CircuitBoard, // an infrastructure branch (infra/) — system wiring, kept apart from the host machine's Server
  CircleArrowUp, // a CLI below the version Daintree needs, or a host whose build was refused — the same up-arrow-in-a-circle plugins show for an available update
  CircleCheck, // a check that passed or a step that is done (setup, forge, review) — a finished agent draws DoneCircle on the family's own ring instead
  CircleDashed, // a check or step that has not run yet (PR checks, setup) — Pilot's snoozed band draws SnoozedCircle on the family's own ring instead
  CircleDot, // an open issue on forge surfaces — Pilot's idle band draws IdleCircle on the family's own ring instead
  CircleHelp, // workspace whose metadata is missing (removed while its agents ran)
  CirclePause, // the Park action in menus, and paused statuses elsewhere — a parked run's own mark is ParkedCircle on the family's ring
  CircleSlash, // something refused or skipped (MCP calls, clones, conflicts) — an agent blocked on an error draws BlockedCircle on the family's ring
  CircleStop, // a scheduled run that ended without a verdict — interrupted, stopped, replaced, or exited with no code seen
  CircleX, // anything that failed: CI, an environment, a pane that could not load — the cross the PR badge already uses, enclosed so a glyph standing alone reads as a verdict rather than a dismiss control
  Clock, // recency sort order (most recently opened first); a canopy row's time in its current state
  CloudOff, // a remote or forge that could not be reached — the same glyph the PR and issue badges show when detection is paused
  Coffee, // Daintree keeping the machine from idle-sleeping while agents work — the long-standing keep-awake metaphor
  FileStack, // artifacts an agent left in a terminal — the code, patches and files pulled from its output
  FileText, // view selected file path in the read-only file viewer
  FolderClosed, // a project group — related repositories filed together in the switcher
  FolderDown, // clone a repository — a folder arriving, beside Open project's FolderOpen and Create project's FolderPlus
  FolderGit2, // git worktree (single), and any count of worktrees
  FolderMinus, // take a project out of its group, back to Other projects
  FolderOpen, // reveal in file manager (Finder / Explorer / file manager)
  FolderOutput, // worktree living outside the project directory (external)
  FolderTree, // Daintree's own file browser panel (the worktree file tree)
  Folders, // copy tree / file hierarchy capture (two overlapping folders)
  Gauge, // git that could run faster on this worktree — the suggestion to route a WSL checkout's git through WSL
  GitBranch, // the branch a folder has checked out — where an agent's work is going, and what continues on another host
  GitBranchPlus, // per-project worktree setup — creating branches, not browsing them
  GitMerge, // a merge the forge will carry out later — auto-merge armed, or the PR waiting in the merge queue
  GitMergeConflict, // a PR whose branch the forge reports as conflicting with its base — takes the CI glyph's place, since the conflict has to be resolved first
  GitPullRequest, // forge provider / code-host plugin category
  HardDriveDownload, // a backup branch (backup/) — a stored snapshot, kept apart from archiving a project
  History, // resume closed session / session history
  Hourglass, // an environment reporting it is still coming up (starting, provisioning) — a shape beside the neutral status word, so the word keeps its contrast
  KeyRound, // forge credentials that stopped working — a key names what has to be fixed, and it shares a silhouette with nothing else here, so it survives forced colors
  Layers, // worktree overview (multiple worktrees, stacked)
  LayoutPanelTop, // workspace plugin category (panels, notes)
  Link2Off, // detach the issue linked to a worktree
  ListChecks, // bulk selection of forge rows — the preset picker that selects many issues or PRs at once
  MemoryStick, // a terminal host's own memory budget — the governor's app-wide output pause
  Menu, // the application menu, surfaced in-app where the native menu bar can't render
  Moon, // sleep a project — shut it down the way quitting does, restored on reopen
  Network, // Subagent tree — a parent session's spawned child sessions
  NotebookPen, // a terminal's Scratchpad — throwaway notes kept beside that one pane
  OctagonAlert, // a severe caution that has not failed: a pane's CPU or memory in its red band, a Why slow? alert, a dangerous plugin capability, a destructive consequence — never a failure (that is XCircle), so the band survives forced colors as its own shape
  Package, // plugin (a packaged extension) — plugin tray, unresolved plugin glyphs
  PanelTop, // the app toolbar — the strip along the top of the window
  Paperclip, // attach files to a composer draft — the same references a drop or a paste inserts
  Play, // start a schedule's run now, outside its cadence
  Plug, // agent (integration that plugs into the host system), including an agent's own branch namespace with no brand mark; also a terminal handed to an agent pane, paired with Unplug to take it back
  Plus, // the toolbar launcher — "make me a new thing" (agent, panel)
  Radar, // an agent pane waiting to hear about other terminals, which Daintree may type a notice into — distinct from BellDot, the user's own watch alert
  Rows3, // sidebar density — how much room each worktree card takes (Comfortable or Compact)
  ScreenShare, // other machines connected to this one — the host's connected-machines pill
  Server, // a machine a window runs on — the toolbar's host switcher, beside the project pill
  ServerOff, // the window's host with its link down — the same machine, crossed out, never an alarm
  ServerCog, // a worktree's runtime — dev-server and remote-environment lifecycle
  Settings2, // managing a list of things in Settings — hosts, presets — kept apart from Settings, which is project settings
  Shuffle, // a refactor branch (refactor/) — paths rearranged, kept apart from the worktree overview's Layers
  Sprout, // origin / first step (main worktree, first agent launch)
  SquareDashedMousePointer, // the dev preview's Element Picker — pick an element on the page to hand to an agent, on its toolbar button and its plugin tile alike
  SquareTerminal, // a scheduled run's terminal still in the grid — Open brings that pane forward
  Star, // the default recipe a new worktree launches — kept apart from Pin, which means pinned to the canvas
  Tag, // a worktree's colour label — the identity a user pins to a card, kept apart from Pin, which is its position
  Telescope, // Canopy: the long view out over every agent, read off its screen and laid out by what it needs from you — binoculars read clumsy at 16px, and both trees read as the notifications bell beside it
  Timer, // a scheduled run still open, timed since its terminal started — which says nothing about whether the agent is working
  TriangleAlert, // a setting failing validation, a pane's CPU or memory in its amber band, or a request the app refused (a file reference with no agent to take it) — a shape, not a hue, so it survives forced colors
  Unplug, // taking a link back — a terminal from an agent pane, or this device's link to a host, which stops nothing there; also detaching a project attachment (Cable) from the worktree holding it
  Workflow, // terminal recipe / scripted command sequence
} from "lucide-react";
