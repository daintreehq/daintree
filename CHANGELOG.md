# Changelog

## [0.33.0] - 2026-08-22

The project switcher stops answering two questions with one dot: a row now reports what it wants from you and whether anything is still executing, separately. External MCP sessions bind to a workspace for their whole life instead of chasing window focus, so two agents driving two projects can no longer retarget each other. Elsewhere: a new dark theme, refinement passes on both defaults, and a file search that went from 102ms to 9ms on a large repository.

### Features

**Project switcher**

- Every row weighs running agents against waiting ones instead of picking one status out of a priority order, so a project with one agent still working and one waiting on you stops reading like a project where everything has stopped (#11832)
- The grey dot means the project has saved agent panels that will resume when you open it, and the row announces the count — on dormant, auto-parked and scratch rows alike (#11801, #11821, #11822)
- Search results break ties on live agent activity, so workspaces sharing a name prefix stop being ordered by frecency alone (#11861)

**MCP & automation**

- An external MCP session binds to one workspace at handshake and routes there for its whole life, or fails closed — no fallback to another window, ever (#11789)
- A workspace backing a live session is kept thawed and leased against memory-pressure eviction, so a bound session can't have its view frozen or destroyed underneath it (#11790)
- External sessions get a server-authoritative ownership ledger plus two narrow cleanup tools, so a caller can close what it opened without reaching the user's own panels (#11909)
- `actions.getSchema` carries session-scoped policy metadata — whether a target is callable, at what tier, whether it confirms, and whether a scoped grant could authorize it (#11910)
- `agent.listPresets` lets a caller discover preset ids before calling `agent.launch`, instead of reading one off a panel already running (#11859)
- `agentSessionHistory.resume` resumes an exact session by id, and the recipe-editor handoffs and bookmark mutations move to the Action tier (#11908)
- A terminal spawned over MCP records which surface asked for it, so a run you didn't start says where it came from (#11808)
- The tool surface sent to models every turn is smaller per tool: 44.8 KB to 42.5 KB for the 26 external tools, 197 KB to 183.5 KB for the full in-app 152 (#11905)

**Themes**

- Movile, a contrast-budget dark theme built around the sealed sulfur cave (#11874)
- Daintree, the default dark theme, gets its surface ladder repaired — five planes were made out of two different neutrals, and canvas-to-panel sat under the engine's own JND, so panel cards never lifted off the canvas at all
- Bondi, the default light theme, is rebuilt as warm cream: it was the least-chromatic light theme in the suite at half the chroma of the next lowest, decaying to pure achromatic white by the top of the ladder

**Elsewhere**

- Sleep shuts down a single project the way quitting shuts down all of them, including the project on screen — a case Free memory refused to touch. Reopening restores the layout and resumes the agents like a relaunch (#11802)
- Export and Import Configuration in the Help menu move a setup to a second machine as one versioned JSON bundle: custom agents, agent settings, keybindings, theme, notification preferences, the worktree path pattern and global recipes (#11889)
- The file browser panel is dockable, the last panel kind that wasn't (#11917)
- `forge.listPRs` takes a `search` option, so finding an old PR stops meaning paging through a listing by hand (#11897)
- Plugins can contribute recipes through `contributes.recipes`, declared inline in the manifest and disclosed in the install confirmation (#11860)
- Plugin subprocesses get a `duplex` mode — writable stdin with stdout kept separate from stderr — for the stdio JSON-RPC children that had been pushed toward raw `child_process` (#11871)

### Performance

- File search on a large repository drops from 102ms to 9ms, warm search and review-diff tokenization get the same treatment, and startup defers low-frequency main services, renderer panels and the xterm search, image and Unicode addons until first use

### Bug Fixes

**Terminals & agents**

- A slow submit keeps its exclusive hold on the composer, instead of a timed-out write landing its Enter after the next prompt's body — two prompts merged into one and the agent received neither (#11875)
- Codex quits on a gated Ctrl-C rather than an injected `/quit`, which mid-turn landed in the transcript and in Codex's own `/resume` picker, burned tokens and captured nothing; measured capture was 38% over 26 teardowns (#11851)
- A near-zero background resize box is refused instead of adopted at 2×1, which re-wrapped committed scrollback until the cap evicted the top of history for good (#11900)
- A paused xterm renderer is actually resumed, instead of a repair jittering padding every 3 seconds forever and logging success (#11800)
- Recipe panes keep the names the recipe gave them, so a ten-pane fleet with role names stops becoming nine identical `Claude` panes (#11872)
- A manual panel rename reaches the pty-host record, so the fleet overview and the panel header stop showing two names for one run (#11830)
- A soft-wrapped bare file path links as one path rather than only its continuation fragment, which opened the wrong file (#11865)
- Dropping a file selects the pane it landed on, so what you type next goes there (#11809)
- The Codex slash-command catalog matches Codex 0.147.0 exactly — 14 commands added, 8 that never existed dropped (#11843)

**Worktrees & panels**

- A worktree removed outside the app cleans up its agents instead of stranding them alive and invisible while the attention tally kept counting them; one report showed "7 need input" with 2 agents reachable and no way out but quitting (#11911)
- Dragging a running agent onto another worktree applies immediately, and the pane carries a dismissible banner offering to tell the agent to continue in the new directory — replacing a blocking dialog whose buffer-replay "session transfer" destroyed the live session it was meant to move (#11853, #11867, #11868)
- Duplicating a panel that had been dragged to another worktree reroots the copy, instead of spawning it in the old worktree while filing it under the new one (#11854)
- A lone grid pane shows whether it holds keyboard focus, so there's a way to tell where keystrokes will land without typing (#11837)
- Dock chips reorder for non-PTY panes and stop painting the pre-drag order (#11873)
- Sweeping the pointer across the launcher no longer drags the keyboard selection through every row it passes (#11919)
- Grid-bar notifications carrying action buttons get a dismiss control (#11855)
- The theme browser and portal dock offset below a global banner instead of being clipped by the toolbar it pushes down (#11893)

**Windows & Linux**

- The application menu is reachable from a new toolbar button — the Window Controls Overlay had removed the frame region it renders into, leaving menu-only actions with no route at all on Windows (#11813)
- The worktree sidebar no longer sticks on its loading skeleton forever on packaged builds, with the file browser reporting no resolved folder and nothing logged (#11818)
- Single-arch artifacts stop shipping the other arch's better-sqlite3 prebuild, about 2MB of dead weight in every build (#11829)

**MCP & actions**

- A session revoked mid-request fails closed instead of resuming on the `workbench` surface — the two tiers are peers, not rungs, so revocation was widening the surface by 46 tools including `file.read` and `git.getFileDiff` (#11799)
- `terminal.close` settles before it acks, so an MCP result means the panel is actually gone, and an unknown id reports as such instead of "OK" (#11805)
- `agent.listAvailable` stops hanging on a registry payload structured clone can't encode (#11795)
- Enabling the MCP server from Settings captures the window registry, instead of silently degrading every registry-aware path to whichever window was created last (#11842)
- A native automation grant pre-authorizes a `confirm` action the tier already permits — typing `worktree.delete` into Settings did nothing at all, and the modal still fired on every call (#11878)

**Icons**

- Brand marks resolve against the surface they actually paint on: the vendor's colour drawn one perceptual step away from the backdrop at rest, and the brand colour itself when active, floored at WCAG 3:1 and APCA Lc 35 (#11895, #11903)

## [0.32.0] - 2026-08-15

A lot of this release went into making Daintree stable on Windows: a new terminal picks up a PATH change without an app restart, the caption strip reads as part of the window instead of painted over it, and a machine without Git says so at startup rather than blaming the folder you opened. Elsewhere, a run can be parked or snoozed so a deliberate wait stops reading as something that needs you, and git stops parsing filenames as pathspecs — the route by which discarding one file's changes could destroy uncommitted work in another.

### Features

**Pilot & fleet**

- Park a run with a note and an optional gate: it drops into a quiet Parked band, stops counting as demand everywhere, and hands itself back with a notification the next time the gated terminal goes ready (#11781)
- A Parked filter segment isolates everything you've shelved, and park notes are searchable (#11781)
- Project group headers carry a demand chip — a count plus the worst band's glyph — so five projects scan without reading a single row (#11781)
- A working run that's been silent for over ten minutes shows a `quiet 12m` cue, so "working" and "working but wedged" stop rendering identically (#11781)
- Snooze an agent for 15 minutes, 30 minutes, 6 hours, or until you interact with it, so one agent sitting on a question stops making the whole project read as needing attention; any typed input wakes it (#11783)

**Setup & forge**

- A missing Git is caught at startup with a banner, a re-check on focus, and a one-click install where that's safe — instead of surfacing as a raw spawn error the first time you open the clone dialog (#11763)
- `forge.getChecks` reads per-check CI detail through the forge abstraction, so an agent can see which check failed rather than only that the roll-up is red (#11786)

### Bug Fixes

**Windows**

- A newly-opened terminal re-reads the registry PATH, so a tool you just installed is on PATH without restarting the app (#11773)
- The caption strip is tinted to the active global banner and follows the theme picker, instead of painting an opaque rectangle over the top-right corner (#11766)
- The cloud-folder warning states where the project is rather than asserting a sync that was never checked — Windows redirects Documents into OneDrive by default, so this fired whether sync was running, paused or switched off (#11767)

**Git & files**

- File paths reach git as literal pathspecs: a filename containing `[`, `*` or `?` could resolve to a different file, so discarding one file's changes destroyed uncommitted work in another (#11762)
- A missing Git binary is named as such instead of reporting a folder that can't be read, which had been retiring healthy worktrees (#11764)
- Binary detection is anchored to git's own marker line, so a text file whose content quotes "Binary files" stops having its whole diff blanked (#11756)
- Right-clicking a file gets a file menu on all four surfaces that list files — worktree card, file browser, Review Hub and the diff sidebar — rather than the worktree's menu acting on the whole worktree (#11757)

**Terminals & agents**

- A failed xterm attach rebuilds the pane and surfaces an error banner, instead of retrying into a state the library can never recover from — the pane rendered nothing at all while the agent kept working (#11776)
- Agent session ids are assigned at launch rather than scraped at teardown, so they survive a crash, a force quit or a SIGKILL, and quitting no longer writes into a mid-turn agent (#11782)
- Clicking an agent whose CLI is unavailable opens the launch gate with its diagnostics and a re-check, instead of deep-linking into Preferences (#11760)

**App**

- A slow cold project switch spends its paint budget from load settle, so a legitimately slow first load stops being abandoned and rolled back with an error toast (#11765)
- An Error passed inside a log context is serialized properly instead of reaching the log file as `{}` — for 110 call sites the failure record was empty (#11777)
- The diagnostics download shows a spinner while collecting rather than rotating the download arrow in place (#11775)

## [0.31.0] - 2026-08-11

The toolbar's agent and panel trays and the dock's `+` collapse into one searchable launcher, the copy-context button becomes a recents dropdown backed by per-project history, and the palette learns to browse its whole inventory under a quieter selection model. Underneath: terminal geometry work closes the last routes by which a restored or backgrounded pane commits output into the wrong grid, and every git write path stops assuming the remote is called `origin`.

### Features

**Launcher & toolbar**

- One searchable launcher serves both the toolbar and the dock `+`, replacing the separate agent and panel trays — same inventory, per-row pin, shortcut capture, preset rows and running-state pips on both surfaces (#11680, #11689, #11691)
- The file browser opens as a persistent grid panel from every global entry point — toolbar, Cmd+Alt+F, command palette, empty-grid launcher, worktree card — instead of only as a modal dialog (#11666)
- The file browser ships visible on the toolbar, and the web browser and dev preview move into a panel tray; no existing saved layout changes (#11667)
- Toolbar buttons declare a group, so a divider marks a real boundary instead of landing wherever a predicate flipped after a reorder (#11681)
- Every launcher surface routes a panel kind through one launch path: Dev Preview from the dock loads the project's configured command, and a second file browser focuses the one already open (#11668)

**Copy context**

- The toolbar copy-context button opens a dropdown — copy the full context, or re-run one of the five most recent copies for the project, each showing name, file count, size and age (#11732, #11733)
- Copies driven by the in-app assistant or an external MCP client can carry a name, and land in the same history and completion feedback as any other (#11722, #11734)
- Every route confirms a finished copy the same way: a tooltip on the toolbar button with file count and size, falling back to a toast when the button can't show it (#11735)
- A scoped copy can opt past the ignore rule pruning the folder you named, via `scopeIgnoresIgnoreFiles` (#11750)
- The MCP copy-tree schema states that patterns match file paths, and an empty bundle names the selector that matched nothing (#11731)

**Palette**

- The empty query browses the full action inventory grouped by category — Worktrees, Panels, Git, Projects — instead of favourites plus a short recents band (#11688)
- Palette selection and search-field focus drop the stacked accent for a neutral raised row and hairline, across all 16 palette surfaces (#11686)
- Palette chrome scales to the surface, so a toolbar launcher and a command palette no longer share one box, and a footer renders only when it names what Enter does (#11687, #11690, #11736)
- The project switcher marks the current project separately from where Enter lands, and rows collapse to one line (#11692)

**Elsewhere**

- Fleet overview groups read most-recently-opened first, so the project you're in stops sinking below one holding waiting agents (#11678)
- The fleet overview matches the rest of the app: working is green, review/finished blue, vocabulary follows the sidebar, ordering stays live, and the keyboard model grows past a single Enter (#11669)
- Hiding the worktree sidebar from the keyboard names the combo that did it and offers an Undo — Cmd+B sits next to Cmd+V (#11704)
- A visible button deletes all scratch workspaces, and the confirmation names every workspace instead of counting them (#11705)
- Both branch fields in the New Worktree dialog use one picker, with fuzzy search, a Recent band and full keyboard support (#11724)

### Bug Fixes

**Terminal**

- A pane restored into a background worktree builds on its persisted grid instead of xterm's 80×24 default, so a wide agent's repaints stop being committed into an 80-column buffer and surviving every redraw (#11718)
- The pty-host's headless mirror can no longer parse output at a geometry the PTY never had — the route by which corrupted scrollback replayed forever after an eviction or host restart (#11719)
- The Efficiency profile stops clipping the scrollback of every visible unfocused agent pane, and alt-buffer accounting measures the buffer that's actually trimmed (#11673)
- Tier-1 memory pressure trims only idle terminals instead of flattening every live agent's scrollback, and its reclaim measurement no longer authorizes the eviction it exists to prevent (#11674)
- A bottom-pinned terminal stays pinned when the hybrid input grows, instead of jumping into scrollback mid-sentence (#11709)
- Dropping a file onto the hybrid input inserts the reference chip without also pasting the file's raw text (#11710)
- File-reference chips show the full path and wrap, so two long paths differing only at the tail are distinguishable (#11725)

**Git & worktrees**

- Git writes — upstream set, rescue push, pull --rebase, force-with-lease and its discard preview — resolve the branch's real push remote instead of hardcoding `origin`, so a fork-configured branch stops writing to the wrong repository (#11746)
- Behind-counts and PR-branch fetches resolve the base branch's own remote, so a fork/`upstream` setup stops reading ↓0 while sitting hundreds of commits behind (#11747)
- Clicking an in-use base branch selects it instead of closing the New Worktree dialog and discarding the form (#11714)
- The new-branch name stops rewriting itself mid-typing when the debounced availability check resolves (#11715)

**Panels, plugins & app**

- Plugin capability consent prompts reach the app renderer instead of silently timing out five minutes later as a denial (#11708)
- A plugin panel restored from persisted state no longer 404s permanently on its view asset, unrecoverable without Force Reload (#11728)
- `app://` assets are read directly rather than through an ASAR extraction whose temp file can be reaped, which broke every project switch until restart (#11726)
- The file browser tree stays put when a folder above the cursor expands (#11684)
- Launching from the dock's `+` leaves focus on the new panel rather than on the button (#11664)
- CopyTree IPC resolves worktrees by the sender's own project rather than the window's current one, so a call from a backgrounded view stops failing or reaching a sibling project (#11751)
- The Node agent compile cache is bounded by TTL and budget — one report measured 9.3 GB across 890,589 files (#11699)

### Other Changes

- Agent provider reachability probes are gone: Daintree no longer pings Anthropic, OpenAI and Google every 30 minutes and on every window focus, regardless of which agents you use (#11702)
- xterm 6.1.0-beta.300 and copytree 0.17.0

## [0.30.1] - 2026-08-04

A correctness patch on 0.30.0. Most of it closes routes by which one project's state reached another's — a new project inheriting the legacy global terminal list, reconnect and spawn resolving across the project boundary, a non-git folder adopting a foreign worktree — alongside a round of terminal geometry repairs and a cold project switch that could land on a blank Not Found page.

### Bug Fixes

**Project isolation**

- A new project no longer inherits the legacy pre-multi-project terminal list, so it can't be minted with another project's panels, cwd and worktree (#11651)
- `terminal:reconnect` refuses a terminal belonging to another project instead of adopting it (#11652)
- Terminal spawn drops a `worktreeId` it can't prove belongs to the project stamped beside it, so resumable-session history stops crossing projects (#11653)
- A workspace with no repository stops adopting whichever worktree the last git-backed project left behind (#11650)

**Project & window switching**

- Switching to a project that needed a cold view could replace the workspace with a Not Found page, recoverable only by restarting (#11635)
- A project recorded as git-backed that has lost its `.git` can reach the demotion dialog from the switcher and from back/forward, not just from path-based entry points (#11649)

**Terminal**

- A background grid resize dedupes against the grid the terminal actually holds, not a queued target, so a stale target stops leaving the grid permanently narrower than its PTY (#11639)
- Redraw forces a full geometry resync, so it does something on a busy agent terminal instead of skipping the only step that corrects the grid (#11638)
- A worktree switch retries the repaint once the terminals mount, instead of discarding it while they're still offscreen (#11640)
- The pty-host reports the dimensions it applied, so a PTY grid drifting from the terminal's is detected rather than silent (#11641)

**Worktrees & panels**

- A worktree-less workspace clears an inherited worktree selection once its empty snapshot is authoritative, so agent launches stop failing with nothing shown (#11654)
- A restored panel backed by a plugin panel kind recovers when the plugin activates, instead of staying "Plugin unavailable" until it's closed and reopened (#11636)
- The worktree sidebar's bulk arm addresses only agent terminals, matching the state filters beside it, and counts them the same way (#11637)

## [0.30.0] - 2026-08-03

The MCP control surface gets a full overhaul — the external tool surface drops from 100 tools to 23 so real clients stop silently truncating it, results are bounded and versioned, and forge actions grow enough reach for an agent to run a whole work loop without leaving Daintree. Alongside that: Pilot, a cross-project view of every agent run at once; a file browser that feeds files straight into an agent; and a relaunch that brings back all your project windows instead of one.

### Features

**Pilot**

- New cross-project fleet overview on Cmd+Alt+O: every agent run across every project and scratch in one searchable palette, grouped by project and ordered by what needs you most (#11610)
- Rows read as a single line, with colour reserved for the three states that actually demand you, plus a filter bar to isolate them (#11631)

**MCP & agent control**

- The external tool surface is cut from 100 tools to 23 — clients like Cursor and Copilot were silently dropping or hard-erroring on the overflow and choosing for you (#11592)
- `mcp.surface` publishes the session's tool surface as versioned data with a stable hash, so a client can detect drift without diffing it (#11617)
- Per-client MCP connect config — Claude Code JSON, Codex TOML, or raw Streamable HTTP details — with the displayed URL and the copied snippet derived from one computation (#11554)
- The server sends workflow instructions at initialize (#11601)
- `project.runCheck` runs one of a project's detected runners and returns its real exit code instead of a best-effort scrollback parse (#11571)
- Every action result is parsed through its declared schema before it's returned, so the published shape is the delivered one (#11583)
- Payload budgets on tool results, session history, bookmark reads, the action manifest, and agent-facing git and worktree reads (#11559, #11560, #11561, #11570)
- CopyTree returns a file handle rather than the whole bundle (#11584)

**Forge over MCP**

- Read a PR's CI status (#11567) and an issue's comment thread (#11566)
- Issue and PR lists take `perPage`, `sort`, `direction` and a summary/full view, and reject an unknown filter instead of dropping it (#11558)
- The twelve forge write actions return the state they changed instead of void (#11569)

**File browser**

- Send a file to an agent as an `@file` reference by dragging a row (#11581) or with Cmd+I (#11580)
- Git status on tree rows, and a changed-files summary in the idle pane (#11618)
- File-type icons on tree rows (#11604)
- Selecting a folder renders its contents, with a toolbar sort menu that orders both the tree and the listing (#11622)
- Reachable from Cmd+Alt+F, a terminal right-click, the file viewer toolbar, and an opt-in toolbar button (#11486, #11504)
- Opens scratch and worktree-less project folders, not just git worktrees (#11488)
- The viewer collapses like the tree, and Enter or double-click opens a file as its own panel (#11502)

**Windows & palettes**

- A relaunch restores every open project window on the project it was showing, not just one (#11494)
- The palette family — switcher, command palette, theme, new terminal, quick create, Pilot — moves onto one surface, one width, and one grouped keyboard model (#11624, #11616, #11623)
- The dock's + launcher is complete and searchable: every spawnable panel kind, with agents and recipes ranked in one list, on a proper popover palette (#11523, #11609)
- Scratch rows in the switcher carry the same agent-activity status line project rows get (#11520)

**Terminal & plugins**

- Terminal process detection collapses into one registry, so a package manager stops masking the tool it wraps and `node vite.js` reads as Vite (#11619)
- Plugins can contribute terminal process detections through `contributes.processTools` (#11621)
- `/goal` is shared across Claude Code and Codex (#11491)
- The sidebar's worktree refresh button is a true full refresh — titles, pull requests and CI badges all re-resolve (#11634)

### Bug Fixes

**Terminal**

- A hidden pane's PTY no longer resizes without its grid, which corrupted cursor-addressed output in a way reflow could never undo (#11632)
- Scrollback snapshots carry the geometry they were captured at, so a replay aligns to the grid its payload was written on (#11573)
- Dropping a file on a terminal is agent-aware — an agent gets an `@file` token, a shell gets an escaped path — and a drag over a terminal shows feedback (#11579)
- Drop and paste emit the same cwd-relative `@file` form autocomplete already produces (#11578)
- A dismissed session-lost banner stays dismissed across worktree switches (#11603)
- Terminal limit errors only surface on an actual depletion (#11514)

**Durability & state**

- Scratch workspaces persist and restore their panel grid, so an eviction or restart no longer strands running PTYs (#11487)
- A non-project workspace never inherits legacy global state (#11501)
- Cancelling bulk worktree creation stops the in-flight items (#11519)
- Deleting a scratch confirms first and reports progress (#11551)
- Every workspace kind gets a sidebar row, so the toggle stops lying (#11503)
- Launching an unknown agent id is rejected instead of degrading to a plain terminal (#11500)

**Files**

- Files outside every worktree — scratch folders, worktree-less projects, unregistered repos — get a live change signal instead of showing whatever was on disk when they opened (#11605)
- File panels and the file browser re-read when a project view is revealed (#11615)
- Local images in markdown are re-requested when they change on disk (#11599)
- Media previews refresh, and Refresh is reachable with the tree collapsed (#11600)
- Clicking a folder in the tree expands it without hijacking the viewer (#11629)
- A promoted workspace-rooted browser keeps its own folder (#11493)

**MCP**

- `project.getSettings` no longer returns decrypted secrets over MCP (#11555)
- Introspection results are scoped to the calling session's tier (#11563)
- An unpinned tool call routes by focus order and reports the workspace it resolved to (#11564)
- Terminal dispatch from an agent or MCP requires an explicit terminal id (#11568)
- Agent-dispatched push and pull-rebase complete instead of stalling (#11565)
- `agent.launch` has a usable identity, and `startWorkOnIssue` publishes its schema (#11557)
- `worktree.resource` failures are reported rather than resolved (#11562)
- The idempotency dedup allowlist is rebuilt around its stated criterion (#11556)

**Dialogs & overlays**

- A shortcut hint no longer strands over the dialog it opened (#11508)
- Panels that open behind a maximized cell are revealed (#11509)
- A dialog opened from a docked panel lifts above its popover (#11511)
- Menu shortcut hints stay off the item label (#11607)

**Elsewhere**

- A failed macOS update install surfaces instead of vanishing (#11485)
- Recipe pickers show which scope each recipe comes from, and stop hiding shadowed ones (#11516)
- A PR whose CI reached a terminal state is re-polled — failure is exactly the state you re-run (#11515)
- Pilot's fleet search gates on match quality rather than bare subsequence (#11630)

### Other Changes

- Voice dictation moves from the retired Realtime Whisper to gpt-live-transcribe, and keyterm biasing from your branch, project name and custom dictionary finally reaches OpenAI (#11611)

## [0.29.0] - 2026-07-28

Daintree stops requiring a git repository — any folder opens as a lightweight workspace, with git init as an explicit upgrade — and a project's folder can now be moved or renamed without losing panels, terminals, or agent conversations. Alongside those: a new file browser panel, a file viewer that plays video and audio and previews PDFs, and a large durability wave protecting agent sessions, drafts, recipes, and uncommitted work.

### Features

**Projects & folders**

- Open any folder as a lightweight workspace — no git repository required, and Daintree never modifies it (#11417)
- Move or rename a project's folder from inside Daintree; panels, terminals, and agent conversations follow it (#11285, #11324, #11355, #11381, #11394)
- "Open in Daintree" in Finder, Explorer, and Linux file managers (#11412)
- Set a project's name and emoji when you create it (#11414)
- Dropping a non-repo folder on the Dock opens a guided git init, defaulting to a Minimal gitignore from an expanded template set (#11284, #11411)
- Folder-open failures report what went wrong instead of leaking git internals (#11418)

**Files**

- New read-only file browser panel, with a collapsible and resizable tree sidebar, live filesystem updates, a rethought hidden-file model, and Source/Rendered markdown previews (#11287, #11322, #11336, #11338, #11370)
- The file viewer plays video and audio inline, previews PDFs through Chromium's viewer, and recognises AVIF and APNG as images (#11385, #11429, #11430, #11428)
- Open a diff for any file with local changes straight from the file viewer, and reveal it in the system file manager (#11276, #11392)
- Click a re-rooted tree's root path to copy it (#11413)

**Diff & review**

- The diff panel can show the full file instead of only the changed hunks (#11268)
- Reveal and open-in-editor from the Diff Viewer toolbar (#11272)
- One step from a worktree to the diff of its changed files (#11422)

**Project switcher & windows**

- The switcher ranks by scores that decay with time and attention, labels agent state truthfully, and never dead-ends (#11449, #11450)
- Scratch workspaces are searchable, and the Other projects band gets a sort control (#11468, #11457)
- Each window title names its active project (#11460)

**Plugins**

- Plugin toolbar buttons collect into a single plugin tray (#11310)
- Plugin actions declare per-action capability intent, so a shell-capable plugin no longer forces a destructive confirm on every command (#11311)
- Plugin views distinguish a temporary unmount from a permanent teardown, so maximizing a neighbouring pane no longer kills a plugin's running process (#11312)
- Managed plugin processes support interactive stdio and PTY, with worker env scrubbing (#11314)
- Plugin detail tabs are earned by content, and installs report progress (#11313)

**Terminal & panels**

- Every panel kind is dockable by default, with explicit opt-out (#11374)
- file:// URLs in terminal output are clickable (#11421)
- One shared keybinding table drives both the renderer and the native menus, so menus can't drift from the real shortcuts; focused terminals own the readline and clipboard keys on Windows and Linux (#11337)
- Deleting several worktrees at once collapses into a single summary row and a single inbox entry (#11266)
- The Update ready toast links to the release notes (#11264)

**Context**

- CopyTree 0.16: the Max file size, total size, file count and character budgets actually apply now, and the context listing comes from CopyTree itself (#11440, #11446)

### Bug Fixes

**Durability**

- A pty-host crash replays the launch command so agents resume instead of dying (#11362)
- Agent sessions are journalled on project close, project remove, and scratch remove (#11360)
- A failed journal read no longer truncates session history (#11358)
- Typed but unsent terminal drafts survive a window close (#11376)
- Abandoning a worktree delete restores its terminals (#11377)
- Worktree delete confirms against fresh git status, and stale-scratch auto-cleanup no longer touches uncommitted work (#11361, #11378)
- Recipe writes are serialized, and local recipe env values survive a missing .daintree/recipes (#11372, #11357)
- An unreadable project state no longer deletes that project's terminal restore files (#11356)
- Concurrent layout writes from multiple project windows merge instead of clobbering, and project-scoped stores share the same write-merge (#11363, #11379, #11402)
- Spawning onto a terminal id that already has a live owner is rejected (#11373)
- Worktree "end all" and "clear history" confirm from every dispatch source (#11369)
- Restored panes no longer resume one another's agent conversation (#11464, #11471)

**MCP**

- Destructive MCP tool calls require host confirmation and never trust client elicitation (#11359)
- External arm and inject can no longer target the wrong terminal (#11368)

**Worktrees & sidebar**

- Panels are preserved when a worktree moves (#11395)
- Restore no longer collapses agent terminals onto a partial worktree list (#11393)
- Dock membership is hardened against stranding (#11396)
- Worktrees living outside the project directory are identified and sorted apart (#11436)
- develop worktrees stop being pinned out of the list and counts (#11435)
- Deleted-worktree ghosts anchor to a neighbour, the auto-close countdown times correctly, and a rescued terminal follows its drag (#11401, #11267, #11275)
- Dock chip reorder works for worktree-less panels, which adopt the active worktree when promoted to the grid (#11293, #11294)

**Terminal**

- Docked terminals pin to the bottom of the viewport on reveal (#11317)
- ArrowUp in an agent terminal goes to the terminal, not the command history (#11391)
- Terminal geometry is tracked for backgrounded project views (#11447)
- The worktree card stops flashing on every keystroke (#11448)
- Clicking an unfocused pane keeps the remembered focus target (#11467)
- Grok forces full-screen in alt-screen mode (#11424)

**Project views & memory**

- A slow cold project switch lands instead of being lost, and a pending view load cancels on teardown instead of reporting a phantom timeout (#11462, #11463)
- Cached-view memory reclaim is graduated and decoupled from the resource profile (#11470)

**Plugins**

- Plugin icons resolve identically across every surface, and real project and worktree context is threaded into invocations (#11307, #11308)
- The plugin SDK no longer bundles React 19 (#11309)
- Double-clicking a .dntr archive confirms before installing (#11283)
- The worktree colour stripe is gone from panel frames — its orange and amber entries read as warnings (#11306)

**Elsewhere**

- A wedged drag no longer disables all drag-and-drop until reload (#11305)
- --cli-path is hardened against Chromium argv displacement (#11415)
- The forgeRemote setting is honoured in toolbar issue and PR resolution (#11416)
- Arrow and Enter navigation stay alive in the palette after Tab (#11432)
- Open and reveal work for files in tracked worktrees (#11278)
- Folder context honours root ignore rules (#11442)
- Rename fields no longer start drags, and refresh buttons finish their spin (#11279, #11335)

### Other Changes

- Voice dictation moves to GPT-5.6 Luna ahead of the gpt-5-nano and gpt-5-mini shutdown; the correction-model dropdown is gone now that both tiers collapse to one model (#11380)
- better-sqlite3 13 brings in-package N-API prebuilds, removing the Electron rebuild step, alongside a batch of in-range dependency updates (#11315)

## [0.28.1] - 2026-07-20

A fast follow-up to 0.28.0 fixing two file viewer dialog regressions from the new panel-as-dialog model — long files now scroll, and markdown no longer collapses on the switch to rendered.

### Bug Fixes

- Long files opened in the file viewer dialog scroll instead of clipping past the first screen, in both Source and Rendered mode (#11254)
- The markdown viewer no longer collapses and re-expands the dialog when switching from source to rendered (#11255)

## [0.28.0] - 2026-07-20

The file viewer, diff viewer, review workspace and review hub all move onto one panel model — each opens as a dialog and can be promoted into the grid, retiring four hand-rolled modals along the way. Deleting a worktree no longer kills the agents running in it: their terminals stay alive on a deleted-worktree card you can drag them out of.

### Features

**Panels**

- Panels can present as dialogs, so the file viewer opens as a dialog and can be promoted into the grid (#11239)
- The diff viewer, multi-file review workspace and image compare open as a diff panel from every entry point (#11242)
- The review hub opens as a dialog-presented panel, and dialogs layer instead of replacing each other (#11243)

**Worktrees**

- Deleting a worktree keeps its agent terminals alive instead of killing them mid-session (#11232)
- The deleted-worktree card accepts dragged-out terminals, matches the live card design, and clears itself on a countdown (#11237)

**Terminal**

- Agent scrollback ceiling raised from 5000 to 10000 lines (#11223)

### Bug Fixes

**Files & Plugins**

- Images larger than 512 KB display in the file viewer instead of failing (#11222)
- Installing a plugin archive can no longer hang forever holding the install lock (#11227)
- Plugin panels take focus on click and carry the same pane chrome as every other panel kind (#11228)

**Git & Forge**

- git-lfs hooks no longer land as untracked files in every new worktree (#11226)
- The PR dropdown derives CI status from required checks, matching the worktree sidebar (#11251)

### Other Changes

- Electron 42.7 picks up the Node descriptor-regression revert; Chrome stays on the 148 train (#11227)

## [0.27.0] - 2026-07-16

This release hardens memory for long, multi-agent streaming sessions — renderer growth in project views is capped, idle cached views stop doing full-rate terminal work, and reclaim passes now free real memory. Alongside it, HTML files open in a proper in-app viewer with a Source/Rendered toggle, and a round of dock, plugin, and terminal fixes lands.

### Features

**Files**

- Render HTML files in the file panel via a sandboxed iframe, with a Source/Rendered toggle and open-in-browser from Rendered mode (#11191)
- View selected file paths from the composer and terminal context menus (#11204)

**Terminal & Dock**

- Grok and OpenCode default to inline mode (#11206)
- Plain terminal dock chips show running and finished state (#11187)

**Project & Launcher**

- The Project pulse strip populates on load and leads with active days (#11194)
- The empty-canvas launcher replays its entry animation on project switch (#11209)

**Plugins & Diagnostics**

- Plugin render errors surface real diagnostics for developers (#11207)
- Renderer processes are labeled with project names in the memory popover (#11213)

### Performance

- Hidden cached project views stop doing full-rate terminal work (#11212)

### Bug Fixes

**Memory**

- Renderer memory in project views is capped while agents stream, and the shared WebGL glyph atlas is bounded so a streaming view plateaus (#11210)
- Memory-pressure reclaim passes free real memory and report what each lever freed (#11211)

**Terminal & WebGL**

- WebGL stays on visible standard terminals, not only the focused one (#11193)
- WebGL fleet-flip thresholds track the raised context cap (#11192)
- The dock pane X dismisses the preview instead of killing the running terminal (#11186)

**Files, Plugins & Forge**

- Third-party plugins can import React in packaged builds (#11208)
- A missing COEP header no longer leaves the HTML preview blank (#11200)
- The open-in-GitHub button links to the default list instead of a raw search (#11201)

**PTY**

- Closed a 60-descriptor-per-run leak in PTY host pooling (#11199)

### Other Changes

- The version-monotonic release gate skips an already-published version on re-tag, and re-upload is skipped for an unchanged version (#11185)

## [0.26.0] - 2026-07-15

Terminal editing gains real power — word-by-word cursor jumps and a type-anywhere rescue that routes stray keystrokes back to the agent you were talking to — while the forge toolbar starts reacting to local git activity instead of a fixed poll. A broad multi-window pass makes project context follow the window that acted, and a motion sweep smooths theme changes, toggles, and settings controls.

### Features

**Terminal**

- Jump the cursor a word at a time with Option+←/→ in the shell line editor (#11159)
- Type-anywhere rescue routes stray keystrokes to the last agent you typed to, and a locator surfaces an off-screen focused pane (#11147)

**Forge**

- Toolbar counts refresh off local git signals — ref movement and origin-behind — instead of a fixed timer, so merge sprees update promptly (#11153)
- A newly-added git origin is detected without reloading the project (#11161)

**Worktree & Pulse**

- Sidebar activity recency is unified across worktrees (#11099)
- Pulse coaching reframes from commit streaks to shipped outcomes (#11182)

**Motion & polish**

- Programmatic theme changes crossfade instead of snapping (#11178)
- The SegmentedToggle slides a thumb between segments (#11181)
- The settings nav slides an active indicator between items (#11176), and the SettingsCheckbox animates its checkmark on check-in (#11175)
- The empty-grid launcher staggers its entry and adds press feedback (#11180)

### Bug Fixes

**Multi-window & project context**

- IPC project context resolves from the sending window's identity, not the last-created window (#11131), and every window's foreground project counts as visible (#11123)
- Outgoing layout (#11127), copytree settings (#11125), and notification state (#11146) are keyed to the owning window/renderer instead of leaking across projects

**Focus & keyboard**

- Keyboard focus and the selected pane stay in agreement (#11150)
- Docked-terminal arrow keys no longer rove the dock rail (#11160)

**Panels**

- Maximize state is scoped per worktree (#11184)
- Enter a focused panel of any kind from the macro grid (#11132)
- The Review panel's Close button and Escape hit the real close callback (#11138)
- Dev-preview panels keep their chrome during first load (#11094)

**Settings, actions & updater**

- Failed settings persistence is surfaced and rolled back (#11145), and a failed update-channel load no longer silently falls back to stable (#11140)
- ActionService dispatch failures surface at three UI call sites instead of failing silently (#11144)
- The updater stops double-notifying and lets late renderers pull update state (#11141), routes install through the graceful-shutdown coordinator (#11129), and stable builds no longer identify as Beta (#11139)

**Terminal**

- Column math reserves scrollbar width so wrapping is correct (#11097)
- Agent terminal resizing is coordinated to avoid races (#11098)
- An inherited NO_COLOR is respected when defaulting FORCE_COLOR (#11142)

**Menu, window & platform**

- File-menu enabled states track project open/close (#11152)
- Fullscreen uses platform-appropriate APIs, and the Project Settings menu item is wired (#11135)
- Windows can reach the mic prompt, and a missing Linux settings binary no longer kills the app (#11124)
- Enter on a webview dialog's Cancel button now cancels (#11126)

**Security & data**

- Persisted runtime data is written owner-only on POSIX (#11148)
- Database maintenance never overwrites a good backup with a corrupt one (#11130)

**UI & interaction**

- Accent CTA text paints with the contrast-validated foreground (#11149)
- The notification inbox gains scroll shadows (#11179), the forge stat pill eases its hover tint and press snap (#11177), the re-entry summary animates out instead of unmounting instantly (#11174), and the AppDialog keeps its opacity fade under reduced motion (#11173)
- The toolbar commit count stays stable on switch-back (#11096)
- Clear logs is gated behind a confirmation (#11128)

## [0.25.0] - 2026-07-13

Scratch workspaces become a first-class place to work — nameable, with a real first-run launcher and bulk cleanup — alongside a generalized agent-completion system that adds Codex's $ Skills/Apps/Plugins picker. Rounding it out: browser panels dock properly, dock and maximize interactions settle, and memory-pressure recovery is markedly more robust.

### Features

**Scratch workspaces**

- Name a Scratch workspace instead of the default timestamp, and see that name in the toolbar pill and project switcher (#11075)
- Fresh Scratch workspaces now open a proper first-run launcher instead of the onboarding Welcome screen (#11076)
- Delete every scratch at once from the switcher's Scratch section (#11086)

**Completions**

- Agent completion discovery is now declarative per agent, and Codex's $ trigger surfaces its Skills, Apps, and Plugins in the picker with category badges and trigger-neutral ranking (#11043)

**Other**

- Open the diff viewer directly from a file in Changed Files (#11041)
- New agent.listAvailable action lets external agents discover the effective agent registry, and agent.launch now reports spawn status

### Performance

- Launching a recipe fanout admits as a single spawn batch, worktree pickup / diff tokenizing / palette hot paths are faster, PTY output analysis is throttled, and recipe startup is bounded (#11038, #11039, #11044)

### Bug Fixes

**Dock & panels**

- Browser panels can now be docked without vanishing (#11053)
- The dock rejects panel kinds it can never render (#11054)
- The drag placeholder is clamped to dock-chip height (#11055), and chips snap into place on drop instead of reflow-animating (#11063)
- Opening a new terminal while maximized returns to the grid (#11060), and a maximized tab group keeps the dock popover open (#11065)
- Stuck MCP focus-suppression leases expire so dock launches recover

**Scratch & project switching**

- Deleting a scratch now kills its agent terminals instead of leaving them running (#11079)
- The switcher no longer reserves blank branch space for scratches (#11084), and previous-project navigation works from a scratch (#11085)
- Project-switcher selection no longer vanishes for a step when arrowing past visible rows (#11071)
- Repository counts persist across switch-back so the toolbar pills don't reload and shift (#11078)

**Memory & other**

- 'Free memory' no longer blocks the Electron main thread and drops clicks (#11069), and memory-pressure recovery and renderer responsiveness are hardened (#10498, #10660)
- A restarted agent resumes its own pane's session
- The issues dropdown refreshes as soon as a self-assign lands (#11087)

## [0.24.0] - 2026-07-10

The diff viewer grows into a full multi-file review workspace, worktree sidebar updates land far faster, and recipe fanout cold-spawns in a single batch — plus fixes for GitHub panels reading "not connected", stale diff content, stranded tooltips, and a swallowed first click on inactive macOS windows.

### Features

**Diff review workspace**

- Opening a multi-file changeset now opens a dedicated review workspace: a file sidebar with change counts, review progress, a filter, and per-file viewed markers, in a fixed frame that doesn't resize as you step between files (#11028)
- `n`/`p` navigation flows continuously across file boundaries, `v` marks the current file viewed and advances, and viewed state stays in sync with the Review Hub (#11028)
- Changed images get a compare view with two-up, swipe, and onion-skin modes, and diff text size is now an S/M/L preference that persists (#11028)

### Performance

- Worktree sidebar updates land far faster — a single file edit surfaces 3.6× sooner, 50 rapid edits 11.4×, and external worktree adds/removes 2.2–2.6× (#11029)
- Launching a recipe across worktrees cold-spawns as a single bounded batch instead of one at a time (#11038)
- Faster diff syntax tokenizing, command-palette ranking, and worktree pickup on the interactive hot paths (#11037, #11039)

### Bug Fixes

- GitHub panels no longer read "not connected" while the toolbar counts work — a legacy GitHub token is backfilled into forge credentials (#11033)
- The diff review no longer shows stale content while open — it surfaces a refresh banner when the underlying diff changes (#11032)
- Tooltips no longer strand on top of a modal — every dialog open and close clears them (#11030)
- The first click on an inactive Daintree window now registers on macOS instead of only focusing the window

## [0.23.1] - 2026-07-09

A fast follow-up to 0.23.0 focused on keeping terminals responsive under heavy output — smoother concurrent scrolling across mouse-reporting TUIs and snappier keystroke echo under load — plus fixes for the file viewer inflating the app layout and the forge toolbar starting up empty.

### Performance

- Scrolling several mouse-reporting TUIs at once no longer serializes their redraws — every actively-wheeled pane drains inline instead of stalling up to 250ms behind the others (#11026)
- Focused terminal keystroke echo stays responsive under heavy background output — saturated keystroke-to-paint latency roughly halves (p95 ~84ms → ~52ms) and frame pacing returns to 60fps (#11023)

### Bug Fixes

- The file viewer panel no longer blows out the app layout on tall files — long files scroll within their own pane (#11024)
- Forge toolbar repository counts populate immediately on a cold start instead of sitting empty for 30–60 seconds after launch

## [0.23.0] - 2026-07-08

A performance-focused release: the app boots 25% faster, switching back to a recent project is near-instant, agent terminals appear 5× faster, and steady-state memory drops across every process — plus a fix for the 45–60s freeze when revealing a project with backlogged terminals. A new file viewer panel opens any text file alongside your terminals, and agents now tell you why they're waiting.

### Features

**File viewer**

- Open any text file in a read-only viewer panel — markdown gets a rendered view, with source and wrap toggles (#10982)
- File viewer panels dock alongside terminals, keeping scroll position and view mode between dock and grid (#10988)

**Agents & terminals**

- Terminals now show why an agent is waiting — approval, question, error, or prompt — in the header chip, waiting popover, fleet badges, and OS notifications (#10949)
- File links pointing outside the project offer "Reveal in File Manager" instead of dead-ending on a copy-path toast (#10947)

**Memory & diagnostics**

- The memory badge popover shows real totals split into app memory and terminal workloads — the actual footprint of agent CLIs and dev servers running inside terminals (#10946)
- Background workers and utility hosts trim memory under the efficiency profile, and "Why am I slow?" gains a worker summary (#10951)

**Worktrees & review**

- Worktree cards show "Checking status…" while git resolves and offer "Review & Push" for unpushed commits; the review hub's clean-tree state gains a Push button naming the commit count (#10945)

**macOS**

- Drop a folder on the Dock icon to open it as a project (#10979)

### Performance

- Cold app startup is ~25% faster and warm startup ~8% faster (#10970)
- Switching back to a recently used project is near-instant — ~70–200ms instead of a ~1.5s stall (#10965)
- Agent terminals become visible ~5× faster after launch, and back-to-back launches no longer queue at one per second (#10972)
- Bulk worktree creation drops from 19 seconds to under one for 20 concurrent creates (#10977)
- Agent-output analysis costs ~3× less CPU — 30 streaming agents drop from ~12% to ~3.4% of a core (#10975)
- Quiet git-status polls no longer re-render the whole app, cutting idle re-rendering ~75% at high worktree counts (#10978)
- Background status polling spawns half the git subprocesses (#10974)
- Steady-state memory drops ~87MB in a four-project benchmark via renderer purges and slimmer terminal processes (#10981), and terminal processes compact their heaps when idle (#10973)
- Terminal resize and reflow are ~45% faster, keeping splitter drags across an 8-terminal grid under the jank threshold (#10983)
- Hot-path sweep: faster log scrubbing and agent-state detection, less git-poll and IPC overhead, quicker first render (#10968)

### Bug Fixes

**Terminals & agents**

- Fixed the 45–60 second renderer lockup when revealing a project view with backlogged terminals (#10957)
- Sidebar overlay terminals spawn at their real size instead of 80×24, fixing garbled startup output and progressive corruption (#10940)
- Agent session history is recorded exactly once per run, and relaunched terminals no longer inherit a predecessor's stale size or launch metadata (#10950)
- A window mid-reload can no longer abort terminal crash recovery for every other window after a pty-host restart (#10969)
- Terminal memory protection no longer goes blind to analysis-worker memory, preventing out-of-memory crashes under heavy load (#10953)
- Composer autocomplete no longer accepts stale file matches on quick Enter/Tab, and the input tints amber when fleet broadcast is armed (#10943)

**Worktrees & git**

- Git changes from agents in background worktrees stream in live instead of staying invisible until a commit, and new worktrees appear immediately rather than after up to 90 seconds (#10956)
- The forge toolbar error stripe appears only for persistent stats failures — transient blips retry quietly on a graduated backoff

**UI & panels**

- Cold launch shows your last project's accent color, name, and emoji on the boot skeleton instead of a gray placeholder (#10952)
- Snoozed notifications resurface when they escalate to errors, and the "Needs attention" list shows "+N more below" instead of silently dropping threads (#10944)
- Restored dialog, palette, and dropdown entrance animations that had degraded to fade-only snaps (#10963)
- Lazy-loaded panels show skeletons matching their own layout instead of a browser-shaped placeholder (#10987)
- Docked terminal title bars are draggable, and dock-to-grid drags can land in any slot (#10994, #10996)
- Docked file panels show the inline "Move to grid" button (#10992)

### Other Changes

- Automatic pre-agent git stash snapshots are removed — agent starts no longer accumulate auto-stashes in `git stash`

## [0.22.0] - 2026-07-04

A terminal-reliability and session-continuity release. The rendering pipeline now prioritizes whichever terminal you're looking at under heavy multi-agent load, CPU-bound work moves off the main thread, and a family of scroll and detection bugs is fixed. Closed agent sessions are now journaled and resumable from a searchable list, the empty grid becomes a recipe-forward launcher, and user plugins gain a full lifecycle — hot enable/disable, background updates, and a startup kill-switch.

### Features

**Session resume & history**

- Every terminal close now journals a resume record, so a closed agent session can be reopened later (#10849)
- Browsable, searchable resume-session list in the panel palette and a dedicated launcher palette (#10851)
- Reopen Last Closed falls back to the resume journal when no live snapshot exists (#10852)
- Clear session history per-project or globally from settings (#10853)
- Resumable agent sessions are exposed to automation over MCP (#10854)

**Terminal**

- Empty panel grid is reworked into a recipe-forward launcher with quick actions and resume shortcuts (#10930)
- Cmd+K chord indicator becomes a searchable command HUD
- Alt-screen mode is configurable per-agent and globally (#10876)
- Reveal in file manager added to the file-link context menu (#10873)
- Panel renames follow a title-ownership ladder so a user-set title survives respawn, records, and duplication (#10929)

**Diagnostics & fleet**

- "Why am I slow?" snapshot surfaces the current performance bottleneck on demand (#10910)
- Dev-preview gains a diagnostics timeline, classified proxy 502s, and a Diagnostics drawer tab (#10936)
- Fleet run supervisor keeps broadcasts supervised past submission, with richer run history and MCP visibility (#10935)
- Review hub gains a merge-readiness rail and a read-only readiness action (#10932)
- Transcript-driven agent-state eval harness, plus approval/error waiting reasons in state detection (#10934)
- Zen mode header surfaces the count of agents waiting on input

**Plugins**

- Hot enable/disable of user plugins with no restart (#10887)
- Background update checks and an Update all queue (#10893)
- Startup plugin blocklist / kill-switch to disable a plugin at load (#10891)
- Skills contribution point — plugins can ship skills (#10892)

### Performance

- Prioritize the focused terminal in pty-host backpressure and batching so background agents can't stall the pane you're watching (#10877, #10878, #10879, #10880, #10881)
- Offload CPU-bound analysis, SQLite, copytree, and diff work to persistent worker-thread pools (#10920)
- Fix PTY flow-control accounting to restore render quality under heavy output (#10933)
- Pace headless-mirror parsing and write-buffer entries to stop scroll stalls in long sessions (#10857, #10858)
- Speed up main-process persistence hot paths as session history grows (#10907)
- Back off idle-agent polling and async-serialize event snapshots (#10906)
- Stop panel status-buffer flushes fanning out into O(worktrees) recomputes every frame (#10908)
- Batch wheel reports and throttle agent-output diffing on the render path

### Bug Fixes

**Terminal & agents**

- Stop Codex agent-detection flapping that destroyed terminal scrollback (#10911)
- Restored sessions keep their provider — launch env is persisted, so a resumed session no longer resumes on the wrong provider (#10922)
- Scrolling a mouse-reporting TUI no longer flips the agent state to working (#10925)
- Bound the reconciliation watchdog with a circuit breaker so it can't re-wrap a diverged terminal every six seconds (#10909)
- Alt-screen mode hint no longer misattributes Grok's default to the global setting (#10894)
- Treat private-mode CSI sequences as non-keyboard input; keep invalid slash-command drafts editable

**Layout & panels**

- Terminal grid no longer flickers between two layouts on resize or when adding a 7th panel (#10871)
- Cmd+W closes just the panel, not the whole window, when a dev preview is the only panel (#10859)
- Terminal scrollbar gutter is conditional on scroll mode, fixing the inconsistent scrollbar across panels (#10883)
- WebGL DOM-fallback threshold holds under a resource-profile downgrade (#10858)
- Zen mode status label no longer truncates
- Forge toolbar pills no longer render duplicated in dev mode (#10937)
- Assistant no longer duplicates or garbles agent output on view reveal (#10863)

### Other Changes

- Continue/Abort rebase buttons are dropped from the worktree card (#10921)

## [0.21.1] - 2026-06-30

A follow-up to the full-screen TUI scroll work in 0.21.0. That release smoothed wheel and trackpad scrolling in mouse-reporting TUIs, but lag and stutter remained under load — most notably a "smooth at first, then slow and stays slow" case. This patch finishes the job, retuning the wheel-input path to VS Code parity.

### Bug Fixes

- Fix laggy, stuttering scroll in full-screen mouse-reporting TUIs like grok, lazygit, and btop — including the "smooth at first, then permanently slow" case where an actively-scrolled pane latched into the Efficiency profile and never recovered (#10848)
- Pace wheel and trackpad reports per animation frame so a trackpad momentum flood no longer saturates the PTY round-trip, and convert scroll distance off the live rendered cell height so the feel holds at any font size (#10848)

### Performance

- Trim terminal resize storms and reduce hover-regex cost on the render path (#10848)

## [0.21.0] - 2026-06-30

A memory-reclamation release: projects can now free their memory on demand and idle background projects auto-close, backed by a round of memory-hygiene and lazy-loading work. Grok (xAI) joins the agent roster — with terminal scrolling retuned for mouse-tracking TUIs — as the Gemini CLI agent is deprecated.

### Features

- Grok (xAI) agent support — launch Grok alongside Claude, Codex, and the rest of the roster
- "Free memory" action in the project switcher releases a project's renderer and terminals without closing it (#10829)
- Idle background projects with no terminals auto-close to reclaim memory (#10830)
- Press a terminal's Cmd+1..9 hotkey again to maximize it, once more to restore the grid
- MCP: agent.listToolbar discovery action surfaces pinned toolbar agents to automation consumers (#10838)
- Trackpad and mouse-wheel scrolling is smooth and precise in mouse-tracking TUIs like lazygit, btop, and the Grok CLI — sub-line trackpad motion is preserved, and each wheel notch advances a sensible number of lines

### Bug Fixes

- The idle-terminal "Close Them" action now actually kills the terminals it lists (#10831)
- Empty-state grid no longer renders narrow on first load before snapping to the sidebar width (#10827)
- Plugin consent prompts time out instead of hanging when a plugin abandons them (#10841)
- Preserved agent-terminal snapshots are now bounded, fixing unbounded in-memory growth (#10839)
- Full-screen TUIs no longer leave a dead overlay scrollbar thumb on screen — the terminal hides it while the alternate-screen buffer is active, where there's no scrollback to scroll
- The worktree assignment toast now auto-dismisses instead of staying stuck on screen

### Performance

- Lazy-load the xterm ImageAddon and Unicode11Addon so they load only when first needed (#10840)
- Prune unbounded add-only maps and sets to curb steady memory growth (#10842)

### Other Changes

- The Gemini CLI agent is deprecated (kept working, no longer recommended) rather than removed (#8811)

## [0.20.0] - 2026-06-28

The plugin system reaches its 1.0 contract, per-terminal hibernation is removed for good, and project switching becomes near-instant — the largest release since the project opened up, spanning 179 PRs. Most of the surface-level work is a deep terminal-rendering and project-switch reliability pass; underneath it, the plugin and MCP automation surfaces both grow substantially.

### Features

**Plugin system (1.0 contract)**

- Release-ready authoring toolchain: `@daintreehq/plugin-sdk` and `plugin-testing` packages, a `plugin-vite` preset, and `daintree-plugin dev` hot-reload (#10485, #10494)
- Manifest contract frozen for 1.0 — `experimental_views`/`experimental_mcpServers` promoted to stable `views`/`mcpServers` (#10478, #10495)
- Installed plugins run out-of-process in a utility worker with OS-level crash isolation (#10550)
- Fully Promise-returning host API with capability-gated `host.process.spawn`, `host.fs`, and `host.git` (#10540, #10543)
- Just-in-time consent for high-risk capabilities (shell, fs/git writes, agent input), revoked when a plugin updates (#10551, #10555)
- Plugin-contributed agents are fully launchable and drive the working/waiting/completed state UI (#10574, #10601)
- Plugins can decorate worktree file rows and set live panel-title badges (#10568, #10599)
- Native UI prompts mid-command via `host.showQuickPick` / `showInputBox` / `showConfirm` (#10549)
- Plugin MCP servers get a detail subtab (status, last error, stderr, restart) and auto-restart on secret rotation (#10595, #10628)
- Plugin-provided MCP tools route through consent → audit → rate-limit, re-prompting when a tool's danger tier escalates (#10486, #10535)

**MCP server**

- Forge write operations over MCP — PR create/merge/comment/edit, issue create/close/label, and PR-review approve/request-changes (#10657, #10658, #10659)
- Terminal/agent exit metadata (exit code, signal, timestamps) so a clean finish is distinguishable from a failure (#10642)
- Parsed pass/fail check results on `terminal.getStatus` from tsc, ESLint, Vitest, and Jest (#10691)
- `browser.captureScreenshot` returns real image bytes, plus console reads and dev-preview/portal control (#10689, #10692)
- Worktree resource lifecycle and a host-pressure resource-profile snapshot over MCP (#10690)
- Per-terminal and fleet arm/disarm, plus `terminal.restart`, over MCP tier allowlists (#10687, #10696, #10712)

**Agents & presets**

- Agent presets carry an optional display title (e.g. "Claude [Z.ai]"), surfaced across the agent button, dropdown, tray, and scope banner (#10740)
- The preset dropdown splits each row — click to launch with that preset, the left gutter sets the worktree default without launching (#10726)
- About Daintree shows the running build architecture (Apple Silicon, Intel, or Rosetta) (#10503)

### Performance

**Project switching**

- Cold switches reveal a themed skeleton in ~150ms instead of freezing on the outgoing project for seconds (#10751, #10760)
- A busy overlay covers slow switches while warm switches stay flash-free, with feedback flipped on before the heavy snapshot/IPC (#10737)
- RAM-scaled warm view cache and workspace-host pool eliminate the evict/respawn churn that froze the main loop when rotating projects (#10760)
- The efficiency profile freezes cached views instead of destroying them, ending cold-start storms on rapid switching (#10748)
- Background projects pause git-status polling, fetches, and PR checks while hidden (#10746)

**Terminal & memory**

- Faster priority terminal restore via parallel rehydrate, with the on-screen terminal repainting first (#10533, #10534)
- Project hibernation now evicts the cached renderer (~100-500MB) instead of just killing PTYs, while keeping terminals alive (#10796)
- Batched host-log writes and a coalesced worktree-update bus remove multi-second keystroke lag under multi-agent load (#10770)

### Bug Fixes

**Terminal & rendering**

- Removed per-terminal hibernation — backgrounded terminals stay live instead of suspending and resyncing on reveal. This eliminates the recurring agent-TUI corruption (zebra striping, double-spacing, dropped output) across OpenCode, Codex, Gemini, and Claude (#10811)
- Alt-screen TUIs (OpenCode, vim, Gemini CLI) no longer garble on click or reveal — previously only a manual window resize fixed it (#10805)
- Fixed a 60fps WebGL atlas-resync loop that pinned a CPU core and sheared glyphs after a refocus; bumps `@xterm/*` to 6.1.0-beta.287 (#10798)
- Eliminated DOM-renderer zebra banding for alt-buffer TUIs on HiDPI displays (#10771)
- Hidden streaming agents no longer steal WebGL contexts and drop visible terminals to the slower DOM renderer (#10673)
- Agent terminals no longer return garbled after a project switch-back (#10508, #10637)
- Windows: an invalid ConPTY pid 0 no longer starts process detection or spams warnings (#10791)

**Agents**

- A crashed agent CLI reports as "exited" instead of getting stuck on "waiting" (#10821)
- Agents no longer stick on "waiting" during long heavy-streaming output (#10666)
- OpenCode resumes its latest session on restart instead of showing a failed-restore banner (#10824, #10825)
- Typing into a backpressure-paused terminal wakes it (#10717)
- Pressing Enter at Claude's workspace-trust prompt no longer spawns a duplicate agent (#10631)

**Project views & crash recovery**

- The crash-recovery dialog no longer reappears after being resolved on switch-back (#10810)
- A project view that loads the wrong internal page rolls back instead of getting stuck (#10804)
- Fixed the forge status toolbar rendering twice, and a persistent red error line on it, during rapid switching (#10808, #10762)
- Workspace-host OOM crash-loops are detected and surfaced instead of looping silently in "Reconnecting…" (#10733)

**Git & forge**

- `git rebase/merge/cherry-pick/revert --continue` works again after the simple-git 3.36 upgrade (#10789)
- Background git-fetch auth failures retry with backoff instead of suspending fetches for the whole repo (#10675)
- Commit search matches commit-hash prefixes, not just message text (#10817)
- Self-assigning an issue during worktree creation reflects immediately in the open-issues dropdown (#10537, #10678)
- Stuck mid-rebase/merge worktrees get an inline abort/continue recovery row (#10716)

**Security & privacy**

- The external MCP API-key `fullToolSurface` opt-in no longer bypasses the curated allowlist (#10710)
- Plugin log output is secret-scrubbed before it reaches the log buffer and console mirror (#10781)
- V8 heap snapshots in the logs dir are auto-pruned, clearing previously unbounded backlogs (#10732)

**UI & onboarding**

- Creating a custom preset no longer hijacks the agent default, and recipe launches now honor the selected preset (#10730, #10725)
- Custom preset colors no longer wrap the agent icon in a near-white tile on dark themes (#10724)
- Toned down two passive notifications and persisted onboarding dismissals across restarts (#10553, #10554)
- Restored drag-to-grid, drag-to-worktree, and reorder on docked panel chips (#10799)
- Diff-viewer and commit-body wrapping fixes in the dropdowns (#10629, #10719)

## [0.19.1] - 2026-06-14

Same-day hotfix for two regressions introduced in 0.19.0: agent working/waiting state detection broke, and agent terminal grids came back with garbled line wrapping after switching away from a project and back.

### Bug Fixes

- Restore agent working/waiting state detection broken in 0.19.0, including background worktrees stuck on "waiting" under the Efficiency profile (#10487)
- Reflow the agent terminal grid on project switch-back so line wrapping stays correct without a manual Redraw (#10488)

## [0.19.0] - 2026-06-14

Finer-grained control over permission bypass and a round of panel/tab reliability work. Skip-permissions becomes a real setting — a global toggle, a first-run onboarding step, and a tri-state DangerousMode — while the in-app assistant gains the ability to name and rename its terminals. The bulk of the release hardens panel tabs, terminal rehydration, and tooltip/focus behavior.

### Features

- Global skip-permissions toggle, with a tri-state DangerousMode for permission-bypass control (#10432)
- First-run onboarding step to set the global skip-permissions preference (#10433)
- Assistant can name agent terminals at spawn time (#10439)
- Assistant and MCP can rename terminals via terminal.rename (#10436)

### Bug Fixes

**Panels & tabs**

- Prevent duplicate-as-tab crash with a two-pane split enabled (#10438)
- Keep grid order when a panel gains a second tab (#10440)
- Background the previous tab on a docked tab switch (#10442)
- Stop a tab drag from arming the parent panel drag (#10443)
- Clean up orphaned panels on add-tab failure and guard tab-group hydration against malformed groups (#10441)

**Terminal**

- Retry-until-stable reveal sweep recovers garbled panes
- Rehydrate hibernated agent terminals on foreground project-view reveal
- Repaint the assistant terminal after a project-view reveal

**UI polish**

- Suppress stuck tooltips on focus restore (ProjectSwitcher, AgentButton) and fix ContextMenu right-click
- Diff viewer keeps a persistent, always-visible horizontal scrollbar and no longer nests a double scrollbar
- Stop duplicate idle-terminal notification toasts
- Quick-run input border stays visible (#10429)

### Performance

- Forge hover prefetch fires instantly and cache-first

## [0.18.2] - 2026-06-09

A responsiveness and memory pass on top of 0.18.1. Structural UI changes now animate through View Transitions, several mutations apply optimistically instead of waiting on the round-trip, and a per-subsystem audit trims steady-state memory — rounded out with command-palette and console-scroll fixes.

### Features

- Structural UI changes animate via View Transitions instead of snapping (#10339)
- Optimistic UI for staging, fleet delete, and project rename — actions apply immediately and reconcile on confirm (#10339)

### Bug Fixes

- Console scroll-to-bottom now aligns to the true bottom when the last row is taller than the viewport step
- Runtime-gated actions no longer leak into the command-palette MRU or repeat-last when picked from the palette (#10336)

### Performance

- Steady-state memory reductions across subsystems from a per-subsystem audit (#10338)
- Cut main-thread stalls in terminal buffer capture, filtering, and broadcast (#10339)

## [0.18.1] - 2026-06-08

A same-day follow-up to 0.18.0 focused on cold-boot and first-paint speed, with a few UX-polish fixes. Most of the work trims the startup critical path — deferring non-essential imports, batching boot reads, and unblocking the deferred-init drain — alongside hover and dismiss refinements in notifications and global banners.

### Features

- Notification rows swap timestamp and snooze for action buttons on hover via an overlay layer
- Global recovery banners gain dismiss support and inset for the OS window controls

### Bug Fixes

- Worktree sidebar no longer animates from its default width on project switch (#10321)
- Sidebar refresh spinner now spins immediately on a direct user action instead of deferring behind the Doherty gate
- ScrollIndicator no longer leaks a stale count from abandoned concurrent renders (#10316)

### Performance

- Defer the PluginService import off the first-paint path (#10322)
- Fold `system:get-tmp-dir` into the batched boot payload (#10326)
- Eliminate redundant `config.json` reads on cold boot (#10324)
- Unblock the deferred-init drain from slow github-auth and sync-log prune (#10325)
- Lazy-load the E2E notification backdoor off the first-paint path (#10323)
- Preload the App entry chunk and disable the Chromium Translate feature (#9771)

## [0.18.0] - 2026-06-08

The Daintree Assistant learns to show its work, and GitHub stops being special. The Assistant gains a figure rail, lightbox, and inline doc images, and surfaces its MCP grant lifecycle and live session tier. Underneath, GitHub was rebuilt as one forge provider among many — issue creation, "assign to me", and worktree actions now route through a provider-neutral contract. The bulk of the release is terminal reliability: wake/hibernation correctness, memory-aware resource governing, and a deep round of flow-control and stall-recovery fixes that were previously dead in production.

### Features

**Daintree Assistant & help**

- Figure rail and lightbox in the help panel (#9829); animated WebP demo loops in the figure rail (#10278)
- Assistant displays doc-search images, with clickable `[image #N]` references in the terminal (#9831, #9830); `help.displayImage` MCP tool backs it (#9828)
- MCP grant lifecycle surfaced in the Assistant panel (#10042); live help-session tier and grants shown in settings (#10032)
- Agent-stuck and reasoning-loop outcomes surface as an ambient pip (#10018)

**Forge provider**

- `createIssue` added to the forge contract; `github:create-issue` routed through it (#9960)
- Provider identity capability makes "assign to me" provider-neutral (#9963); `github:work-issue` and worktree workflow lookups routed through the provider (#9957, #9959)

**Terminal reliability**

- Batch-scoped scrollback restore surface with in-progress badge and failure banner (#9806); restore-aware settle/wait primitive with a batch variant (#9804)
- Held-duration, queue-depth, and data-loss gauges on the reliability-metric event (#9807); tier-transition metric at the activity-tier chokepoint (#9797)
- Cycles-based Tier-3 watchdog for stalled terminals (#9808) and a reconciliation watchdog for visible-terminal rendering (#9781)
- Lost agent sessions now signal on silent respawn (#9802); five terminal recovery actions gained keybinding hints (#9803)
- Structured flow-control snapshot in the diagnostics bundle (#10060); `agent:state-transition-dropped` diagnostic event (#9868)

**Resource governing**

- Memory-aware targeted trim with per-terminal memory attribution (#9904)
- Non-empty `envHash` pool keys warmed on project restore (#9810)

**Fleet & automation**

- Saved fleets ranked by frecency (#9955); durable run history for recipe and fleet runs

**Demo & video**

- Video recording pipeline with a richer annotation system, plus a demo-video-creator skill
- Demo mode can type and send keys into agent terminals (#10138); bell-shaped cursor moves with subtle overshoot (#10153)

**MCP & diagnostics**

- Internal help-session connections shown in MCP server settings (#10036); audit anomaly signals surfaced as a Tier-1 ambient indicator (#10022)

**Toolbar & UI**

- Settings editor mirrors the toolbar's two-sided layout (#9826); segmented controls grouped and framed in the browser toolbar (#9815)
- Customize entry added to every toolbar right-click menu (#9825); project pill interaction states polished (#9824)
- Pulse heatmap gains a legend and high-contrast support (#9819)
- Dev preview warns when HMR live reload silently dies (#9975)

### Bug Fixes

**Terminal wake, hibernation & flow control**

- Wake no longer reports success when snapshot replay failed (#9896); background-to-active wake no longer writes the same bytes twice (#9897)
- Suspended terminals resync when the wake path declines the snapshot (#9894); late wake no longer leaves a hidden terminal streaming at full rate (#9906)
- Held ingest bytes no longer leak port acks on hibernate or double-paint on wake (#9910); data-loss markers survive a hibernate/wake cycle (#9907)
- IPC flow-control ledger no longer mixes UTF-8 bytes with UTF-16 ack units (#9893); drop pulse no longer erases pause tracking for a still-paused terminal (#9902)
- Destroying a hibernated terminal no longer leaks its host element (#9909); spurious "Output dropped" marker on fresh agent-terminal start suppressed (#10309)
- Stall escalation and held-duration UI now live in production (#9898); stall-recovery banner can actually appear (#9889)
- Multi-window fan-out no longer drops terminal output for a saturated window (#9891)

**Resource governor**

- Governor heap signal now includes external memory where scrollback lives (#9905); utilization measured against its own cap (#9905)
- Stale "Paused (memory)" pill cleared after the governor disengages and across exit/restart/host-crash (#9895, #9899)
- Throughput gauge no longer underreports after idle gaps or misattributes pause deltas (#9903)

**Forge & GitHub migration**

- Per-project forge provider override now honored by every forge operation (#9984); `forge.validateToken` carries provider identity so the Test button can't hit the wrong forge (#9985)
- Forge credential save now reaches the provider impl (#9983); forge IPC handlers regained the rate-limit guard (#9956)
- Projects with no matching forge provider stop polling every 5s forever (#9997); non-elected sibling windows no longer pinned to a 5s poll cadence (#9978)
- Transient forge errors no longer clear PR rows (#9994); worktree fetch backoff restored after the RPC-bridge migration (#9987)
- PR detection no longer collapses "declined" to "closed" before linked state is composed (#9981); worktree open-issue/PR actions no longer report success when nothing opens (#9980)
- Removed the `github.*` one-release action aliases, five releases overdue (#9989)

**Crash recovery**

- Crash cause is now surfaced, and marker-only crashes get a log file (#10063); marker-only entries no longer stamp relaunch time as the crash time (#10062)
- GPU-crash fallback relaunch no longer recorded as a crash (#10065); failed crash-recovery restore no longer treated as success (#10064)
- Renderer-crash recovery page now shows its panel count (#10066)

**Context injection**

- Test Configuration panel no longer always shows zero excluded files (#10000); preview populates the file list and respects cleared/unsaved settings (#10002, #10004)
- Malformed `copyTreeSettings` no longer corrupts context generation (#10001); file tree no longer leaks gitignored entries in very large directories (#10003)
- Context-injection progress and cancel UI are now wired up (#10034)

**Artifacts & code blocks**

- Code blocks larger than the 5KB analysis window are no longer silently dropped (#9999); patch extractor no longer misdetects Markdown rules and lists as diffs (#9998)
- Apply-patch now shows a confirm and diff preview before mutating the worktree (#10020); renderer artifact store no longer leaks entries when terminals close (#10023)

**Accessibility & color-vision**

- Diff viewer respects color-vision-deficiency overrides (#10049, #10028); status-success vs status-danger gated under simulated CVD (#10052)
- Agent state on panel and dock tabs exposed to screen readers (#10024); collapsed panels no longer keep focusable children in tab order (#10025)

**Notifications**

- Toasts fired into a blurred window no longer auto-dismiss unseen and marked read (#10056); grid-bar history no longer marked seen while notifications are disabled (#10058)
- Advisory global banners no longer suppress actionable pane-local error banners (#10038); passive eventKind policies no longer silently demote or drop producer notifications (#10051)
- Resume banner no longer claims a session was resumed when the renderer used `--continue` (#10057)

**Browser & dev preview**

- Browser panels no longer share one session partition across all projects (#9965); JS dialogs dismissed on guest navigation and renderer crash (#9966)
- Dev-preview proxy no longer 502s against an HTTPS dev server (#9974); `ERR_FILE_NOT_FOUND` on main-frame load surfaced (#9966)

**Agent detection**

- Busy-agent teardown no longer publishes a spurious waiting transition and false notification (#9867); 1Hz status-line repaints can now recover a waiting agent back to working (#9874)
- Parallel-output promotion no longer strands the agent FSM in working (#9875); simple-output mode now runs the full detection layer set (#9873)
- Kimi boot and working patterns corrected (#9876)

**Fleet**

- Per-target overrides/skips reconciled when a pane leaves the armed set (#9973); broadcast-result IPC re-subscribes under HMR/test reset (#9967)
- Recipe grid keyboard model runs the focused recipe on Enter (#9962)

**Security & IPC**

- IPC handlers no longer leak raw Zod error detail to the renderer (#9883); path scrubbers now cover WSL UNC and non-C-drive Windows user paths (#10046)
- Preload-backdoor gate now scans main-process E2E backdoors too (#10026); WSL UNC validation centralized (#9901)

**Plugins**

- Plugin agent icon/name/color now update mid-session in the renderer (#9879); `createMockHost` realigned with the real `PluginHostApi` (#9878)

**Lifecycle**

- Deferred init queue halts at quit so tasks can't re-init torn-down services (#9881); deferred-init task failures now surface instead of being swallowed (#9885)
- Always-mounted dialog hosts auto-recover from render errors (#10017); palettes and dialogs stay mounted through exit animation

**Worktree sidebar**

- Reduced-motion respected on card chevrons; double-click collapse scoped (#10319); reconnect announcements ordered and sidebar header shift stopped (#10318)
- Reorder announced using the card headline, not the bare name (#10317); scroll-indicator count latched through its fade-out (#10316)
- Empty-state title gated on the deferred query (#10314); restart-service button label sentence-cased (#10313)

**CI & infrastructure**

- Nightly failure reports keep Windows shards and survive re-runs (#10059); stale-quarantine scan made order-independent and closes resolved issues (#10040)
- arm64 Windows build now smoke-tested before publish (#10030); nightly publish verifies CDN-edge metadata (#10031)
- Perf baselines gained a freshness warning and coverage gate (#10007); CLAUDE.md/perf docs corrected to match real CI gating (#10069)

### Performance

- `app://` assets served from disk instead of `net.fetch`; first-render chunk closure preloaded in index.html
- Plugin-MCP audit pre-warming deferred off the cold-boot path (#10073); copytree graph lazy-loaded off the readiness path (#10071)
- Demo-mode tooling lazy-loaded out of the production first-paint chunk (#10074); first-paint work cut in the new-terminal cold path (#9809)
- Warm project switch no longer delays terminal output behind worktree git load (#10075)
- Issue/PR dropdown revalidation gated on open state (#10125); CI-status enrichment dropped on unattended instances (#10124); toolbar counts decoupled from the first-page query (#10122)
- Action manifest cached per pinned WebContents (#9887)

### Other Changes

- Upgraded to Electron 42 (Chromium 148); `better-sqlite3` carries a V8 14.8 source patch so it compiles against the new ABI

## [0.17.0] - 2026-06-05

Light mode looks designed. The light-theme token engine was rebuilt for perceptual contrast, Bondi Beach became the gold-standard template, and the six remaining light themes were redesigned on it. Alongside: a live MCP tool-call activity strip in the Daintree Assistant, context-aware keyterm biasing for voice dictation, and a deep round of terminal project-switch and GitHub-count fixes.

### Features

**Light themes**

- Light-mode token engine reworked for perceptual contrast, with status-surface tokens and per-theme design knobs (#9708)
- Depth-budget and border-separation audits plus a second-round contrast audit across all light palettes
- Bondi Beach redesigned as the gold-standard light theme (#9711)
- Svalbard, Atacama, Bali, Table Mountain, Serengeti, and Hokkaido rebuilt on the Bondi template (#9714, #9709, #9710, #9715, #9713, #9712)

**Daintree Assistant**

- Live MCP tool-call activity strip with result summaries (#9759)
- Expandable recent-call history popover (#9760)

**Voice dictation**

- Context keyterms wired into transcription session start and the Deepgram connection (#9743, #9744)
- Keyterm biasing with terminal-derived terms ranked by frequency and recency (#9745, #9750)
- Dictionary words learned from transcript corrections (#9749)

**Dock & sidebar**

- Insertion indicator when reordering Content Dock chips (#9685)
- Recency band and recipe first-run cue in the Dock launch menu (#9682)
- Clearer move-to-grid affordance on dock chips (#9683); tightened waiting-agents popover (#9658)
- Visible keyboard cursor on worktree sidebar rows (#9667); per-section active-filter state in the filter popover (#9661)
- GitHub avatars in PR/issue tooltips, with creator distinguished from assignee (#9695)

**Other features**

- Broadcasting from the fleet hybrid input no longer requires a confirm step (#9722)
- Toolbar badge shows real open issue/PR totals instead of capping at 20+ (#9717)
- Dev preview uses the agent-terminal spinner for loading and restart states (#9763)
- Tooltips auto-dismiss after a hold window, with a per-tooltip opt-out

### Bug Fixes

**Terminals & project switching**

- Terminals no longer show stale or blank content on project switch-back until clicked (#9702)
- Redraw on one agent terminal no longer blanks a sibling pane (#9701); stale WebGL flashes on reactivation fixed (#9679)
- Daintree Assistant no longer leaks into the panel grid as a second agent (#9699), resumes instead of restarting on project switch-back (#9639), and wakes properly on project return (#9637)
- Cmd+W closes the clicked docked terminal instead of the Assistant (#9659)

**Recipes**

- Recipe-launched agent terminals paint on first mount instead of staying blank (#9649)
- Agent launch flags persist across recipe spawn and resume (#9650); model id passed into recipe initial commands
- Clone layout preserves docked panel placement (#9764)

**GitHub & worktrees**

- Toolbar issue/PR counts stay fresh via recency arbitration and adaptive polling (#9741); count badge matches what the dropdown lists (#9693)
- Worktrees with only a closed or declined PR count as waiting, not finished (#9731)
- Stuck "GitHub authentication failed" stripe retries on sync-badge click (#9736)

**Themes & settings**

- Live theme switches re-apply every token without a restart (#9716)
- Settings dialog color components respect the active theme (#9707)
- Skeleton CSS no longer leaks stale optional tokens after a theme switch; theme browser panel occlusion fixed

**Dev preview**

- Proxy supports IPv6-only Vite dev servers instead of 502ing (#9747)
- Restart options use an overflow glyph instead of a duplicate chevron (#9748); loading state fills the panel height

**Other fixes**

- Auto-update relaunch no longer treated as a crash (#9638)
- Crash fixed in a CDP debugger teardown race (#9647); orphaned hibernate sessions cleaned up on project delete or relocate (#9642)
- Focus-mode gesture and toolbar toggle no longer fight over Assistant visibility (#9641)
- Worktree sidebar: instant search filtering (#9663), accurate offscreen-count pills (#9666), screen-reader announcement fixes (#9662, #9665)
- Shortcut hints name the action instead of a bare "Tip:" (#9648); panel context menu uses sentence case with destructive items isolated (#9680)

### Performance

- Voice correction prompt restructured to be prompt-cache-eligible (#9746)

## [0.16.0] - 2026-06-02

The plugin manager grows up. Per-plugin configuration, capabilities, and permissions move out of the settings tab into a dedicated first-class view with a master-detail layout, source/state grouping, and filter-operator search, and a `daintree://` deep-link scheme can install or open plugins from outside the app. Alongside it: a round of memory-leak and long-session fixes (xterm dispose, PTY fd, disk-state growth), tightened destructive-action gates, and a large internal E2E-coverage expansion.

### Features

**Plugin manager**

- Graduated into a dedicated first-class view with a back button and OS window-control spacers (#9558, #9548)
- Master-detail layout replacing the inline settings panel (#9555); per-plugin settings now shown for disabled plugins too (#9549)
- Plugin list grouped by source and state (#9554); filter-operator search (#9557)
- Declared capabilities and danger surfaced in the manager (#9556); restart-required banner for pending changes
- `daintree://` deep-link scheme for plugin install and open (#9559)
- `contributes.agents` contribution point for registering agents (#9560)

**Worktree & motion**

- "Finished" chip added to the Worktrees Overview quick-state filter (#9607)
- Coordinated notification toast-stack motion (#9618); spring physics on the panel drag-overlay pickup (#9617)

**Destructive actions**

- Hardened destructive-action confirm/danger enforcement gates (#9567); confirm dialogs now block when an async preview fails to load (#9570)

### Bug Fixes

**Leaks & long-session stability**

- Bumped `@xterm/*` to 6.1.0-beta to fix the Terminal graph leak on every dispose (#9540)
- Released the master PTY fd on live-terminal teardown and exit (#9539); guarded against Windows ConPTY double-free
- Re-run disk reclamation across long sessions instead of only at boot (#9537); pruned orphaned diagnostic-store entries on panel/worktree removal (#9536)

**Rendering & state**

- Project-switch WebContentsViews no longer flash white on cold-start swap (#9573)
- Renderer-gone handler now distinguishes OOM from memory-eviction (#9572)
- Persist docked popover height across restart; keep the default when hydrating an unset value
- Dropped the blur filter from the AnimatedLabel crossfade for crisp text (#9615); moved discrete-feedback keyframes onto the front-loaded easing token (#9616); froze evicted background toasts at their exit position
- Stopped the PR CI status dot flickering on refresh (#9551)

**Plugins & MCP**

- Derived MCP `destructiveHint` from the danger classification rather than kind (#9568)
- Isolated cached manifest schemas from nested mutation (#9569)
- Resolved settings for launch-disabled plugins; swapped the `Plug` icon for `Package` across plugin UI

### Performance

- Coalesced overlay/scroll layout reads through a shared rAF throttle (#9580)
- Visibility-gated stray ungated renderer timers (#9583)
- Trimmed redundant per-chunk allocations in agent-state detection (#9581)
- Migrated audit-log viewers onto the shared minute ticker (#9582)
- Bounded background git file-watchers via an LRU budget (#9538)

### Other Changes

- Large E2E-coverage expansion across GitHub, Review Hub, fleet broadcast, notifications, plugins, terminal agent-state, new-worktree, panel layout, settings/theme, recipes, command palette, and adaptive recovery (#9588–#9599), plus a minimal online suite against the real GitHub API (#9600)
- Sharded unit tests across 4 parallel CI runners; nightly infrastructure hardening and an E2E watchdog
- Architecture documentation overhaul

## [0.15.0] - 2026-05-30

Daintree gains a plugin platform. The `.dntr` archive format, an atomic install/uninstall pipeline, a `daintree-plugin` CLI, the `@daintreehq/plugin-sdk`, a compound-capability lattice, and an MCP supervisor together let third-party plugins contribute commands, menus, keybindings, settings forms, and experimental views — all sandboxed behind manifest-declared capabilities. Voice input matured with client-side VAD, push-to-talk, and dictation target locking; dev preview now persists sessions across relaunch and surfaces a cross-worktree dashboard; and notifications gained a persistent inbox with OS Do-Not-Disturb awareness.

### Features

**Plugin system**

- `.dntr` archive format specified with a reference implementation
- Atomic plugin install — temp-extract, validate, swap, rollback — with install provenance persisted
- `daintree-plugin` CLI for new/validate/package/install/uninstall
- `@daintreehq/plugin-sdk` public export boundary defined
- Compound-capability lattice with manifest scopes (#9247) and per-boundary exception containment
- Drag-and-drop `.dntr` install in the settings tab; sideload from Windows/Linux second-instance and macOS `.dntr` file association
- Bounded fetch for install-from-URL; manual update check with settings-preserving reinstall
- Uninstall with dispose cascade and secret-preservation prompt; enable/disable for user-installed plugins
- `contributes` wired end to end — commands, context menus (with `when` evaluation), keybindings, generated settings forms, and `experimental_views` as panel kinds (#9229, #9289)
- Inline renderer host for plugin views; `plugin://` static-asset protocol and `plugin:` CSP scheme
- Host API — `host.settings`, `host.dispatch`, `host.registerAction`, `host.showToast`, host import map
- `daintree.*` namespace locked to first-party plugins; typed `plugin.invoke` channels with Zod schema + capability gate
- Structured audit log for plugin-action dispatch and `plugin:invoke` failures
- `PluginMcpSupervisor` spawns stdio MCP subprocesses with inbound consent, permission gating, and lazy two-tier tool discovery (#9171)
- Plugin diagnostics export and a host contract test harness with sample plugin

**Voice input**

- Client-side VAD replaces the blind 2s commit timer
- Push-to-talk recording mode and a pre-recording arming state for target confirmation
- Dictation target lock with recent-targets memory; pause state (#9191); interim text rendered as a ghost widget to preserve undo (#9172)
- `TranscriptionProvider` abstraction with a Deepgram backend; WebSocket resilience
- Structured error model with severity-based recovery (#9171); data-flow disclosure in Voice Settings

**Dev preview**

- Running sessions persist across relaunch (#9094) with a PTY-layer crash-loop guard
- Promoted into a Portal tab; cross-worktree dev-server dashboard
- Framework-aware npm script detection with cached dirs; script picker in the running pane header
- Stable `*.localhost` proxy origin so cookies/localStorage survive restarts; sign-in token handoff for open-in-real-browser
- `Cmd+R` reloads the focused dev preview (#9497); cert/SSL failures get a distinct error overlay

**Notifications**

- Persistent inbox with age-based retention; OS-level Do-Not-Disturb awareness (#9188)
- Per-thread snooze with Linear-parity keybindings; "what will fire" gate summary
- Diagnostic row actions and a toggle action routed through `ActionService`

**Browser & file viewer**

- Back/forward sourced from Chromium NavigationHistory; webview crash and unresponsive state surfaced
- Match-case toggle in the find bar
- Diff-mode hunk position indicator and sticky scope header in the code viewer

**Recipes, themes & worktree**

- Batch-spawn recipe panels in a single layout commit; live variable-resolution preview in the editor; shadowed recipes surfaced (#9195)
- Cross-theme accent distinctness restored (#9225); contrast validator extended to rgba tokens; ANSI/syntax colors validated across all built-in themes; surface elevation ramps evened out
- Issue assignment made visible and reversible (#9181); dev-server state surfaced on the dashboard; focus restore and file-stepping in change viewers

**Diagnostics & recovery**

- Perf tab with live metrics and CI budget status; prebuilt redactions, time window, and GitHub handoff
- Pre-crash action trail and report preview in the crash dialog; central demotion hook with category opt-out
- macOS silent-install-failure detection for auto-update; bounded notarization wait with a recovery path

### Bug Fixes

**Security & privacy**

- Every `shell.openExternal` funneled through the `openExternalUrl` allowlist; renderer `authUrl` validated before side effects
- E2E test backdoors stripped from production builds
- PII leaks closed in crash report titles and Windows arg paths; scrubbed stack surfaced in the production crash fallback
- Path-bearing IPC handlers hardened, clipboard image bytes capped, and a symlink-extension bypass closed

**Terminal**

- Failed spawn state persisted and retry deadlock prevented; manual restart banner with locked input and parallelized IPCs (#9164)
- Hybrid input bar and voice-active guard gated on reconnecting/restarting state
- Single-action rule enforced on error banners

**Windows, portal & persistence**

- `win.show()` gated on dom-ready to eliminate the blank-window flash; show-fallback timer cleared on close
- Portal white flash eliminated and embedded state preserved across overlay cycles; focus returned on hide; drag listeners cleaned up on unmount
- User config preserved on corruption and write failure; backup kept consistent with the durable primary write

**Dock & accessibility**

- Empty dock stays interactive; spurious-close guard replaced with a migration-aware focus guard
- VoiceOver announcements kept alive while modals are open; close-then-announce formalized; correct `ariaNotify` priority with stale-replay prevention

## [0.14.1] - 2026-05-27

Bugfix follow-up to 0.14.0. Terminal regressions around Tab passthrough, F11 in screen-reader mode, and suspended process kill are fixed; dev preview now coordinates port release, Vite port injection, destructive-confirm content previews, and stuck-tier thresholds; worktree delete waits for a running dev preview to stop.

### Bug Fixes

**Terminal & keyboard**

- Tab passes through to PTY for shell autocomplete (#9082)
- Bare F11 no longer toggles fullscreen when the terminal is focused (#9104)
- Suspended PTY descendants woken with SIGCONT before SIGTERM (#9085)
- Focus-region rebinds to bare text keys no longer steal terminal input (#9105)

**Dev preview**

- Stop path waits for TCP port release before declaring stopped (#9088)
- `--port` injected into Vite-based dev commands so they honor the allocated PORT (#9092)
- Destructive confirm dialog shows the concrete content preview instead of a generic warning (#9086)
- Stuck-tier banners retuned and Tier 2 suppressed during mid-compile (#9099)

**Worktree**

- Running dev preview stopped before worktree delete (#9084)
- Portal option dropped from worktree sidebar issue/PR menus (#9103)

### Other Changes

- Lint guard prevents direct assignment to `autoUpdater.channel` from flipping `allowDowngrade` (#9123)

## [0.14.0] - 2026-05-26

GitHub and forge traffic was overhauled — host-side batch loading, cross-window GraphQL coalescing, an ETag-gated REST activity probe in front of PR detection, and in-band CI aggregates folded into the list query make PR and issue surfaces materially cheaper to poll. A broad accessibility sweep landed across menus, dialogs, palettes, the assistant, and forced-colors mode. The #8957 panel-refactor epic completed: `PanelInstance` is now the renderer carrier and `TerminalInstance` is gone. Five performance budgets gate every PR with a sticky summary comment.

### Features

**GitHub & forge**

- Host-side BatchLoader coalesces forge provider calls behind a single bridge (#9043)
- Forge contract gained freshness pass-through and `reviewDecision` (#9044)
- Caching, in-flight dedup, and a probe gate now flow through the forge provider (#9046)
- Per-query GraphQL `rateLimit.cost` captured for quota diagnostics (#9052)
- Budget throttle wired into renderer polls; redundant `/rate_limit` timer dropped (#9054)
- Repo-level REST ETag probe runs in front of PR detection (#9056)
- PR-poll boost cadence decays on stuck CI checks (#9057)

**Accessibility**

- Automated focus-ring visibility validation (#8940)
- `prefers-contrast: more` expanded beyond terminal panel borders (#8939)

**Notifications**

- Notify routing centralized in an EventKind policy manifest (#9007)
- Threads re-promoted on severity escalation and un-snooze (#9008)
- `useSkeletonDisplayFloor` minimum-dwell hook added with documented Suspense interaction (#9005)

**Panels & welcome**

- Panel kinds can now diverge on dock and focus behavior via per-kind descriptors (#8946)
- Property-syntax variance enforced on `PanelKindConfig` via lint rule (#8961)
- Backgrounded panels are now eligible for hibernation (#8965)
- Welcome screen drives one clear first step (#8955)
- First-run setup wizard split into discrete steps (#8966)
- Recipe runner empty state surfaces detected run-command suggestions (#8947)

**UI & interaction**

- Bulk Empty trash action with confirm dialog (#8962)
- Kinetic enter cue distinguishes fleet preview from multi-select (#8995)
- Slim panel grid scrollbar with tinted gutter (#8913)
- SkeletonHint long-wait escalation redesigned (#8910)
- Source PR captured when creating a worktree from the PR dropdown (#8888)

**CI & budgets**

- Five performance budgets gate every PR (renderer bundle, first-render chunk, renderer imports, import budget, compiler bailouts) (#8900)
- Module-set and per-T0-chunk gates added to the renderer-import budget (#8890)
- First-render chunk budget wired into CI with sticky PR comment (#8898)
- All five budget summaries post as one sticky PR comment (#8901)
- Compiler bailout ratchet is now severity-aware (#8892)
- Per-rule ESLint warning counts tracked in the ratchet (#8891)
- Markdown summary emission added to budget-check scripts (#8899)
- PR-trigger arm added to the fix-with-test ratio gate (#8897)

### Bug Fixes

**Accessibility & keyboard**

- `aria-keyshortcuts` exposed on context and dropdown menu items (#8941)
- ARIA live regions and list semantics added to the shortcut reference dialog (#8943)
- `EmptyState` aria-live announcements debounced to stop screen-reader floods (#8971)
- Three live-region bugs silently dropping screen-reader announcements (#8942)
- Macro-focus region landmarks polished for screen readers (#8931)
- Key-state transitions announced to screen readers (#8937)
- Command palette accessibility polished (#8929)
- Terminal pane accessibility gaps for screen-reader users closed (#8935)
- Toolbar shortcut discoverability gaps closed (#8938)
- Status indicators and toggles restored in forced-colors mode (#8936)
- Forced-colors fallbacks added for chrome selection states (#8932)
- Four JS reduced-motion gates now respect the Daintree reduce-animations toggle (#8930)
- Aria-modal dropped on exiting palette dialog (palette handoff overlap, #8948)
- Visible focus state restored on the Daintree Assistant (#8903)
- Focus rings restored on browser webview and sidebar rows (#8933)

**GitHub & forge**

- Caching and in-flight dedup restored in the CodeForge data path (#9053)
- Unbounded `reviewThreads` GraphQL pagination capped at 5 pages (#9059)
- Redundant tooltip GraphQL calls eliminated via list-query cache prewarm (#9058)
- GitHub rate-limit REST blocks now clear proactively via timer (#8974)
- Bulk worktree create surfaces self-assignment failures instead of swallowing (#8975)
- Drag preview status indicator matches the canonical agent state icon and color (#8973)

**Panels, focus & dialogs**

- New-panel focus policy decoupled from spawn provenance (#8945)
- Additive-direction gaps in panel-kind serializer ratchet closed (#8959)
- `BASE_PANEL_FIELDS` lockstep compile-time enforced in panel persistence (#8960)
- Remaining panel-kind registries pinned with `satisfies` (#8958)
- Trash and background group restore metadata de-anchored (#8944)
- Dialogs accept `restoreFocusTo` for logical-successor focus when the trigger unmounts (#8970)
- Open popovers reposition when the right-side panel toggles (#8969)
- Anti-flicker palette gate split into typed-input (200ms) and discrete-action (400ms) tokens (#8993)
- Review & Commit loading states shape-match with skeletons (close-mid-load crash fixed) (#8908)

**UI polish**

- Toast dwell defaults lowered toward the industry midpoint (#9009)
- Floating-UI entry motion tightened (slide and scale) (#8968)
- Armed-state ring on toolbar buttons now snaps instead of fading (#8967)
- Accent fills removed from multi-select checkboxes and switches (#8950)
- Fleet-preview enter cue stays invisible under performance mode (no #)
- Tooltip and shortcut-hint reopen on the command palette button suppressed after focus restore (no #)
- Surface-highlight lift scoped to the assistant header instead of the full aside (no #)
- Assistant grid terminal-selected chrome suppressed when the assistant has focus (no #)
- Voice keyframes cleanup + CLAUDE.md drift corrected (#8934)
- `Cmd+Shift+V` routed to the focused Daintree Assistant; assistant dictation shortcut added (#8887)

**Agents & dev preview**

- Antigravity auth detection uses inherited Gemini OAuth paths instead of a nonexistent path (#8918)
- Dev-preview server now stops on background, matching trash behavior (#8963)
- `GitInitDialog` spinner Doherty-gated and the silent commit-message default removed (#8956)

**Terminal**

- Redraw menu item added to the panel header and context menu (no #)

**CI & tests**

- Nightly fix-with-test ratio gate tightened against sampling noise (#8896)
- Bundle-budget failure message no longer references a non-existent label (#8894)
- Silent budget-override flag replaced with a linked-issue gate (#8902)
- `lint-ratchet` ESLint subprocess heap bumped to 4 GB (no #)
- Nightly workflow stabilized (no #)
- `opencode-online` E2E suite env-gated when OpenCode is absent (#8883)
- Voice-input Clear-button selector tightened to avoid disabled-button match (#8882)

### Performance

**GitHub & forge**

- GraphQL activity probe replaced with REST events + ETag (#9041)
- Numeric `#N` and range searches batched into a single GraphQL query (#9047)
- Required-checks signal folded into `LIST_PRS_QUERY` via in-band aggregates (#9060)
- Forge-bridge GraphQL calls coalesced across Electron windows (#9055)
- Tooltip and CI lookups batched at the forge bridge

**Layout & build**

- CSS layout containment added to resizable sidebar and assistant columns (#9014)
- First-render chunk seed list derived from the panel-kind registry (#8895)

### Other Changes

- TerminalInstance fully drained from the renderer store — `PanelInstance` is the carrier (closes #8957)
- `EmptyState` user-cleared scale narrowed to `sidebar | canvas` (#8972)
- Tab-group dissolve and recreate deduped across background and trash (#8964)
- Redundant motion wrapper removed from `SortableTabButton` (#8996)
- Shared agent welcome card eligibility check extracted from `WelcomeScreen` (#8952)
- Accent restraint tightened to per active focus region (#8953)
- Accent-guard allowlist hygiene checks added and stale entries audited (#8954)
- Forge `matches` contract corrected — exact-hostname only, no glob support (#8949)
- Stale forge/github routing comments corrected (#8951)
- Five performance budgets documented as PR-build gates (#8980)

## [0.13.0] - 2026-05-24

The panel grid was reworked from count-driven to size-driven and now scrolls when fleets exceed the viewport, with a custom scroll chrome that survives panel churn. Cold-start trimmed further — PTY and workspace hosts fork concurrently, app:boot IPC overlaps the first render, and four background services defer past first paint. The action palette grew pinning, scope chips, mode-prefix routing, and destructive-action disclosure. The Daintree Assistant surfaces launch failures, MCP cascade, and pinned context inline. Antigravity (agy) joins the built-in agent roster.

### Features

**Panel grid**

- Size-driven scrollable grid replaces the count-driven layout — large fleets scroll instead of crowding (#8805, #8830)
- Custom GridScrollbar replaces the native scrollbar and stabilizes against panel open/close (#8858)
- Automatic grid recalibrated for laptop and wide displays

**Action palette**

- Pinning and eviction on the empty-query rail (#8815)
- Scope chip and mode-prefix routing narrow the search context (#8812, #8814)
- Destructive classification surfaces on action rows (#8825)
- Frecency now drives the MRU bonus (#8823)
- Enter on a disabled row is a silent no-op

**Command palette**

- Dedicated command-palette toolbar button (#8813)

**Daintree Assistant**

- Inline banners surface launch failures instead of leaving the panel blank (#8773)
- Version gate gained a Check again button so an indeterminate probe is recoverable (#8774)
- Launch FSM phase is shown in HelpPanel during auto-launch (#8771)
- Pinned ActionContext binding shows in the HelpPanel footer (#8772)
- Resume-latest fallback when session-ID capture fails (#8787)
- Daintree Assistant tab discloses the MCP-server cascade (#8777)

**MCP server**

- Stopping the MCP server now confirms and gracefully drains (#8779)
- Settings tab surfaces currently connected clients (#8778)
- McpConfirmDialog hardened with a read-time cooldown (#8824)

**Agents**

- Antigravity CLI (agy) added as a built-in agent (#8808)
- Terminal agents identified by executable image path, not just title heuristics (#8790)
- Agent model lists and context windows resolve at runtime (#8789)

**Crash safety**

- Help-session PTY reaping extended to macOS and Linux (#8769)

**Theme**

- Low-contrast accent color overrides now surface a contrast warning (#8822)

**Worktree sidebar**

- Bordered-row loading state replaced with shimmer cards (#8804)

**Actions**

- New isVisible structural hide-tier on ActionDefinition (#8816)

### Bug Fixes

**Worktree**

- Worktree sidebar shows the linked PR under the issue title again — forge provider calls now route through the IPC bridge (#8870)
- Upstream sync badge no longer merges counts or pulses on every poll (#8872)
- Worktree sidebar branch indicator preserved when the GitHub fetch hasn't landed yet (#8851)
- Renderer preserves issueNumber on issue-not-found and derives a readable title from the branch

**Terminal & grid**

- Bulk-opening agent terminals no longer leaves a second pane blank (#8864)
- Clicking between agent terminals no longer flips state to working (#8865)
- Grid keyboard navigation reads column counts from the rendered grid snapshot (#8857)
- Move-up/move-down terminal actions use the real grid width (#8859)
- Terminal buffer repaints after DOM→WebGL renderer swap on attach
- Optimistic close wired to all grid panel close paths; pending resize cancelled
- Grid scrollbar uses scrollTo() and forwards wheel events correctly

**UI polish**

- Combobox trigger buttons restore truncation (#8843)
- Toolbar issue/PR count badge no longer shows a persistent dash (#8826)
- Freshness clock glyph no longer clips in the toolbar pill (#8849)

**Boot & host stability**

- Utility-host bootstraps hardened against native-load hang (#8829)
- GpuCrashMonitor kept eager so its listener installs before the GPU process spawns (#8817)
- Pre-ready spawn replay and PATH-refresh gate hardened (#8827)
- Cold-switch paint gate tightened (#8818)
- Workspace prewarm-path derivation hardened against errors

**MCP & GitHub**

- MCP confirm-dialog cooldown render-gap and timeout overlap closed
- GitHub toolbar count badge preserves confirmed-zero counts and bounds snapshot TTL
- GitHub bulk-create dialog view registered eagerly so it always opens

### Performance

**Cold start**

- PTY host fork deferred past first renderer load (#8827)
- Workspace host forks concurrently with the PTY host (#8828)
- app:boot IPC overlaps the first render via React `use()` (#8820)
- Four background service inits deferred and the DB-maintenance probe made lazy (#8817)

**Build**

- Package sideEffects declared to activate lazyBarrel (#8819)
- domMax chunk genuinely deferred via $initial-scoped vendor-motion split (#8821)

### Other Changes

- Worktree sidebar no longer shows a redundant 'dirty' label (#8868)
- `.antigravitycli` directory now ignored

## [0.12.1] - 2026-05-22

Patch release closing six issues found in 0.12.0 — the file diff viewer always failed to load, the workspace sidebar hung when a project folder was missing, and the Daintree Assistant silently dropped an unsupported saved agent preference. Also lands faster panel closing plus fleet-scope and picker-footer polish.

### Bug Fixes

- Daintree Assistant now explains when a saved preferred agent is unavailable instead of silently falling back to none (#8775)
- File diff viewer no longer fails with "Failed to load diff" (#8800)
- Workspace sidebar no longer hangs when a project folder no longer exists (#8796)
- Fleet broadcast no longer auto-enters fleet scope on raw input (#8797)
- Decluttered the footer in the cold-start arm-terminals picker (#8802)
- Removed the accent color from the sidebar arm-matching button
- Grid terminals now fit synchronously to avoid a layout flash on open

### Performance

- Closing a grid panel now feels instant — the panel hides immediately while teardown runs deferred and coalesced
- Chunked the terminal resize pass to prevent a renderer freeze when closing panels with Cmd+W

## [0.12.0] - 2026-05-21

A large release centered on cold-start and memory — the boot path was instrumented end to end and trimmed, and the memory-pressure mitigation ladder is now closed-loop. Fleet broadcast, crash recovery, and the worktree sidebar were each substantially reworked; forge integration was generalized off GitHub into a provider model, and the MCP server gained audit tooling and abuse caps.

### Features

**Forge & plugins**

- Forge provider model — remote-URL routing selects the active provider, with global default and per-project override settings (#8057, #8110, #8111, #8112)
- Plugins can register forge providers and contribute per-file forge badges via a file-decoration API (#8058, #8511)
- Unified Code Forge settings tab replaces the separate GitHub and Forge tabs, with real per-provider settings and auth surfaces (#8329, #8330, #8454, #8525)
- Preferences gained a Forge Integrations section (#8064)
- Commit-author avatars now resolve through a forge-agnostic provider system (#8514)

**Fleet broadcast**

- Per-target edit and skip in the broadcast popover (#8691)
- Fuzzy matching replaces substring/regex in the fleet picker (#8695)
- Cold-start fleet picker can toggle replace vs append (#8694)
- Broadcasts confirm on the resolved fan-out rather than the source draft (#8689)
- Saved fleets split into Pinned and Smart-Sets sections, with frecency ranking (#8692, #8693)
- Fleet preset menu items show armed panel count and dim unmatched panes on hover (#8688, #8696)

**Worktree sidebar & overview**

- Virtualized worktree sidebar with keyboard-accessible windowing (#8393)
- Worktree rows show blocking git states, dirty status, last commit author and time, base-branch divergence, and fetch staleness (#8380, #8381, #8382, #8483, #8484, #8485)
- Row badges are ordered by salience and surface alarms when the sidebar is collapsed (#8379, #8763)
- Worktrees overview gained multi-select, keyboard navigation, clickable aggregate stats, and bulk close/remove (#8385, #8653, #8655, #8766)
- Worktree filter chip counts switched to disjunctive faceting (#8390)
- Placeholder card renders while a worktree is being created; delete progress shows on the card (#8414, #8417)
- Sidebar surfaces filter scope, drag-disabled reasons, and a disabled drag handle when reorder is unavailable (#8391, #8395)
- Worktree lifecycle failures are now recoverable from the card (#8401)

**Terminal**

- Terminal search gained an overview ruler, regex error surface, whole-word toggle, and search history recall (#8532, #8539)
- Hibernated terminals are surfaced in pane chrome with a new Sleep action; hibernation is idle-aware and memory-pressure adaptive (#8534, #8536)
- Double-click a panel title to maximize it (#8707)
- Last-active panel per worktree is prioritized on restore (#8703)
- Terminal dock actions are exposed to the Daintree Assistant (#8594)

**Dev preview**

- Dev preview toolbar reaches parity with the browser pane — screenshot, devtools, console capture, rotation, DPR, and zoom-to-fit (#8262, #8268, #8279)
- Viewport presets use full device emulation instead of a user-agent swap (#8278)
- Staged stuck-start UX replaces silent auto-restart, with tiered restart vocabulary and an explicit Stop control (#8275, #8276, #8277)
- Empty state shows detection preview and a runner picker; blocked-navigation banner was rebuilt (#8263, #8267)
- Broader run-command detection with Procfile/mise.toml support and pre-launch port extraction (#8266)

**MCP server & assistant**

- MCP audit settings with filters, search, NDJSON export, and latency SLO bands (#8437)
- Audit records correlate to assistant turns; a turn-outcome diagnostics view and in-process anomaly detector surface operator signals (#8430, #8433, #8438)
- Progressive tool disclosure in the MCP manifest (#8459)
- Time-bounded per-tool grants replace sticky tier elevation, with an abuse cap on repeated auth failures (#8442, #8467)
- HybridInputBar is wired into the Daintree Assistant (#8185)
- Runaway-loop protection rate-limits the CallTool path (#8468)

**Crash recovery & safe mode**

- Crash recovery defaults to silent restore with a clearer opt-in (#8677)
- Safe mode quarantines repeat-suspect panels instead of dropping all panels; suspect panels are surfaced more visibly (#8679, #8704)
- Watchdog-disabled state now shows a recovery banner (#8674)

**Toolbar & dock**

- Right-click "Unpin from toolbar" works across all live toolbar buttons; plugin buttons render as hideable rows in settings (#8182, #8183)
- Keyboard navigation added to the dock chip rail (#8170)
- Voice recording stays pinned out of toolbar overflow while actively recording (#8158)
- "Copy path" surfaces in the modal and toolbar project pickers (#8222)

**Settings**

- Settings tab content prefetches on hover/focus (#8760)
- Cross-scope settings search merged with a per-row scope chip (#8235)
- Unified override-vs-inherit UI across project-settings tabs (#8238)
- Default worktree recipe selector moved onto the Recipes tab as a per-row pin (#8233)

**Other**

- Cross-project shortcut to focus the next waiting agent (#8418)
- Destructive confirms wired across terminal, session, and remaining direct-IPC bypass sites (#8242, #8245)
- No-worktree main-canvas empty state was reworked (#8645)

### Bug Fixes

**Fleet broadcast**

- Progress counter no longer hidden for small fleets; counter is duration-gated (#8686)
- Cancel announcement now includes the skipped count (#8687)
- Targets no longer left armed on ENOTCONN/ENXIO/EINVAL; dead PTYs auto-disarm on structured broadcast (#8690, #8706)
- Retry no longer fires empty writes; partial failures surface inline (#8705)
- Raw broadcast no longer leaves a stuck directing state or writes to hidden cross-worktree terminals (#8255)

**Worktree**

- Worktrees no longer marked finished while an agent is still working (#8223)
- Phantom sidebar rows clear after an external worktree removal (#8510)
- External worktree removes are no longer swallowed by the topology suppress window (#8412)
- Watcher degradation now has a persistent indicator and recovery path (#8413)
- Worktree-load failures surface instead of triggering a partial switch rollback (#8400)
- Teardown phase status is no longer overwritten when the next phase starts (#8406)
- "All caught up" no longer shown for empty worktree filters (#8650, #8745)
- Clone-into-project flow tightened, with a GitHub-aware recovery action on auth failure (#8408, #8411)
- Sidebar zero-result empty states now have a path back to the overview (#8383)
- In-flight worktree delete mutations recover across host crashes (#8405)

**Terminal**

- Focus no longer jumps from xterm back to the hybrid input on agent panes (#8487)
- Unfocused terminal panes no longer swallow shift+click or leak drag events (#8531)
- Scrollback restore failures surface as an inline warning instead of failing silently (#8535)
- Visible terminals fully refresh on project switch-back (#8562)
- Stale panel chrome from memo comparator drift fixed (#8588)
- Per-pane terminal banners are suppressed while the PTY host is down (#8676)
- Agent state detection no longer depends on terminal panel size (#8701)
- Panel grid no longer shrinks agent terminals below a usable size (#8702)
- ResourceGovernor no longer flaps between pause and force-resume under load (#8616)

**Crash recovery & safe mode**

- GPU crash monitor hardened against no-op restarts and non-atomic flag writes (#8671)
- Main-process watchdog hardened against false-positive SIGKILLs and slow-leak crash loops (#8672)
- Slow-flap blind spot closed in the crash-loop guard decay window (#8683)
- Corrupt crash-loop state is quarantined and stale temp files are swept (#8684)
- Global recovery banners coordinate with stacked precedence (#8678)
- GPU ANGLE fallback state now has a UI signal (#8673)
- Emergency recovery reset and crash-recovery reset are gated behind a confirm with preview (#8675, #8697)
- SafeModeBanner restart elevated to a destructive confirm with a View logs action (#8685)

**Dev preview**

- Dev preview joins project URL history and preserves its route on restart (#8273)
- render-process-gone and unresponsive states surface as inline banners (#8270)
- Scroll position is preserved when eviction follows a freeze (#8281)

**Cold-start & windows**

- Cold project switch no longer flashes on paint-gate timeout (#8606)
- Background throttling now applies to cached project views (#8599)
- Primary window tracks the active window rather than registration order (#8600)
- Global services stay alive across last-window-close, closing a re-init race (#8604)
- ResourceProfileService memory controls reach every window (#8605)
- Event-loop-lag detector no longer gets stuck in efficiency mode (#8615)

**MCP server & assistant**

- Daintree Assistant agent can be switched while a Codex session is bound (#8353)
- Codex assistant no longer tells users to switch to Claude despite having Daintree MCP wired (#8354)
- MCP dispatch no longer ignores the contextOverride field (#8317)
- MCP dedup no longer returns a cached result when a requestKey collides with new args (#8429)
- MCP session idle timer survives laptop suspend/resume (#8466)
- Help-session MCP dispatch no longer silently targets the wrong worktree (#8432)
- Daintree Assistant allowlist broadened for forge CLI commands (#8360)

**UI & toolbar**

- Toolbar roving-tabindex fixed under overflow and portal menus (#8163)
- Toolbar overflow no longer oscillates at boundary item widths (#8157)
- Dock shadow now visible on light themes (#8156)
- Dock popover stays open while typing into the agent input (#8368)
- Warm-cache flash on the Avatar and ProjectSwitcher trigger eliminated (#8244)
- Dismiss button no longer floats mid-banner in the panel-count warning (#8291)
- Open-in-grid button no longer overlaps the status indicator in docked agent panels (#8359)
- Non-launchable agents no longer dead-end in the dock launch menu (#8155)
- Attach Issue picker no longer shows stale or mislabeled search results (#8647)
- Project switcher MRU ordering targets the correct project (#8561)

**Settings & infrastructure**

- Env var editor no longer describes plaintext storage as "securely stored" (#8234)
- Invalid worktree path pattern no longer aborts auto-save of unrelated fields (#8236)
- Workspace host no longer respawns forever in a crash-ready loop (#8553)
- Worktree MessagePort transport hardened against silent failures (#8551)
- GitOperationError metadata is preserved across the contextBridge boundary (#8567)

### Performance

**Cold-start & memory**

- Cold-start IPC fan-out collapsed into a single batched boot invoke (#8620)
- Independent hydration steps run concurrently to cut serial IPC round-trips (#8619)
- Two blocking steps trimmed from the cold-start critical path (#8622)
- Synchronous shell spawn no longer blocks main-process startup (#8625)
- First React render no longer blocked by Sentry initialization (#8632)
- ActionService defers JSON Schema compilation to first use instead of compiling all schemas at cold start (#8614)
- app:// handler sends caching headers so the V8 code cache persists across launches (#8624)
- Renderer first-render import closure trimmed and the monolithic App.tsx chunk split (#8626, #8627)
- ProcessMemoryMonitor pressure thresholds scale with device RAM (#8633)
- Memory-pressure mitigation ladder is now closed-loop (#8634)

**Project views**

- Project-view eviction switched to pure LRU, targeting the least-used renderer (#8602)
- Efficiency profile no longer discards cached views without memory pressure (#8603)

**Rendering & multi-agent load**

- Agent-status and panel-store writes batched into one write per frame (#8589, #8592)
- GridPanel restructured to id-based store subscriptions; useContentGridContext subscription narrowed to stop per-agent re-renders (#8591, #8593)
- Panel grid resize batches reflows one frame at a time (#8597)
- Terminal refresh-tier classification is now fleet-aware (#8596)
- Agent terminals no longer flash when 20+ are visible (#8378)
- Renderer stops writing to xterm after a panel backgrounds (#8365)
- WebGL context cap and resource-profile ceilings raised; the circuit breaker coalesces memory-pressure context-loss bursts (#8540, #8541)
- ResourceProfileService reacts to many-agent fleet load (#8623)
- Per-row sidebar subscriptions stop full-list re-renders on each poll (#8389)

**Forge & git**

- PR detection batches lookups via a forge findPRsByBranches capability (#8384)
- Idle git-status cost cut in WorktreeMonitor (#8396)
- GitHub rate-limit throttling is now adaptive and budget-aware; wasteful polling in stats and health queries was cut (#8756, #8757)
- PortBatcher no longer allocates a fresh buffer on every flush (#8367)

## [0.11.1] - 2026-05-17

Stability follow-up to v0.11.0. Walks back two terminal rendering regressions, refreshes project stats on trash and restore without waiting for the 5s poll, and lets the Daintree Assistant resume across project-view LRU eviction. The release pipeline also splits into three independent per-OS workflows.

### Features

- Daintree Assistant survives project-view LRU eviction via PendingHelpHibernationStore — agent resume tokens are flushed before revocation and reclaimed on next open

### Bug Fixes

- Restore VISIBLE-tier WebGL eligibility for agent panes — fixes warped block / box-drawing glyphs (U+2584 and friends) on unfocused tiled fleet panes, walking back the focused-only mitigation
- Revert the 32 KiB terminal write slicer — restores correct backpressure ACK accounting and in-order writes (the slicer's batch fan-out broke `acknowledgePortData`)
- ProjectStatsService subscribes to `terminal:trashed` and `terminal:restored` so stats recompute on the next debounce window instead of waiting up to 5s
- Replace the Eclipse icon with Moon in BackgroundContainer

### Other Changes

- Release pipeline split into three per-OS workflows (release-macos.yml, release-linux.yml, release-windows.yml) — each OS publishes independently the moment its own pipeline goes green (#8052)
- Full-\* E2E buckets shard 4-way to cut serial Windows wall-time from ~39min to ~10min (#8053)
- Drop screenshot rendering from gating CI (#8054)
- Windows smoke timeouts and per-run retry support
- E2E concurrency scoped per platform so the per-OS release workflows don't cancel each other
- Poll-guard the duplicate-tab assertion in `core-terminal-panels` to stabilise it under shard 2/4 timing
- Remove dead ProjectMruSwitcherOverlay component

## [0.11.0] - 2026-05-16

Windows reaches feature parity with macOS and Linux — NSIS and Store builds, native menu/keybinding gaps closed, UTF-8 in fallback shells, agent command-launch parity. Alongside the Windows push: a deeper resilience pass on pty-host, watchers, and crash recovery; destructive-action confirms widened to every remote push; the banner family converges on shared chrome; and another EmptyState / skeleton sweep removes the last full-area Spinners.

### Features

**Windows**

- Non-Store NSIS installer with arm64 support (#7942)
- In-app update notification for Windows Store builds (#7980)
- Native application menu gaps closed (#7939)
- Ctrl+F4 close-tab and Menu key context-menu shortcuts (#7943)
- Agent command-launch parity with POSIX (#7945)
- Dedicated scratch folder for the Daintree Assistant (#7947)

**Sidebar & drag/drop**

- Sortable sidebar row directional drop indicator and Alt+Arrow keyboard reorder (#7972)
- canScroll and per-surface ARIA announcements on nested DndContexts (#8016)
- Alt+Arrow worktree-name announcement and debounce for screen readers (#8013)
- Snap-back motion on Escape-cancelled drags (#8019)
- Trash hint repetition capped, popover flipped to LIFO (#7977)
- Complete drop-armed visual on dock receptacles (#7978)

**Destructive actions**

- Commit-and-push confirm gate widened to every remote push (#8025)
- Missing D1–D3 confirm dialogs wired across UI surfaces (#8023)
- MCP rotate confirm tightened — rotate gate, severity, label (#8028)
- Confirm dialog before worktree.restartService (#7909)

**Banner family**

- Seven banners converged on shared InlineStatusBanner chrome (#8026)
- Extended severity, fixed duration drift (#7974)
- Verb and icon drift fixed across Terminal banners (#7975)
- Banner-swap height transitions smoothed to stop xterm jitter (#7976)

**Panels & navigation**

- Review registered as the fourth built-in panel kind (#7792)
- Project switcher cross-view gate, numpad/shift+= support, directional MRU fix
- Departing project lastOpened bumped for Alt+Tab MRU toggle
- Dock density submenu surfaced in dock context menu (#7979)

**Notifications**

- Bell-blip throttle and divergent thread previews (#7967)

**Voice & Assistant**

- Microphone input device selector (#7902)

**Keybindings**

- Cmd/Ctrl shortcut collisions and AltGr swallowing resolved on Windows (#7941)

### Bug Fixes

**Terminal & PTY**

- Working non-agent terminals stay streaming when unfocused (#7997)
- Visible terminals wake on project view activation and worktree switch (#7999)
- Restarting banner shown during pty-host auto-restart backoff (#7905)
- Time-windowed crash-loop guard ported to pty-host (#7904)
- ResourceGovernor surfaces flowStatus, warning band, triage, and profile awareness (#7910)
- chcp banner suppressed with `>/dev/null` redirect
- UTF-8 forced in Windows fallback shells (#7949)
- chcp / fallback-shell mojibake on Windows resolved (#7949)

**Windows platform**

- Caption-button space reserved in toolbar and pre-React skeleton (#7951)
- ms-windows-store: protocol allowlisted in openExternal
- Build-type detection no longer treats every Windows build as Store (#7940)
- WSL default distro identified by `*` marker, not list order (#7944)
- Path normalizer treats UNC share as unescapable root (#7948)
- Worktree-id inference normalizes mixed path separators (#7950)
- Windows update metadata written to `<prefix>.yml` (no `-win` suffix)

**Crash recovery & resilience**

- Lazy overlay surfaces wrapped in ErrorBoundary, preventing fullscreen crash escalation (#7906)
- Backup triggers wired into appState mutations and window blur (#7903)
- focusPanelState clearing handled, partial-write resilience added (#7903)
- Silent auto-restore surfaced via inline confirmation banner (#7913)
- Watcher retry budget resets on refresh and wake (#7907)
- pty stability timer cancelled on crash to preserve the sliding window

**Errors & recovery**

- Infinite retry loop stopped; cross-session error recurrence tracked (#7908)
- Retry button flips to View errors after dock promotion; dedup keys normalized (#7914)
- Missing recovery action IDs registered for git error CTAs (#7915)
- IPC error classifier consolidated into a single-pass classifier (#7916)
- isTransient boolean replaced with a retryability discriminant (#7912)

**UI & EmptyState**

- Picker dialog and combobox empty states routed through EmptyState (#8022)
- Settings tabs keep section chrome visible during loading; empties routed through EmptyState (#8021)
- Diagnostics dock empty states routed through canonical EmptyState (#8015)
- ReviewHub completed states routed through user-cleared EmptyState (#8020)
- Fleet picker popovers use canonical EmptyState (#8018)
- Last full-area Spinners replaced with shape-faithful skeletons (#8014)
- Scroll-shadow gradient, fade transitions, and scrollbar thumb minimum polished (#8010)
- Tooltip primitive defaults polished, focus-visible filter added (#8008)
- Shared ScrollPill chrome extracted (#8011)
- Tooltip root remounts on visibility flip to clear stale Radix state
- DRAG_GHOST_OPACITY threaded through outlier drag-source dim sites (#8017)
- Whitespace-only sortable labels treated as missing with fallback coverage
- Empty issue-search input trimmed before API query
- Render-phase side effects moved into useEffect

**GitHub**

- prCiStatus drift between dropdown and sidebar resolved (#8006)
- Stranded tooltips in keepMounted dropdowns cleaned up (#8001)
- AnimatePresence replaced with plain conditional render in keepMounted dropdowns
- Bulk-bar pointer-events and post-completion dismiss cleanup

**Worktree & search**

- Search bar clearing hardened against debounce race and focus loss (#7970)
- Sidebar search clearing aligned with ARIA APG combobox pattern (#7970)
- Restart confirm dialog state resets when the error clears
- Blue chip and slate circle used for finished worktree card state (#7925)
- Combined-axis empty state copy clarified; active-count contrast lifted

**Project switcher**

- Waiting state described instead of asserting review needed (#8002)
- Dead 'open in background' affordance removed (#8027)
- MRU switcher simplified to immediate-switch model

**Sidebar accessibility**

- Alt+Arrow reorder blocked when grouped or searching
- List/grid keyboard contracts aligned with WAI-ARIA APG (#8012)
- Tablist arrow nav bails out for non-tab focus anchors

**Dock & layout**

- Populated trash pill armed state gated on panel drag
- Persisted dockDensity validated in v8 preferences migration
- Trashed-items type assertion replaced with a type predicate

**Agent panel & MCP**

- Title edit input feels inline (#7926)
- Double-confirm guard added; rotate disabled without suffix

**Voice**

- System-default microphone uses a sentinel value
- Type errors and lint warnings resolved across voice surfaces

### Performance

- Idle relative-time labels no longer wake every second (#8009)

### Other Changes

- Notify() tier tightened on six audited surfaces (#8024)
- Settings tab section titles converted to sentence case (#7968)
- Notify timers cancelled on remove and context switch
- Renderer path-string handling unified onto a shared utility (#7946)
- Shared prCIStatus utility extracted; CI indicators aligned
- projectMru moved to shared/utils
- CI: job-level e2e retry with `--last-failed` scoping (#7952)
- CI: shared retry gate centralized in one step
- CI: release dry-run workflow stabilised

## [0.10.2] - 2026-05-14

Patch release: stability and polish updates addressing WebGL terminal rendering, voice transcription, and UI sizing.

### Bug Fixes

- Resolved WebGL glyph corruption that occurred during atlas merge and agent terminal switching
- Fixed voice transcription flow to align with the `?intent=transcription` protocol
- Corrected dock terminal focus outline positioning to stay within item bounds

### Style & UI

- Bumped filter bar icon and label sizes in worktree view for better visual hierarchy
- Tightened overall icon and filter bar sizing across the UI

### Other Changes

- Lifted GitHub issue selection into a keyed Zustand store for improved performance
- Updated agent skill configuration (renamed fix-release-nightly to fix-workflow)

## [0.10.1] - 2026-05-14

Patch release: a whole-passage AI cleanup pass for voice dictation, plus fixes for terminal split layout, WebGL atlas rendering, and worktree filter bar tooltips.

### Features

- Voice dictation runs a whole-passage AI correction pass when recording stops, cleaning up the full dictated text in one shot; the corrected range shows a pending decoration while the pass runs

### Bug Fixes

- Two-pane terminal split now uses CSS grid fr tracks, fixing layout breakage when the container width is zero on first paint or stale during sidebar transitions
- WebGL texture atlas resyncs after page merges, clearing the stale GPU texture cache that could leave terminal glyphs corrupted
- Worktree filter bar tooltips migrated to Radix for consistent cross-browser styling
- Terminal drag ghost is centered on the preview width so it tracks the cursor correctly
- Whole-passage voice correction IPC is now validated

### Other Changes

- QuickStateFilterBar compacted to icon + count segments; arm-matching affordance moved into the filter bar's trailing slot
- Removed an orphaned split-button component, fixing the nightly knip job (#7899)

## [0.10.0] - 2026-05-14

Major release centered on the new Review Hub for staging, diffing, and pushing worktree changes, alongside the voice-backend migration to OpenAI Realtime and a broad pass of worktree, settings, and UI polish.

### Breaking Changes

- **Voice transcription backend switched from Deepgram to OpenAI Realtime API.** The voice subsystem now connects to `wss://api.openai.com/v1/realtime` and uses the `input_audio_transcription` event family (`delta` / `completed`) for streaming results. Spoken dictation commands ("new paragraph", "period", etc.) are reproduced in post-processing via `applyDictationCommands` since the Realtime API has no native equivalent.
- **API key settings unified into a single `openaiApiKey`.** The separate `deepgramApiKey` and `correctionApiKey` fields have been removed. Settings are auto-migrated the first time Voice settings are read after upgrade: existing `correctionApiKey` or `apiKey` values beginning with `sk-` move into `openaiApiKey`; `deepgramApiKey` is dropped. Users who only had a Deepgram key configured need to add an OpenAI API key in Settings → Voice for transcription to resume.

### Features

**Review Hub**

- Commit composer dialog gates commit & push so the message is reviewed before it ships (#7880)
- Multi-select for partial-set staging (#7790); keyboard hunk nav, per-file Viewed marks, persisted view type
- Inline divergence recovery for non-fast-forward push rejections
- ConflictPanel rebuilt into operation-chrome, worklist, and Continue regions (#7791)
- Section header filter / sort / view options; body-line ruler, multi-line overflow, commit history recall
- File-row chrome — split clicks, churn summary, generated-diff dimming, unresolved review-comment count
- PR chip split into read-only status pill + external-link button; PR CI status surfaced on worktree cards and Review Hub chip
- Streaming push progress; target branch shown in Review Hub
- Inline review strip and zero-change pill on agent panes
- Consolidated worktree-card commit surfaces into the Review Hub (#7886)

**Worktree**

- QuickStateFilterBar with state icons and spinning indicator
- WorktreeDeleteDialog body replaced with a static consequence list (#7847)
- Generated diffs collapse by default in DiffViewer
- Refractor chunk-load failures surfaced in diff viewer
- Sessions submenu adds Close All / Terminate All
- Freshness indicators on PR + Issue badges; focus-driven sub-line on collapsed rows

**Voice**

- Replaced Deepgram client with OpenAI Realtime WS
- Dictation-command post-processor for the OpenAI realtime path

**Daintree Assistant**

- Cmd+L default keybinding with three-state toggle and terminal-first focus (#7842)
- Gemini CLI and GitHub Copilot CLI wired into Daintree Assistant MCP

**Notifications**

- Completed-with-changes agents routed to review inbox

**Performance / Resource handling**

- Project switching: hover prefetch + visible swap decoupled from data hydration (#7660)
- Cached project views evicted under low system memory; frozen under efficiency profile
- `@parcel/watcher` adopted to eliminate macOS EMFILE in worktree watching
- PTY throughput-rate gauge added to reliability metrics

**UI / UX**

- ConfirmDialog hardened against destructive-confirmation drift (#7846)
- EmptyState contract — scale discriminant + container-query density (#7844)
- In-progress rebase shown as a commit sequence in the conflict UI
- Inline keyboard shortcut assignment for agents in Settings
- Split Commit / Commit & Push buttons on the commit composer footer
- Toolbar tri-state pinned with availability-aware visibility (#7673)
- RadioTower broadcast indicator on agent panel titles
- Fleet-picker footer adds visible Select all / Select agents buttons

**Security / Internals**

- secretScrubber: 15 new vendor patterns from the gitleaks catalog
- Renderer import discipline codified as a lint rule (#7659)

**Marketing**

- 3-OS marketing screenshots pipeline for Microsoft Store

### Bug Fixes

**PTY / Terminal**

- PtyPool crash-loop and FD leak on fast-exit shells; per-key circuit breaker + `destroy()` on pooled PTYs (#7892)
- Backgrounded terminal grid coherence preserved at wake-time resize (#7741)
- Suppressed wheel→arrow translation inside agent alt-screen TUIs
- Guarded against truncated session-ID captures in graceful shutdown
- Copilot `/exit` shutdown: single-write `quitSubmitMode`; 200ms `submitEnterDelayMs` to fix Ink TUI input drop

**Worktree / Git**

- Push-retry and diff race in commit composer
- `isPushing` deadlock; target branch re-emitted after auto-retry
- `git push` lock scoped per-cwd to prevent silent concurrent no-op
- Sidebar auto-reconciles after external worktree deletion
- Degraded-state visuals on GitHub badges (#7697)
- Filter chip counts aligned with visible list and arm payload
- Search-bar X visibility subscribed to facet-filter state

**Settings / UI**

- Section chrome renders instantly instead of full-area Spinner (#7851)
- Mutation affordances guarded during loading; load races fixed
- IssueSelector typeahead spatial anchor preserved (#7852)
- Getting Started checklist no longer auto-exits on completion (#7850); dismiss vs collapse distinguished (#7849)
- animate-pulse-immediate flash under 200ms on warm cache gated (#7853)
- ActionPalette empty / warm-start states polished (#7843)
- NotificationCenter inbox chrome and Undo toast polish (#7854); per-row reveal on mouse + keyboard (#7855)
- CopyableCommand contrast boosted; native title replaced with Tooltip (#7848)
- TwoPaneSplit: container width recovered on drag-end after locked unlock; ResizeObserver gated behind sidebar transition lock
- File viewer Cmd+L go-to-line preserved while modal open

**Agent / Fleet**

- Fleet directing-state broadcast (#7799); enter directing via `notifyUserInput` before submit
- `fleetBroadcastConfirmStore`: function removed from Zustand state; full clear on "Deselect all" so drifted IDs don't survive
- Agent `supports` field added to `UserAgentConfigSchema`; `isEffectivelyRegisteredAgent` hardened
- Agent launch description shortened to fit 120-char metadata limit
- `panelKindHasPty` restored for `hasPty` checks

**Boot / Project switching**

- Pre-agent snapshot pruning deferred to deferred task queue (#7656)
- `previousEntry` undefined → null coalesced; paint gate review-findings addressed
- Resource profile: low-memory threshold pushed on start so balanced is armed at launch

**Diff / Review Hub**

- Stale-request races, retry loading state, type guard
- Empty parse results from `parseDiff` guarded
- Selection anchor reseated when original is evicted
- Push-failure banner wired to recovery hints with collapsible details
- Rebase current-step detection corrected (git moves the failed pick to done)

**A11y / Forced-colors**

- `outline-none` replaced with `outline-hidden` for forced-colors compatibility

### Performance

- CodeMirror language-data curated to shrink vendor-editor bundle
- Radix overlay primitives deferred off first-paint closure
- Stale `React.memo` wrappers retired (superseded by React Compiler)
- PortBatcher flush cadence scoped per-terminal (#7652)
- Settings: redundant `useCallback` wrappers retired

### Other Changes

- CI: release unit-tests now run on macOS, Linux, and Windows (#7895)
- CI: Windows added to release E2E core, online, and full gates
- ESLint warning baseline trimmed; renderer-import lint rule landed (#7659)
- Documentation: README overhaul with new hero, vision doc extraction, daintree.org install links

---

## [0.9.1] - 2026-05-10

Same-day follow-up to 0.9.0. Polish on the Daintree Assistant pip and help panel, GitHub bulk-selection cleanup, and several PTY/terminal robustness fixes.

### Features

- **Assistant working/waiting state** — Toolbar pip and panel header now reflect live agent state (working / waiting), not just connected/idle (#7630)
- **Help-panel first-launch links** — Replaced seed-prompt chips with assistant-settings and docs links; added title-bar help icon (#7628)
- **Mark-as-read on assistant pip** — Pip dims after the assistant button is opened, no longer nags after the agent has been seen
- **Promoted assistant action surface** — Terminal and agent operations are now first-class actions in the help-prompt restructure

### Bug Fixes

**Daintree Assistant / Toolbar**

- Fixed assistant pip positioning (icon now wrapped in a relative container)
- Reduced assistant button pip size and ring weight to stop it dominating the toolbar

**GitHub bulk selection** (#7644, #7645)

- Clear selection on dropdown/dialog dismissal; preserve across re-open within the same project; clear on project switch
- Disabled pointer events on the bulk-action bar's exit animation so the X button no longer feels dead
- Guarded `isOpen`-effect cleanup against double-fire

**Layout / drag** (#7627)

- Suppressed width transition during sidebar/assistant drag; restored parent transition if the sidebar unmounts mid-drag

**PTY / Terminal**

- Released pause token if the commit-side throws, preventing a backpressure leak (#7641)
- Raised IPC queue cap from 512 KB to 3 MB for agent bursts (Claude in particular) (#7640)
- Unified broadcast and scroll pills so they no longer overlap (#7636)
- Flipped fleet drafting-pill popover alignment to `start` for bottom-left anchors

### Other Changes

- CI: Manual workflow dispatch now supports Windows
- Refactor: replaced `hybridInputAutoFocus` with a session-wide focus preference
- E2E: stabilized full-terminal suite against palette overlay races

---

## [0.9.0] - 2026-05-09

### Features

**Daintree Assistant**

- Bundled help session with Claude, Gemini, and Codex backends
- Live version probe gates assistant launch when the CLI is too old (#7539)
- Tier picker splits skip-permissions into supervised tiers + explicit CLI bypass (#7532)
- Hibernation captures Claude resume code so idle assistants release agent slots
- Custom CLI args, drop in-panel agent picker, and "+ New session" header button
- Right-side push sidebar layout for the assistant pane
- Tier-mismatch banner, auto-snapshot indicator, and live working-state in the help panel
- Per-session MCP tokens with hash-gated provisioning and stale-token rejection
- Single-backend invariant per project; cross-agent token reuse is a hard fail (#7509, #7533)
- Replace operational empty state with intent-first hero
- Settings tab dedicated to assistant configuration

**MCP Server**

- Streamable HTTP transport at `/mcp` with SSE-path readiness probe
- Per-tier authorization enforced at dispatch time and per-project tier opt-in
- Audit log for every tool dispatch with latency rollup, tier hints, and 401 counter
- Idempotency dedup for creation tools with bounded memory
- New tools: `agent.getState`, `terminal.getStatus` (batched fleet polling), `triage_terminals` prompt
- Project edit actions, consolidated worktree creation tool with PR support
- Native confirmation modal for `danger:"confirm"` tool calls and elicitation/create migration
- Prompts capability with starter slash commands; Daintree state exposed as MCP resources
- Workflow macro tools, terminal close/kill actions, and waitingReason on terminal state
- Allowlisted focus, theme, and read-only settings actions; default cwd/worktreeId/projectId from active context
- `outputSchema` and `structuredContent` on tool responses; ToolAnnotations on exposed tools
- Curated allowlist shrinks the default tool surface; assistant turn outcomes recorded alongside tool calls
- Persistent api key dropped from electron-store with rotate action
- Daintree MCP exposed to per-project Claude Code agents
- Fleet-polling recipe lifted into the `triage_terminals` prompt
- 4-state runtime readiness API and supervised restart

**Fleet Broadcasting**

- `FleetPickerPalette` is the cold-start fleet entry point with keyboard navigation (#6471)
- Save and recall named fleets
- Smart-arm bar suggestion pill and additive filtered arming
- In-flight progress counter for large broadcasts
- `FleetDraftingPill` shows resolved per-target prompts
- Health, worktree scope, and a leading exit surfaced on the fleet bar
- "+ Add panes…" in-popover picker on `FleetCountChip`
- Selection discoverability shortcuts, lifted row-ref management, fixed tooltip binding
- Multi-cursor terminal selection refinements and broadcast lifecycle polish

**Notifications**

- Keyboard navigation in the inbox; muted-state empty state when inbox is empty
- Pin severe entries, group by context, and mark new since last looked
- Suppress toasts when the origin surface is on screen; transient flag for confirmation toasts
- Per-event-kind silence from toast and notification-center kebab
- Undo on bulk mark-read; dismiss entire thread on X click
- Day-boundary timestamp pivot with absolute fallback
- BellOff indicator on muted projects in sidebar and switcher
- Leading-edge unread dot; legibility polish on inbox open
- `GridNotificationBar` entry/exit animation; thread visualization polish
- Toast eviction surfaced via overflow pill and bell animation

**Onboarding**

- Welcome screen first-run polish with quieter completion empty states
- Getting Started checklist completion choreography (counter accent, confirmation beat)
- Cold-start skeleton with Doherty gate and stuck-state cue
- Removed post-creation project onboarding wizard (#6750)
- Quieter first-run empty states across sidebar and content grid
- First-run shortcut pedagogy with 500ms hold and biased tip rotation
- Silent privacy default confirmed; capture wizard step on abandon
- `AgentTrayButton` shows a labelled empty state when no agents are pinned

**GitHub Integration**

- ETag-based REST branch-to-PR discovery
- Toolbar pill counts hydrated from disk cache on cold start
- +N delta badge since dropdown last opened; rising-count digit flash (#6529)
- Per-bucket rate-limit details tooltip
- Pre-warmed PR tooltip cache from poll batch
- Focus-aware `PullRequestService` cadence
- Background git fetch for worktree ahead/behind counts; freshness on dashboard cards
- Skeleton-to-content crossfade in dropdown lists; status indicator microcopy

**Recipes & Scratch**

- Scratch entity for one-off agent tasks with 30-day auto-cleanup and save-as-project promotion (#6778)
- Partial spawn failure surfacing with retry banner
- Async lifecycle hazard handling in recipe runner banner
- Project-recipe empty-state copy and CTAs polish

**Resilience & Recovery**

- Global host-crash banner with recovery action
- Linux Wayland multi-GPU ANGLE/Vulkan fallback
- `GpuCrashMonitor` sliding-window crash counter and structured logger
- External main-process watchdog for deadlock recovery
- Concurrent-OOM and rejected-window-recreation handling; suppress `app.quit` during OOM recreate
- Persistence: `foreign_keys` pragma, `quick_check` upgrade, disk-space pre-flight, TOCTOU close (#7568)
- Schema-version header on `.restore` files
- `pendingErrors` cap unified across renderer and main paths
- Sentry `maxBreadcrumbs` raised to 250 in main and renderer
- `ErrorBoundary` `onReset` hook for upstream state invalidation

**Security**

- Trusted Types adopted in the Daintree renderer (#6397)
- IPC trust envelope size and arg-count gate; correlationId in error envelopes
- Secret scrubber covers Vercel, Perplexity, xAI, Together, Resend, Heroku, Telegram, and Datadog token shapes
- `process.env` suppressed in Node diagnostic reports
- Trust-boundary invariants documented in `csp.ts` and `trustedRenderer.ts`
- Cross-agent token reuse is a hard fail in spawn

**Auto-Updater**

- Lifecycle state surfaced in the application menu and last-checked timestamp in settings
- Retry on Electron `net::ERR_*` transient errors with permanent-wins precedence
- Blockmap files included in release artifacts and R2 upload (#7570)
- R2 binary reachability verified before publishing metadata (#7569)
- macOS notarization staple verified after build (#7574)
- Monotonic publish gate blocks `latest.yml` regressions (#7573)

**UI & Interaction Polish**

- Chord-pill tooltips rolled out to top chrome, panel header, dock, and stash
- Palette headers migrated to `KbdChord` pill rendering with `aria-keyshortcuts`
- Command palette dialog animates height when results filter; opt-in shell defaults for action label, empty-state chip, and no-match copy
- Pickup lift animation and cancel snap-back on drag overlay; `KeyboardSensor` wired through `DndProvider`
- Panel tabs use Priority+ overflow menu in place of chevron scroll (#6429)
- `ConfirmDialog` typed-name primitive for destructive confirmations
- Terminal close-confirm dialog replaced with undo toast
- Unicode 11 width tables for emoji and CJK rendering
- Browser toolbar polish (zoom, load-state visuals)
- Dev preview viewport presets refreshed for 2025-2026 devices
- Settings dialog tablist, primitives, and persistence polish
- Action palette: foreground emphasis match highlight, footer hint reflects selected row, "Recently used" empty state, async loading affordance
- Worktree per-chip match counts and quick-state-filter zero-result recovery
- Toast success-flash on action buttons; row-recency cue in `FileChangeList` (#6544)
- Trash-dock active tab title in group label; dock drop targets neutral ring + drag-to-trash + ghost pill
- View Transitions API smooths cold-start handoff
- Skeleton primitive shared; `SkeletonHint` companion for long-tail loads

**Accessibility**

- Sidebar one-tab-stop worktree list (#6422); ARIA tightened on worktree grid keyboard model
- ARIA semantics on logs and event inspector
- IME composition guard and ARIA improvements in palette shell
- WCAG 1.4.11 contrast on active `QuickStateFilterBar` pill
- Screen-reader noise reduction in theme browser and palette components
- `kbd` chips exposed via `aria-keyshortcuts`
- `AccessibilityAnnouncer` timer cleanup and identity tracking
- Reduced-motion support and ARIA attributes on Getting Started checklist
- Dev-preview viewport-preset radiogroup a11y with persisted last preset
- Diagnostics dock keyboard, ARIA, and resize behavior

### Performance

- Cold-start: CLS flush gap closed, LoAF aggregation hardened, four warn-only first-launch quality signals
- Spawn-blocking critical path tightened for agent launches; env-keyed pty pool serves agent terminal launches
- Lazy-loaded 24 modal, palette, and dialog hosts; `@xterm/addon-webgl` pulled off the eager critical path
- React compiler bailout reasons captured in report; `BrowserPane.tsx` bailouts cleared
- Panel store: per-row selectors scoped via worktree index; redundant `useShallow` removed
- Workspace host: watcher-driven cadence, watcher pipeline tuning (#7455)
- Terminal: cursor blink centralized and silenced in background panes; scrollback churn gated; coalesced writes sliced to 32 KiB
- Git: `GIT_OPTIONAL_LOCKS`, `--no-renames`, `safe.directory` write dedup, byte-by-byte null-scan replacement (#7041)
- Per-file diff insertion/deletion counts cached
- Boot: non-critical service init deferred; connectivity probes and token-health start deferred; ResourceProfileService import deferred to first-interactive
- Font: JetBrains Mono cold-paint loading optimized; refractor language pack deferred out of cold start
- Project switch: outgoing state save parallelized with SQLite operations
- File tree: `lstat` parallelized, `realpath` memoized, empty fields omitted
- Console: auto-collapse cursor tracked by tail id; render-path allocations cut
- Per-frame visible-cell snapshot skipped for plain terminals
- Resource profile: hysteresis tuned, max-lag diagnostics added; service intervals paused on system suspend
- LazyMotion provider consolidated with dynamic features (#6391)
- Palette filtering deferred via `useDeferredValue` (#6415)
- Theme: RAF-coalesced injection DOM writes; portal offsets moved to `documentElement`
- Pty host: per-terminal byte queue aligned with renderer watermarks (#7453)
- ProjectStore `getAllProjects` reconciliation batched in a transaction
- `useResizeObserverRaf` hook with four ResizeObserver callsites migrated
- Window-blur throttle extended to `DiskSpaceMonitor`, `ProcessMemoryMonitor`, `IdleTerminalNotificationService`, `PreAgentSnapshotService`
- Idle-window timer-pressure perf scenarios added (PERF-090, PERF-091)
- List-mount perf budget added to E2E core suite

### Bug Fixes

- 870+ targeted fixes across spawn, pty, terminal lifecycle, multi-window, project-switch race conditions, theme, palette, drag-and-drop, sidebar, settings, dialogs, recovery, MCP server, help session, fleet, notifications, browser, dev-preview, diagnostics, e2e harness, build, CI, and Windows-specific identity paths
- Notable: agent terminal blanks during bulk worktree creation; armed fleet panes kept visible; force GPU slot release on terminal destroy; Cmd+W focus to next panel; Windows agent identity preserved during PowerShell prompts; Claude welcome identity preserved on Windows; ctrl shortcuts matched on Windows; project switcher MRU cycle includes current project for cancel; webContentsRegistry listener leak fixed
- Pty host: `droppedBytes` forwarded through event routing; IPC fallback queue drops surfaced as terminal-status; pause tokens released on dispose (#7453)
- Workspace host: hysteresis preserved through `ensureState` and recovered on focus

### Other Changes

- Plugin system: panel-kind registry events on register/unregister
- IPC error envelope shape unified across MCP server paths
- E2E core: 31 fixed 35s CCR poll waits replaced with state-backed polling
- Build: `win-job-object` externalized and made cross-platform; `node-addon-api` knip silenced

---

## [0.8.0] - 2026-04-30

### Breaking Changes

- Plugin manifests now use a strict `permissions` enum; manifests with unknown permission values fail to load
- Notes panel removed entirely; existing notes data is no longer surfaced

### Features

**Fleet — Multi-Agent Broadcasting**

- Fleet Deck dockable tile grid with live terminal mirrors
- Scoped fleet mode (default) with armed-terminal filtering and grid pinning of the composer
- Broadcast bar with frosted surface, exit semantics, paste safety, and discoverable selection menu
- Live per-character broadcast and a dedicated broadcast composer for armed terminals
- Canary staged broadcast for large fan-outs and auto-exit on idle
- Fleet quick-action hotkeys (accept, reject, interrupt, restart, kill, trash) and `Cmd+J` arm-focused
- Saved scopes, action history, dry-run, retry-failed, and quorum confirmation
- Cluster attention pill for proactive nudges, drafting pill, and per-pane failure tracking
- Multi-cursor terminal selection with shift+click range select; arming dialog filters by recent terminal output
- Sidebar “Arm N matching” button via `armMatchingFilter`
- Broadcast eligibility extended to runtime-detected agents

**New Built-in Agents**

- Aider (#6131)
- Goose (#6132)
- Crush
- Qwen Code (#6134)
- Open Interpreter
- Mistral Vibe
- Kimi Code CLI
- Sourcegraph Amp
- Generalised registry schema with per-agent files (#6130)

**Agent System**

- Runtime-detected agent identity becomes a first-class panel field — drives chrome, focus nav, refresh tier, dock fade, trash fallback, orchestrator routing, fleet eligibility
- `unauthenticated` availability state for installed-but-not-signed-in CLIs (lets the CLI handle first-run auth itself)
- Capability ID sealed at PTY spawn from launch intent (#5804)
- Layered probing and `blocked` state for security-software interference (#5134)
- Decoupled CLI launch from credential sniffing
- Automatic fallback chain when a preset provider is unavailable
- Committable shared presets via `.daintree/presets`
- Per-worktree preset scoping
- Toolbar agent button: redesigned preset selection and launch menus, active preset surfaced
- Right-click context menu improvements on the agent button

**Plugin System**

- Manifest with permissions, runtime action registration, and host API/context injection
- `contributes.views` and `contributes.mcpServers` reserved
- Per-plugin unregister for contribution registries
- `engines.daintree` semver gating
- Scoped `publisher.name` plugin IDs required
- Read-only worktree state exposed to plugins
- Placeholder panel rendered when a plugin contributing a panel kind is unavailable

**GitHub**

- Instant dropdown opens via combined prefetch, eager chunk loading, and disk-persisted first-page cache
- `keepMounted` via React Activity for zero-latency re-opens
- Hover-prefetch on toolbar button
- Token-expiry detection with reconnect banner; high-priority notification on expiry
- Rate-limit-aware backoff using response headers; transient network retry
- Stale-data timestamp shown in inline error banner

**Performance**

- Optimistic panel commit decouples agent launch from PTY spawn
- Real cold-start scenario harness with A/B comparison (#5410)
- Renderer bundle size CI budget gate
- RAM-tiered cached project view defaults with LRU eviction; eviction telemetry on revival/cold-start
- FLIP panel motion on column-count changes; breakpoint hysteresis on auto grid columns
- WebGL context release when terminal goes off-screen
- Visibility-gated pollers and shared minute ticker for headers
- Migration-path latency regression gate (PERF-080)
- xterm `rescaleOverlappingGlyphs` and `reflowCursorLine` enabled
- Thermal and CPU speed-limit signals fed into ResourceProfileService
- GPU tile memory cap scaled by system RAM tier
- Knip dead-code analysis and expiring-TODO lint added to CI

**Settings**

- Radix-based primitives: Checkbox, Switch, native-select replacement
- Bordered env-var editor with `.env` paste flow and literal-secret warning
- Preset/default scope unified into a single editor; presets inherit from agent defaults with reset UI
- Hover preview in app theme picker
- Validation error indicators on settings tabs
- Tightened section boundaries on CLI Agents page
- Settings shortcut capture extracted as primitive
- Choicebox primitive extracted from DockDensityPicker

**Theme System**

- Theme browser panel with sticky hero and commit bar
- Semantic info-tone migration off accent token to `status-info`
- Bondi and Daintree theme tokens refined
- CSS color and hero-image validation on custom theme import
- Form-state semantic tokens for settings primitives

**Notifications**

- Quiet hours schedule
- Mute-from-toast for project notifications (#5401)
- Persistent banners replace transient toasts for cloud-sync and GitHub-token failures
- Same-entity toasts collapse instead of FIFO eviction
- DND state shown on toolbar bell; consolidated DND controls into a Pause popover
- “Clear all” moved into overflow menu

**Browser & Dev Preview**

- Favicons in URL bar and per-row history deletion
- Hard-reload action that bypasses HTTP cache
- Per-project approval for LAN, Docker, and TLD hosts
- Mobile and tablet viewport presets for dev preview
- Assigned URL and port registry in `DevPreviewSessionService`

**Onboarding**

- First-run welcome card and agent discovery badge (#5111)
- Setup wizard demoted to inline banner; visible section structure on its first step
- “Set Up Agents” footer item in agent tray
- Random emoji button and Enter-to-save on project onboarding

**Recovery & Resilience**

- Safe-mode banner with restart action and crash detail
- Crash-page copy varied by reason
- Diagnostics export and open-logs actions on the recovery screen
- Diagnostic bundle wrapped as zip with pre-save review step
- Quarantined project state surfaced via recovery notification
- Persistent transient errors escalated to user-visible toasts

**Terminal & PTY**

- Explicit PTY lifecycle state machine replacing implicit flags
- Scrollback repair and degraded-mode banner on runtime agent promotion
- Capability ID sealing at spawn from launch intent
- Command-launch pgid hardening and chrome-affinity tightening
- Linux copy-on-select and middle-click paste
- Match counter and highlight-all in the terminal find widget
- Preset args persisted and rehydrated through restart/resume
- Heartbeat RTT measurement with p50/p95/p99 logging

**Action Palette**

- Frecency-based MRU sorting replaces LRU
- Context-relevant action boost and keyword scoring
- Instant filter with origin-scaled entry animation
- `action.repeatLast` bound to `Cmd+Shift+.`
- Disabled-action reasons shown inline; toast on disabled-action dispatch

**Worktrees**

- WSL-mounted worktree detection — git routed through `wsl.exe`
- Linux inotify watch-limit degradation surfaced as a toast (#5229)
- Stale snapshot detection via heartbeat gap
- macOS EMFILE handling in the recursive worktree watcher
- Inline cleanup affordance on merged worktree cards
- Conditional tooltips for truncated paths and branch names
- Reviewhub surfaces merge/rebase/cherry-pick/revert conflicts
- Dubious-ownership git error gets an actionable toast

**Project**

- Fast MRU project switcher on `Cmd+Alt+−/=` (#5143)
- Auto-discover and offer to import context files
- Scope indicators on settings widgets

**Logs**

- Structured per-module log levels with named loggers
- Log rotation and previous-session log preservation
- Renderer console warnings and errors captured into the main log
- Log viewer polish — severity, tokens, tail, copy, dedup

**IPC**

- Typed handler migration across six batches; type-branded handler returns to forbid `{ok|success}` keys
- Typed event pub/sub foundation; channel-drift CI test
- `safeFireAndForget` wrapper for fire-and-forget IPC
- `AppError` class; rate limits on `github`, `files:search`, and `project:get-bulk-stats` handlers

**Security**

- CSP added to the `persist:daintree` session
- Secret scrubber catalog extended with 2026 vendor sigils
- Free-text secret scrubbing in telemetry and diagnostic bundles
- Outbound log and IPC error sinks scrubbed; IPC error envelope `userMessage` scrubbed
- Realpath containment in `daintree-file` protocol; symlinks resolved before containment check
- Sandboxed env vars and secret scrubbing in agent CLI probes

**Telemetry**

- Activation funnel instrumentation; newsletter checklist item replaced
- Sentry action breadcrumbs for crash triage
- Project state save/read latency and size telemetry
- Project-view eviction, revival, and cold-start events
- Outbound payload preview during a session
- `@sentry/electron` native minidump uploads disabled

**Animations**

- Structural micro-animations for spatial continuity across reflows
- Shared motion timing tiers and named constants in `animationUtils.ts`
- Component-level reduced-motion handling and continuous-loop dial-back (#5696)

**Accessibility**

- ARIA page landmarks for `F6` pane cycling (#5416)
- ARIA role corrections across panel layout

**Other Features**

- Empty states across recipes, MCP, GitHub, and agents — first-run, filtered, and cleared variants
- Reusable `EmptyState` component
- Held-modifier shortcut reveal in the toolbar
- Hover-based shortcut hints for unused actions
- Fuzzy search and chord prefix detection in shortcut reference dialog
- Inline unbind buttons for keybinding conflicts
- Per-agent launch keybinding model rethought
- Theme browser claims an overlay (hides Portal and blocks its toggle)
- Visual indicator for dangerous agent launch flags
- Demo runner replaces `capturePage` poll with `getDisplayMedia` + `MediaRecorder`
- CCR flavor system: shared types, IPC, store, registry merge helpers, picker UI, env-var hardening
- Persisted-store registry for diagnostics introspection
- Centralized boot migration pipeline; column probing replaced with drizzle migrations
- Boot-time WAL journal cap and `SQLITE_FULL` recovery wrapper
- Per-service connectivity awareness
- Resilient atomic write consolidation across all state writes
- Sound design — vary working pulse pitch to slow habituation
- Custom `BrandMark` icon wrapper for adaptive agent icon theming

### Bug Fixes

735 bug fixes across the categories above. Highlights:

- View-crash recovery: clear queued bytes, scope crash to active project, tear down ports, re-broker producer ports for cached-view reactivation
- Notify reentrancy guard, mute-confirmation priority, and fallback recovery actions
- Force-crash renderer instead of reload on unresponsive; clearer force-restart copy
- Files: `daintree-file` realpath containment; `..`-prefixed filenames allowed; close-error masking and POSIX-root edge cases addressed
- Crash-guard: state writes use `resilientAtomicWriteFileSync`
- Persistence: `withDiskRecovery` error matching tightened with coverage
- Disk-pressure: non-critical writers honour `writesSuppressed`
- Agent: waiting watchdog recovers from silently-dead subprocesses
- Workspace-host: scrubs secrets from recipe stdout before agent context injection
- Portal: `will-frame-navigate` gates subframe navigations; in-page navigations to non-`http(s)` schemes blocked
- Browser: localhost CSP overlay skipped for browser partition
- GitHub: clear stale rows when cache holds an empty page on Activity reveal; hover-prefetch race conditions closed; raw rollup fallback when no required checks
- Theme: hard-coded chromatic utilities replaced with semantic status tokens
- UI: residual accent uses demoted across dock, drag ghost ring, group badge, and AutomationTab create-recipe link
- Errors: silent `.catch` swallows replaced with logging and selective notifications
- Build: `tsc` typecheck output redirected away from esbuild bundle dir
- Memory: Blink memory unit corrected (KB not bytes); IPC validation hardened

### Other Changes

- Agent registry reordered by popularity; documentation updated to cover all 15 supported CLIs
- README and docs refreshed; `evaluate-feature` command removed
- Nightly CI gains an integration-test stage; PR/push CI tightened to Ubuntu-only smoke
- ESLint warning ratchet introduced for renderer hygiene rules
- Fix-with-test ratio tracking script added

---

## [0.7.1] - 2026-04-17

### Features

- Gate `--turbopack` injection on Next.js 15+ with a per-project settings toggle (#5154)
- Terminal Info dialog now shows spawn command, arguments, and agent metadata (#5169)
- Raise bulk worktree creation concurrency from 2 to 3 (#5163)
- Privacy & Data settings disclose the specific telemetry fields collected at each level (#5258)

### Bug Fixes

- Capture renderer-side errors via `@sentry/electron/renderer` so crashes reach Sentry (#5256)
- Consolidate telemetry consent into a single `privacy.*` store field, fixing stale-consent drift (#5257)
- Flush Sentry events before `app.exit` so queued crash reports are not lost (#5254)
- Stop dropping 90% of Sentry crash reports — sampleRate now fails closed (#5255)
- Generate the agent command when cloning a panel layout (#5179)
- Raise per-renderer tile memory cap and clean up GPU flag switches (#5180)
- Worktree cycle actions walk the sidebar-rendered order (#5170)
- Refresh sidebar immediately after saving a GitHub token (#5166)
- Suppress agent-tray tooltip from reappearing after its dropdown closes (#5153)
- Default-pin agents based on CLI install state instead of an opt-out list (#5158)
- Agent tray hides uninstalled agents and refreshes mid-session (#5157)
- Rebrand migration runs when an empty `daintree.db` is already present (#5156)

### Performance

- Eliminate bottlenecks in the worktree creation critical path (#5161)
- Batch pre-queries in the bulk worktree creation dialog (#5162)

### Other Changes

- Treat panel `worktreeId` as renderer-owned layout state (#5139)
- Update repo references from `canopyide/canopy` to `daintreehq/daintree`; add Canopy rename notice to README
- Release workflow gates publish jobs on unit tests and wires `SENTRY_DSN`

---

## [0.7.0] - 2026-04-16

### Features

**Daintree Rebrand**

- Rename Canopy to Daintree across types, icons, menu, and UI copy (#5149)
- Migrate userData and `.canopy` directory rename to `.daintree` (#5149)
- Flip protocol scheme app://canopy → app://daintree, canopy-file → daintree-file
- Rename `CANOPY_*` env vars to `DAINTREE_*` with back-compat shims
- Dual-variant release builds (Canopy + Daintree) via BUILD_VARIANT (#5151, #5130)

**Setup Wizard**

- Three-state CLI availability model: missing, installed, ready (#5057, #5043)
- Tiered agent list in setup wizard selection step (#5054, #5047)
- Replace embedded terminal with install cards (#5056, #5044)
- Animated step transitions with reduced-motion support (#5055, #5045)
- Auto-skip install step when all selected agents are installed (#5053, #5050)
- Fold system health check into agent selection step (#5060, #5046)
- Consolidate welcome step into agent setup wizard (#5061, #5048)
- Unify wizard and settings into shared agent card components (#5062, #5049)
- Skip-permissions toggle in agent CLI step (#5042, #5026)

**Theme System**

- Command palette and toggle for theme switching (#5081, #5069)
- Live preview on hover in theme pickers (#5088, #5068)
- Track recently used themes in picker (#5082, #5071)
- Accent color override for themes (#5095, #5074)
- Circular reveal animation for theme switches (#5087, #5073)
- Inline theme list with thumbnail previews replaces modal picker
- Updated theme hero images and tuned accent/terminal palettes

**Agents**

- Add GitHub Copilot CLI as built-in agent (#5067, #4555)
- Add Kiro CLI to README and improve auth detection (#5096, #5101, #5093)
- Agent tray button for unpinned and uninstalled agents (#5089, #5075)
- Default agents to pinned (opt-in toolbar) and rename selected to pinned (#5123, #5109)
- Active-session detection and focus shortcut on agent buttons
- Derive agent buttons dynamically from registry (#5078, #5070)
- Bulk operations can target specific agent terminals (#5086, #4772)

**Notes**

- Voice input in notes panel (#5063, #5059, #4425)

**Worktrees**

- Per-worktree remote compute lifecycle — lease, connect, manage cloud resources (#5007, #4426)
- Differentiate worktree card hover and selected states (#5077, #5065)

**Notifications**

- Notify user about idle terminals in background projects (#5083, #5064, #4745)

**Project Switching**

- Previous/next project shortcuts for fast MRU switching (#5142)

**Other Features**

- CONTRIBUTING.md for community contributors

### Bug Fixes

**Hydration & Persistence**

- Prefer saved worktreeId over stale backend value on rehydration (#5144)
- Preserve custom session names across project switches (#5105, #5103)
- Persist lastSelectedNoteId on save and harden notes save lifecycle (#5125, #5119)
- Apply same worktreeId precedence fix to reconnect path

**Workspace & Resources**

- Shell-escape substituted variables to prevent command injection (#5145, #5129)
- Serialize concurrent resource actions per worktree (#5147, #5127)
- Surface resource action failures to the user (#5146, #5128)
- Emit abort events and cleanup resource queues on dispose
- Exclude root worktree from PR branch-name matching (#5122, #5104)

**Multi-Window**

- Show project picker for user-triggered new windows (#5120, #5033, #5034)
- Resolve sender window for open dialog in multi-window (#5148)

**Terminal & PTY**

- Recover from xterm DOM renderer IntersectionObserver pause (#5092, #5085)
- Warm PTY pool at project cwd, skip on cwd mismatch (#5102, #5097, #5091)
- Replace sliding-window rate limit with leaky bucket for worktree creation (#5106, #5098)
- Cancel leaky bucket waiters on drain to match shutdown semantics

**UI**

- Stop FixedDropdown from self-closing on cold-start overlay race (#5090, #5084)
- Toggle thumb contrast on dark themes (#5099, #5094)
- Refresh LegacyMigrationBar design and copy
- Center migration bar layout and update rename messaging
- Hide worktree sidebar on welcome screen before project opens
- Increase notification panel opacity for legibility (#5051, #5040)
- Reload page when pressing Enter on unchanged URL (#5052, #5036)
- Hide uninstalled agents in System Status (#5079, #5072)
- Remove dedicated panel-palette toolbar button (#5121, #5116)
- Improve GitHub toolbar button UX when token not configured

**Cross-Platform**

- Cross-platform path handling in file stores and tree service
- Resolve Windows CI failures from path separator and shell quoting (#5152, #4708)

**Build & Release**

- Consolidate release output dir and harden nightly/update pipeline
- Preserve prerelease feeds and canopy-file links across rebrand
- GitHub Actions workflow to notify website on repo events

### Performance

- Adaptive backoff in ProcessTreeCache polling (#5124, #4818)

### Testing

- Adversarial test sweep — 22 rounds, 56 source bugs fixed across IPC, services, and stores (#5140)
- Repair nightly E2E onboarding and online agent flows (#5138)
- Propagate SKIP_FIRST_RUN_DIALOGS to sandboxed renderer (#5080, #5066)

---

## [0.6.0] - 2026-04-08

### Features

**Help System**

- Persistent HelpPanel with SearchSocket MCP for documentation search (#4939)
- Help agent dock button with agent picker and session continuity (#4938, #4937)
- Fast models used by default for help assistant (#4969)

**Project Switcher**

- Frecency-based project sorting with temporal sections (#4908, #4926)
- MRU ordering with second item pre-selected for quick toggle (#4989)
- Push-based project status replacing N+1 IPC polling (#4902)

**Panel Architecture**

- Unified PanelKindRegistry merging config, components, serializers, and defaults (#5002, #5003, #5004)
- Co-located panel kind modules into `src/panels/` directory (#5006)
- Renamed terminal store and types to panel (#5005)

**Per-View Worktree Stores**

- MessagePort broker with request/response protocol for per-view worktree data (#4834)
- Per-view worktree store replacing global store (#4862)
- Cached view rehydration and issue association hydration (#4862)

**Recipes**

- In-repo recipe storage with `.canopy/recipes/` as default for project-level recipes (#4936)
- Save-to-repo action for promoting user recipes to project storage (#4940)
- Support editing and deleting in-repo recipes (#4933)
- Custom CLI arguments per terminal in recipe editor (#4963)

**Demo System**

- Scene/Stage DSL with runner and capture pipeline for demo video production
- Scroll, drag, pressKey, spotlight, annotate, and waitForIdle primitives
- Raw BGRA bitmap piping with text-crisp encoding

**Other Features**

- Agent 'exited' state for cleanly terminated terminals (#4998, #4999)
- OAuth loopback flow for external auth redirects in dev preview (#4980)
- Git credential support for private repo operations (#4948)
- Per-agent assistant model selection in settings (#4962)
- Smart defaults for new worktree panel layout (#4993)
- Theme picker replaced with dedicated AppDialog modal (#4991)
- Existing branch mode in New Worktree dialog
- Terminal "Move to New Worktree" action for agent panels
- Cmd+T falls back to last-closed terminal config (#4717)
- Panel palette shows agent availability status (#4918)
- Clone Repository improved discoverability (#4884)
- Toolbar shows only installed agents with auto-open setup wizard (#4994)
- Include main worktree in bulk operations
- ScrollShadow component for scrollable containers
- Structural skeleton fallbacks replacing loading spinners
- Custom Canopy icon set additions
- Fullscreen state persisted and restored across sessions
- Blocked cross-origin navigations surfaced with Open in Browser action
- Standardized settings dialog layout and form components (#4883)
- Soundscape toned down to minimal defaults

### Bug Fixes

- Fix terminal blank panels on Linux/Windows from fit/resize race (#4913, #4935)
- Fix phantom agent terminals appearing on project open (#4911, #4881)
- Fix agent terminal getting stuck in working state (#4974)
- Fix dock state corruption on docked terminal expand and project switch (#4945)
- Fix project settings not persisting after dialog consolidation (#4958)
- Fix clone dialog hanging with cancellation support (#4949)
- Fix help terminal leaking into dock on project switch (#4978)
- Fix hybrid input bar drafts lost on project switch (#4977)
- Fix agent terminal panels not restored on cold app restart (#4973)
- Fix Windows voice correction path handling (#4979)
- Fix dev preview losing navigated URL on worktree/project switch (#5017)
- Fix palette not selecting first navigable item on open
- Fix tab group panels leaking between dock and grid
- Fix project switch losing active worktree selection (#5011)
- Fix project switch state capture and flush (#5009)
- Fix oversized window recovery regardless of visibility
- Fix menu DevTools and zoom items targeting wrong webContents
- Fix worktree delete dialog conflating untracked and uncommitted changes (#4927)
- Fix recipe editor dialog overflow scrolling (#4957)
- Fix terminal data loss and render freeze on project switch
- Fix stale draft restoring after submit and project switch (#4990)
- Fix dev preview auto-injecting --turbopack for Next.js (#4557)
- Fix Windows registry PATH expansion for tool discovery (#4932)

### Performance

- Startup performance capture pipeline with end-to-end timing (#4859)
- Lazy-load HybridInputBar for non-agent terminals (#4831)
- Lazy-load NewWorktreeDialog (#4835)
- Adaptive batching on MessagePort data path (#4899)
- Compile caching for UtilityProcess entry points (#4837)
- Throttle polling services when window is backgrounded (#4838)
- Bound coalesced terminal batch size to 256 KB (#4853)
- Normalize terminal store from array to Record for O(1) lookups (#4902)
- React Compiler switched to infer mode (#4836)
- Reduce scrollback multipliers to lower memory baseline
- Batch IPC broadcasts with 50ms flush window (#4834)
- Debounce MRU list persistence in store orchestrator (#4830)
- Singleflight cache for workspace state queries (#4832)
- Fire-and-forget recipe loading on initial hydration (#4852)
- Defer MessagePort ACK to xterm write callback (#4862)
- Pre-compute command queue count per terminal (#4833)
- Use replaceChildren() to clear hibernated terminal DOM (#4828)

---

## [0.5.3] - 2026-03-28

### Features

- Move notes storage from project directory to user data (#4399)
- Use first line of note content as display title instead of date-based default (#4397)
- Unify scroll indicator pill design across terminal and worktree sidebar (#4409)
- Disable text selection on app chrome for native feel (#4313)
- Add PtyPauseCoordinator for coordinated PTY flow control (#4384)
- Add Chromium GPU memory flags to reduce VRAM usage (#4365)
- Update logo to R5 design and rebrand to #36CE94
- Add Liquid Glass .icon bundle for macOS 26+

### Bug Fixes

- Fix EPIPE crash caused by console.log in CSP handler
- Fix notes losing content and disappearing after closing palette (#4396)
- Prevent loading flash during notes background revalidation (#4398)
- Fix notes debounced save flushing before auto-delete (#4396)
- Fix IME composition guard dropping Enter key after voice input (#4356)
- Fix grid arrow-key navigation using wrong column when moving up/down (#4297)
- Fix ReviewHub fatal git error when comparing same branch (#4352)
- Fix quit warning counting trashed agent panels as still running (#4350)
- Fix task assignment triggers dropped when orchestrator lock is held (#4366)
- Close SQLite connection explicitly during shutdown (#4354)
- Abort voice correction fetch on timeout via AbortSignal (#4359)
- Constrain dropdown and context menu height to available viewport space (#4239)
- Configure ImageAddon with memory-safe defaults (#4363)
- Revert privacy settings UI on IPC failure and show error toast (#4386)
- Add accessible names to GitHub settings token input and buttons (#4388)
- Add dialog accessibility to CrossWorktreeDiff modal (#4385)
- Suppress update error notifications for automatic checks (#4370)
- Add cursor-pointer to Button component and crash modal buttons (#4266)
- Clarify crash modal button and privacy warning text (#4264)
- Prevent dark-mode color-scheme inheritance into browser webview (#4351)
- Polish empty state spacing, recipe summary, and tip contrast (#4406)
- Fix agent state machine: add completed to waiting valid transitions (#4358)
- Suppress unhandled rejection in macOS editor open fallback (#4362)
- Add \_retried guard to getProjectHealth recursive call (#4353)
- Tone down hybrid input bar styling and fix bottom radius leak

### Performance

- Reduce V8 heap limits and remove --optimize-for-size (#4364)

---

## [0.5.2] - 2026-03-27

### Features

- Recover from renderer process crashes instead of showing blank window (#4274)
- Surface settings recovery status to user via toast notifications (#4272)
- Hardware-aware panel limits with permanent disable option (#4284)
- Proactive disk space monitoring with user warnings (#4278)
- Crash loop protection with safe mode boot (#4273)
- Prevent system sleep during active agent work with powerSaveBlocker (#4279)
- Warn users when project path is in a cloud-synced folder (#4282)
- SQLite database backup, WAL checkpoint, and corruption recovery (#4276)
- Add watchdog to WorkspaceClient matching PtyClient pattern (#4277)
- Auto-cleanup quarantined .corrupted files older than 30 days (#4281)
- Add hard timeout to graceful shutdown to prevent app hanging on exit (#4275)
- Enrich crash reports with environment metadata (#4270)
- Add backup and restore to settings store initialization (#4271)
- Update Canopy icon to V2 design

### Bug Fixes

- Scope focus fallback to active worktree on panel close (#4327)
- Add atomic write utilities and migrate all important file writes (#4280)
- Prevent worktree showing finished while agents are still active (#4268)
- Make empty toolbar space draggable for window management

---

## [0.5.1] - 2026-03-26

### Features

- Skip model selection in panel palette and launch agents directly (#4256)
- Auto-select next agent terminal when closing with Cmd+W (#4236)
- Auto-poll prerequisite status every 3 seconds during setup (#4244)
- Embed terminal in system health check step for interactive installation (#4243)
- Add OS-specific install instructions for system prerequisites (#4242)

### Bug Fixes

- Fix welcome screen buttons flashing when project switcher opens (#4255)
- Correct Notes font family from monospace to sans-serif (#4252)
- Fix agent terminal flash when focused or reparented (#4226)
- Move logger init after single-instance lock to prevent log clearing (#4237)
- Refresh PATH before recheck to detect newly installed tools (#4241)
- Persist agent setup IDs across restarts (#4245)
- Fix toolbar overflow menu alignment and collapse behavior

### Other Changes

- Split E2E tests into core (release gate) and full (nightly) tiers
- Add local unsigned packaging scripts
- Fix native module packaging and afterPack arch mapping for builds

---

## [0.5.0] - 2026-03-26

### Features

**Theme System Overhaul**

- 14 built-in themes with redesigned semantic token system, palette variables, and component overrides (#3992, #3993, #3994)
- Ecosystem imagery theme picker with animated selection (#4042)
- Bondi redesigned as premium warm light theme (#3993)
- Recipe tokens for pulse, heatmap, settings, toolbar, sidebar, and worktree sections

**Memory & Resource Management**

- 3-tier progressive panel limit system to prevent grid overload (#4135)
- Destroy hidden webviews under memory pressure (#4202)
- Lazy-load webviews for browser and dev-preview panels (#4198)
- Dispose xterm.js instances for background-tier terminals (#4200)
- LRU eviction for background Portal (formerly Sidecar) tabs (#4197)
- Per-terminal process resource monitoring with CPU and memory (#4149)
- Replace hardcoded memory estimate with real app.getAppMetrics() (#4219)
- Bridge PTY host ResourceGovernor signals to main process (#4203)
- FD monitoring to detect node-pty leaks on Linux (#4180)
- Reclaim renderer memory on minimize and memory pressure

**Agent Intelligence**

- Surface approval-waiting state with differentiated UI treatment (#3940)
- Classify waiting state reason as prompt, approval, or question (#3939)
- Universal approval prompt hint patterns for all agents (#3937)
- Prompt lexeme fallback heuristic for generic prompt detection (#3938)
- Two-phase directing state timeout
- Immediately transition to working on Enter press

**Bulk Operations**

- Bulk command center palette for multi-worktree operations (#3956, #3958)
- State filtering, templates, and recipe broadcasting (#3960)
- Per-item status tracking, error display, and retry for bulk worktree creation (#3950)
- Emergency bulk agent interrupt with sidebar button (#3955)

**Terminal Improvements**

- Route PTY output over direct MessagePort for lower latency
- Synchronized output wrapping with DEC Mode 2026
- "New output below" scroll indicator (#3815)
- Scroll-to-last-activity action
- Send-to-agent action for terminal selection
- Shell init noise suppression in agent terminals (#4205)
- Manual PTY host restart after auto-recovery exhausted
- PTY diagnostic fields in Terminal Info dialog

**Worktree UX**

- Live drag-to-reorder with persistent manual sort order and DragOverlay preview
- Collapsible worktree cards
- Quick state filter bar with counts above worktree list (#3936, #4231)
- Needs Attention triage section in sidebar
- Session state indicators on collapsed cards (#3975)
- Copy Path and Copy Context progress feedback in 3-dot menu (#4137, #4138)
- Improved root worktree display for non-standard branches (#4055)

**UI Polish**

- Custom Canopy icon set replacing cube logomark with tree mark
- Toolbar responsive design with priority-based overflow (#4133)
- Panel tab scroll arrow buttons for overflow
- Spring easing curves for palette and modal animations (#3818)
- Global Escape key LIFO stack for layered UI dismissal (#3813)
- Contextual shortcut hints replacing passive toasts
- Actionable CTAs in palette empty states (#3814)
- Double-click hint in maximize/restore tooltips
- Layout undo/redo for panel drag-and-drop operations

**GitHub Integration**

- Issue bulk actions with multi-select and floating action bar (#3960)
- Project health signals via GraphQL API
- Comment count in issue and PR list items
- Multi-number and range syntax in issue/PR search
- Select All and Select Unassigned buttons
- Cached issues/PRs shown instantly in toolbar dropdown

**Onboarding & Welcome**

- Theme selection as first onboarding step
- Rich Welcome View replacing minimal welcome screen
- Getting started checklist steps as clickable CTAs
- Celebration UX when checklist completes
- Simplified theme step to Daintree vs Bondi choice (#3996)

**Other**

- Global dev server detection and toolbar integration
- Project groups in project switcher palette
- Per-panel model selection with two-phase UI
- Portal rename (formerly Sidecar) across codebase (#3947)
- Auto-save project settings replacing Cancel/Save bar (#4069)
- Master toggle to disable notifications and hide bell icon (#4085)
- Settings tab memory within session (#4066)
- Demo recording infrastructure with ffmpeg encoding
- Multi-window foundation with WindowRegistry
- Startup skeleton UI shell to eliminate blank window flash

### Bug Fixes

- Fix agent state falsely transitioning to working on layout shifts (#4225)
- Fix commit textarea focus loss during re-renders (#4218)
- Fix 'external diff died' from broken diff.external override (#4214)
- Fix agent launch flags lost during crash recovery (#4215)
- Fix auto-updater errors on Linux .deb installs -- missing APPIMAGE check (#4179)
- Fix PTY pool overriding user's locale to en_US.UTF-8 (#4178)
- Fix Windows node-pty build requiring Spectre-mitigated libraries (#4145)
- Fix cross-platform path handling in EditorService tests (#4146)
- Fix changed file text turning gray on sidebar hover (#4147)
- Fix GitHub token error not linking to settings (#4148)
- Fix truncated file names in git staging window (#4154)
- Fix Bulk Command Center crash from maximum update depth exceeded (#4132)
- Fix commits dropdown ignoring selected worktree branch (#4056)
- Fix duplicate terminal tab issue (#4050)
- Fix layout issue with maximize feature (#4049)
- Fix Gemini CLI connection issues (#4048)
- Fix sessionPersistTimer causing serialization error on PTY exit (#4047)
- Fix unhandled promise rejection in PortalManager.navigate() (#4046)
- Fix View/Diff toggle not switching to View mode (#4045)
- Fix agent failed state unreliability -- remove failed state detection (#4043, #4037)
- Fix main worktree cards showing branch name instead of project name (#3789)
- Fix removeProject() orphaning PTY processes (#3788)
- Fix worktree deletion failures (#3946)
- Fix pasted URLs highlighted due to dual link handling (#3948)
- Fix agent viewport intermittently jumping to top (#3949)
- Fix URLs not clickable after WebLinksAddon removal (#3820)
- Fix worktree card click targets making selection difficult (#3809)
- Fix renderer cleanup gaps for inputControllers and SemanticAnalysisService (#3835)
- Fix PTY host cleanup not releasing SharedArrayBuffer references (#3839)
- Fix issue icon checkbox hover target (#3918)
- Fix project keybinding broken by group add/remove (#4117)
- Fix Daintree settings sidebar background color (#4075)
- Fix Pulse differentiating 'no internet' from 'no GitHub remote' (#4093)
- Fix dev preview slow start detection causing unnecessary restart (#4087)
- Fix "Loading agent status..." in dev mode (#4083)
- Fix bulk worktree creation running twice (#4011)
- Fix non-user-invocable slash commands appearing in hybrid input (#4181)
- Strip ELECTRON_RUN_AS_NODE from spawned environments (#4176)
- Reduce 2-panel split divider width from 12px to 6px (#4086)
- Remove Pulse current-day highlight ring, show commit count (#4082)
- Remove empty-state recipe buttons (#4079)
- Remove built-in Canopy commands and Agent Instructions (#4100)

### Security

- Harden simple-git against malicious repo config RCE
- Harden webview CSP with form-action directive
- Validate webContentsId ownership in CDP handlers
- Kill entire process tree on terminal close and app quit
- Add fetch timeouts to GitHub API and Git operations
- Global error handlers with crash logging and relaunch
- Unhandled promise rejection handler in renderer

### Accessibility

- Screen reader support for terminals
- Forced-colors CSS and form error linking
- axe-core coverage in E2E tests

### Performance

- React.lazy code splitting for heavy panel components
- V8 bytecode caching for faster startup
- React.memo on GridTabGroup, GridPanel, ActionPaletteItem, QuickSwitcherItem
- useDeferredValue for worktree list, event log, and palette search
- CSS containment on panel and terminal containers
- Memoize worktree data, selectors, and GitService instances
- Preserve object identity in store updates to reduce re-renders
- Replace requestIdleCallback with scheduler.postTask
- Event loop lag and long task monitoring
- CI optimizations: parallel build, reduced runner costs

### E2E Testing

- ~50 new E2E test suites covering terminals, worktrees, panels, crash recovery, accessibility, keyboard navigation, settings, onboarding, notes, portal, drag-and-drop, context injection, and more
- Shared focus assertion helpers and workflow step library
- PTY stress test helper infrastructure
- IPC fault injection infrastructure for error testing
- Single-file E2E test trigger in CI workflow (#3917)
- Nightly memory leak detection tests

---

## [0.4.0] - 2026-03-17

### Features

**Digital Ecology Theme Collection**

- 12 new nature-inspired themes: Daintree (default dark), Bondi, Fiordland, Highlands, Arashiyama, Galápagos, Namib, Redwoods, Atacama, Serengeti, Hokkaido, Svalbard (#3299, #3303, #3293, #3294, #3305, #3310, #3312, #3313, #3314, #3315, #3316, #3311)
- Full light-mode support with light-aware token factory and structural color variants (#3271, #3283)
- Terminal color scheme automatically matches the active app theme (#3345)
- Separate dark and light theme sections in the theme picker (#3334)
- Theme redesigns for improved contrast and identity across Arashiyama, Fiordland, Galápagos, Highlands, Namib, Redwoods, Hokkaido, Bondi, Atacama, Serengeti, Svalbard (#3387–#3404)

**Hybrid Input Bar**

- Fuzzy prompt history search with Ctrl+R (#3105)
- @diff, @terminal, and @selection context mentions for inline context bridging (#3158, #3241)
- Image paste and file drag-and-drop support (#3136, #3106)
- Attachment tray with context visibility (#3137)
- Pop-out expanded editor (#3104)
- Input stash — saves and restores draft text on context switch (#3090)
- Slash command support mid-text (#3085)
- URL paste detection with opt-in content resolution (#3089)

**Workflow Engine**

- Workflow execution status panel (#3248)
- Approval gate node for human-in-the-loop workflows (#3242)
- Loop node for bounded retry patterns (#3249)
- Typed data flow between workflow nodes (#3240)
- IPC bridge exposing WorkflowEngine to the renderer (#3239)

**Agent System**

- Directing state — detects when user is actively typing into a waiting terminal (#3140)
- Cursor CLI added as a supported agent (#3038)
- Resume agent sessions from stored session IDs (#3040)
- Gemini CLI window title used as structured state signal (#3201)
- Proactive per-process memory monitoring (#3237)
- Escalate waiting agent to OS notification after inactivity threshold (#3037)
- Re-entry summary notification when returning after background agent activity (#3099)
- Derive all agent references from central registry (#3178)
- Discover Claude Code skills as slash commands automatically (#3084)

**Settings & Preferences**

- Environment Variables tab (#3279)
- Privacy & Data tab (#3289)
- Sub-tab navigation for General and Panel Grid tabs (#3269, #3268)
- Appearance split into App and Terminal subtabs (#3329)
- Per-setting modified indicators with inline reset (#2931)
- Fuzzy search with @modified filter (#2923)
- Contextual entry points from the main UI (#2950)
- Searchable dropdown selector for CLI Agents (#3284)

**GitHub Integration**

- Redesigned issue and PR list items for better information density (#3095)
- Unified visual language across Issues, PR, and Commit dropdowns (#3234)
- Sort order controls with filter popover (#3330, #3342)
- CI status indicator on PR list items (#3063)
- Keyboard navigation in issue, PR, and commit dropdowns (#2989)
- Clickable issue/PR titles and linked PR refs (#3170)
- Indicate existing worktrees in the issue/PR dropdown (#2981)

**Per-Project Configuration**

- Per-project MCP server configuration (#3267)
- Per-project AI agent instructions (#3244)
- Per-project terminal shell and scrollback settings (#3247)
- Per-project worktree path pattern override (#3245)
- Per-project notification preference overrides (#3288)

**Worktree & Sidebar**

- Lifecycle stage indicator on worktree card header (#2832)
- Card-level visual treatment for waiting agent state (#2859)
- Worktree count badge in sidebar header (#2856)
- 4 priority-ordered state chips (#2959)
- Recipe-first quick worktree creation flow (#3045)
- Running QuickRun tasks shown with status in sidebar (#3098)

**Panel & Layout**

- Promote Move to Dock to visible header button (#3134)
- Background panel location for running tasks without visible panels (#3061)
- Macro-region focus cycling with F6/Shift+F6 (#3153)
- Trash icon pulse animation replacing close-panel toast (#3138)
- Keyboard access to panel context menus via Shift+F10 (#2951)

**Terminal Rendering**

- WebGL renderer for focused terminal (#3213)
- Tiered WebGL context leasing system (#3223)
- Renderer micro-optimizations: font preloading, cursor blur, offscreen visibility (#3139)
- Stagger terminal spawning during session restore (#3130)
- Evict orphaned restore session files on startup (#3187)

**Notifications**

- Action buttons on notification history entries (#2831)
- Improved notification center with read management and filtering (#2980)
- Coalesce rapid agent notifications into a single updating toast (#2982)
- Reduce notification noise for user-initiated actions (#3126)

**Notes**

- Markdown preview with Edit/Split/Preview toggle (#2830)
- Markdown formatting toolbar (#2922)
- Tag filtering and sort options (#2948)

**Onboarding**

- Unified resumable onboarding state machine (#2836)
- Getting-started checklist after setup wizard (#2952)
- Progress indicator between steps (#3450)

**Browser & Dev Preview**

- URL history autocomplete in address bar (#2835)
- Find-in-page (Cmd+F) in browser and dev-preview panels (#2949)
- CDP-based object inspection and stack traces in console panel (#2955)

**Accessibility**

- Color vision mode for colorblind accessibility (#3042)
- Screen reader announcements for drag-and-drop and status changes (#2945)
- Toolbar arrow key navigation with ARIA roles (#2921)

**Voice Input**

- Word-level confidence scoring for selective LLM correction (#2834, #2876)
- Dynamic project context injection into Deepgram keyterms (#2837)

**Other**

- Node.js compile cache for faster cold start (#3447)
- Demonstration mode for scripted video production (#2973)
- QuickRun Justfile and Taskfile.yml task detection (#2998)
- Arch-specific macOS builds alongside universal (#2958)

### Bug Fixes

- Fix terminal scrollback lost when hibernation kills processes (#3177)
- Fix scroll position jumping during wake-restore cycle (#3103)
- Fix new terminals not respecting selected color scheme (#3343)
- Fix terminal wrapper background bleed with active color scheme (#3328)
- Fix mouse/focus events falsely triggering directing state (#3325)
- Fix stacked restart indicators in terminal panels (#3463)
- Skip WebGL renderer on software-only GPU (#3362)
- Reduce WebGL context pool to stay under Chromium limit (#3358)
- Fix directing/waiting jitter on prompt submission (#3224)
- Allow user input to recover agent from failed state (#3195)
- Persist and restore agent launch flags on session resume (#3175)
- Filter cosmetic terminal redraws from activity tracking (#3200)
- Fix CPU% always reporting 0 on Windows (#3407)
- Fix panel position/size swap on project switch (#3424)
- Fix tab bar overflow — add indicators and active tab auto-scroll (#3465)
- Fix dock popover dismissing on outside click and header button interactions (#3133, #3125)
- Fix stale GitHub metadata in worktree sidebar (#3333)
- Fix PR list failing with GraphQL type mismatch on sort (#3339)
- Fix GitHub dropdown timeout — replace 90s wait with immediate reset on close (#3220)
- Fix worktree sidebar search for text and bare number queries (#3423)
- Remove spurious self-assign notification on worktree creation (#3446)
- Fix orphaned PTY process trees on Windows via taskkill /T (#3322)
- Make lifecycle service cross-platform — replace Unix-only process group kill (#3323)
- Expand Windows Git PATH discovery for x86, Scoop, and Chocolatey (#3425)
- Use native title bar on Linux (#3321)
- Fix background color flash on startup with light themes (#3461)
- Fix OpenCode TUI blank screen caused by CI env var poisoning (#3417)
- Discard orphaned dev-mode crash markers on startup (#3405)
- Cap concurrent toast display at 3 with overflow displacement (#3458)
- Replace emoji icons in error UI with Lucide SVGs for cross-platform consistency (#3449)
- Block browser-default file navigation on non-terminal drop (#3448)
- Fix default scrollback from 5000 to 1000 lines (#3172, #3365)
- Clear stale terminal state maps on panel removal (#3173)
- Show only user-selected agents in toolbar (#3210)
- Deep-link toolbar agent button to agent settings subtab (#3331)
- Show keyboard shortcut hints in all toolbar tooltips (#3462)

### Performance

- Graduated memory pressure mitigation — auto-reduce scrollback and hibernate idle terminals (#3366)
- Skip terminal wake cycle for warm terminals during project switch (#3235)
- Concurrent non-PTY panel restoration during hydration (#3199)
- Reduce reconnect fallback timeout from 10s to 2s (#3191)
- Tune Vite build target for Electron 40 / Chromium 144 (#3486)

### Other Changes

- Migrate from Vite 6 to Vite 8 with Rolldown bundler (#3490)
- Upgrade ESLint from v9 to v10 (#3489)
- Bump node-pty to 1.2.0-beta.12 (#3477)
- Strip debug console statements from production builds (#3452)
- 19 new E2E test suites covering action palette, terminal search, worktree interactions, crash recovery, accessibility, and more
- Major refactoring: decompose main.ts, WorkspaceService, ProjectStore, TerminalProcess, HybridInputBar, and 10+ other modules into focused collaborators

---

## [0.3.0] - 2026-03-11

### Features

- **Worktree Sidebar Redesign** — Visual hierarchy polish, unified search+filter input, persistent inline search bar, and header cleanup (#2756, #2758, #2747)
- **Voice Input Improvements** — Upgrade to GPT-5 Mini correction model, stable ID-based correction matching, canonical phase model, paragraphing strategy with spoken-command default, and distinct interim vs pending-AI visual treatment (#2754, #2694, #2692, #2697, #2695)
- **SQLite Project Registry** — Migrate project registry from electron-store JSON to SQLite for durability (#2707)
- **Project Relocation** — Relocate projects with automatic state and environment variable migration (#2688)
- **Check for Updates** — Add menu item to manually check for application updates (#2685)
- **File Viewer Images** — Display image files inline in the file viewer instead of showing binary error (#2739)
- **Settings Subtabs** — Formal subtab support for settings pages, CLI Agents tab restructured with subtabs and canonical default agent (#2698, #2699)
- **Review Hub Enhancements** — Surface PR state with clickable link, add base-branch diff toggle for PR-accurate review (#2684, #2683)
- **GitHub Issue Selector** — Show author and comment count in issue selector rows (#2690)

### Bug Fixes

- Fix cross-project contamination in worktree snapshot cache and refresh (#2741, #2703)
- Fix crash recovery destroying project list on Start Fresh (#2704)
- Exclude projects from crash recovery session snapshot (#2706)
- Fix dev mode triggering crash recovery dialog on every restart (#2705)
- Fix Cmd+W not closing the focused panel (#2689)
- Fix input field intermittently dropping text on submit (#2737)
- Fix Enter during voice dictation corrupting paragraph boundaries (#2693)
- Replace aggressive GitHub error box with stale data banner (#2740)
- Add actionable link to GitHub settings on token configuration error (#2738)
- Replace AI correction badge with green dotted underline decoration (#2755)
- Anchor plus button to right edge of worktrees header (#2765)
- Remove root worktree background tint collision with active selection (#2766)
- Remove inline Copy Context button and Inject Context menu item (#2763)
- Reduce noisy success toasts for user-initiated actions (#2752)
- Remove hardcoded onboarding wizard prompt sent to agent (#2700)
- Restore primary button text contrast (#2682)
- Hide Check for Updates menu item in development mode (#2753)
- Handle renamed or deleted project directories gracefully (#2686)

### Performance

- Throttle inactive dock webviews via CDP lifecycle freeze (#2702)
- Reduce renderer render churn from high-frequency store updates (#2701)

---

## [0.2.0] - 2026-03-09

### Features

- **Voice Input** — Real-time voice transcription via Deepgram Nova-3 with AI text correction, paragraph boundary detection, persistent dictation across navigation, and Escape-to-cancel (#2680, #2672, #2559, #2558)
- **MCP Server** — Expose action system as local MCP server with port config, auth, and settings UI (#2533)
- **Crash Recovery** — Recovery dialog with diagnostics, restore options, and hydration race protection (#2551)
- **Review Hub** — In-app git staging, commit, and push with auto-resync on git status changes (#2576)
- **Notification System** — Unified notify() API with priority-based routing, toast redesign, notification center dropdown, and agent completion sounds (#2541, #2670, #2671)
- **Settings Overhaul** — Searchable settings, consistent card layout, icons, improved keyboard UX, and modified indicators (#2553)
- **Theme System** — Semantic color tokens, editor/terminal theme subsystems, color scheme selection, brand accent shift to muted blue (#2595, #2539)
- **SQLite Persistence** — Migrate tasks and workflow runs from JSON to SQLite for improved reliability
- **Worktree Enhancements** — Lifecycle scripts (.canopy/config.json), cross-worktree diff comparison, configurable branch prefix, create worktree from PR action (#2530, #2641)
- **Editor Integration** — Configurable open-in-editor with first-class editor support
- **In-Repo Settings** — Read and write .canopy/project.json for portable project identity (#2526)
- **Terminal Watch** — One-shot terminal watch notifications and browser console capture with screenshots (#2539, #2557)
- **Keybinding Profiles** — Import/export keyboard shortcut profiles
- **Onboarding** — System health check during first-run setup
- **Telemetry** — Opt-in crash reporting with Sentry
- **Security** — Environment variable filter for terminal spawning

### Bug Fixes

- Fix layout corruption when adding third panel in two-pane split mode (#2638)
- Voice recording no longer stops when Canopy loses window focus (#2666)
- Fix toolbar project-switcher collision with CSS grid layout (#2584)
- Reliably switch renderer to newly created worktree (#2571)
- Fix hydration race conditions and false positive crash detection
- Upgrade node-pty to 1.2.0-beta.11 to fix Windows build (#2646)
- Fix toaster infinite re-render loop with useShallow
- Hide closed PRs from worktree card header badges (#2578)
- Fix root worktree toggle behavior and label clarity
- Standardize toolbar interactive state colors to shared token set (#2585)
- Fix notification badge over-counting with seenAsToast tracking (#2670)
- Fix text selection visibility in dark theme (#2617)
- Replace native Electron context menus with Radix UI for consistency
- Harden mic permission detection across all platforms

### Other Changes

- Migrate raw Tailwind color utilities to semantic design tokens
- Unify all settings tabs to consistent card layout
- Extensive test coverage additions across MCP, voice, persistence, and workspace modules

---

## [0.1.0] - 2026-02-26

### Highlights

Initial public release of Canopy Command Center — an Electron-based IDE for orchestrating AI coding agents.

### Core Features

- **Terminal Grid** — Multi-panel terminal layout with xterm.js v6, split panes, dock, and drag-and-drop reordering
- **Agent Orchestration** — First-class support for Claude, Gemini, and Codex agents with state detection (idle/working/waiting/completed)
- **Worktree Dashboard** — Visual git worktree management with real-time status, mood indicators, and file watching
- **Context Injection** — CopyTree integration for generating and injecting project context into agent terminals
- **Action System** — Unified dispatch layer for menus, keybindings, context menus, and agent automation (17 action categories)
- **Browser Panels** — Embedded browser with dev preview for local development servers
- **Multi-Project Support** — Fast project switching with optimistic UI updates and per-project state persistence
- **GitHub Integration** — Issue and PR status in toolbar, worktree linking to issues

### Security

- Hardened Electron runtime with sandbox and permission controls
- Electron fuses enabled, code signing enforced (macOS)
- Content Security Policy across all sessions
- IPC rate limiting and error sanitization

### Performance

- Non-blocking project switching with parallelized hydration
- Stale-while-revalidate caching for worktree snapshots
- Terminal container optimized for xterm v6 overlay scrollbar
- Adaptive polling with circuit breaker resilience
