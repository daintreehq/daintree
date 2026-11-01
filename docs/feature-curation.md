# Feature Curation Guide

> _"You can do anything, but you cannot do everything."_

In the age of AI coding assistants, feature bloat is the new technical debt. Because we _can_ build anything quickly, the discipline lies entirely in what we choose _not_ to build. Code is cheap; the attention, support and cross-platform surface every feature claims for the rest of its life are not.

This file is a decision instrument, not reference documentation. Work a proposal through it in order: the hard lines, core or plugin, whether the agent already does it, then the Green and Red Light tests. The decision log at the end records what was actually decided and why — when a decision changes, the row changes with it.

## What Daintree IS

**Daintree is a habitat for your AI coding agents** — a review-first desktop environment for running many of them in parallel, each in its own worktree, isolated and observable, with you still in the loop.

Agents run as their own CLIs in real terminals. Daintree observes them, puts them in front of you when they need you, gets context into them, and gets their changes reviewed and landed. If VS Code is the workbench where you craft the part, Daintree is the habitat where your agents live and work, and where you watch and guide them.

**Daintree is NOT a code editor (like VS Code), NOT a chat UI (like ChatGPT), and NOT a Git GUI (like SourceTree).** It is the orchestration layer around real terminal agents.

### Where it has been heading

Three shifts since early 2026 shape most decisions here:

1. **Orchestration runs on the user's own agent CLIs, not on an engine of Daintree's.** The DAG workflow engine (#4623) and the task queue went; a native in-app assistant was rejected twice (#10649, #12189); the Daintree Assistant CLI was retired (#12824, #13513). What replaced them is the MCP control surface: Claude Code, Codex and the rest drive Daintree's actions as tools, hand work to each other, and report back through observable markers.
2. **New product surface goes into plugins.** The core is "managing agent terminals and panels, and letting the rest exist as plugins" (#5538). GitHub and GitLab are forge plugins, Markdown editing is a built-in plugin, and project plugins can be full applications with their own database and agent tools (#12842).
3. **Daintree reaches past one machine.** Remote Hosts runs the whole backend on another Mac or Linux machine over SSH (#12838), and on Windows drives Linux Hosts inside WSL (#13431).

Meanwhile the agent CLIs themselves now ship worktrees, subagents, session resume, hooks and remote control. That narrows what is worth building: Daintree's value is what no single agent can see or do for itself — across agents from different vendors, across worktrees and projects, across machines, and from passive observation of all of them.

## Core Pillars

1. **Panel Grid** — Agents in real terminals, alongside browser, dev preview, review, file, file-browser and diff panels. Layout is automatic and size-driven with dock and maximize, not freeform (#4768).
2. **Agent State & Attention** — Observed agent state, attention bands (blocked, needs you, review, done…), Pilot across every project, park, snooze and read marks, and notifications that reach you only when an agent needs you.
3. **Fleet & Automation** — Arm several agents and type once, saved fleets, terminal recipes, and actions that take an issue to a worktree to a running agent.
4. **Worktree Orchestration** — Worktree lifecycle, scratch workspaces and plain folders, per-worktree dev servers with embedded preview, and status across all of them.
5. **Context In, Review Out** — Getting the right files, diffs, errors, screenshots and notes into an agent (CopyTree, `@` mentions, drag and drop, send-to-agent, diff notes), and getting its output reviewed and landed (Review Hub, cross-worktree diff, PR and CI signals, the bounded Git operations below).
6. **Visual Identity & Comfort** — A theme system and a calm interface that make Daintree feel like a native app, reduce strain over long sessions, and support accessibility needs.

**Platform** (the layers that let the core reach further):

- **Agent Control Surface (MCP)** — Daintree's action manifest served as MCP tools, so agents can open worktrees, launch and wait on peers, and read state. Handed to agents at launch only where a project opts in. See [The MCP Surface Has Its Own Budget](#the-mcp-surface-has-its-own-budget).
- **Plugins** — Capability-gated extensions that contribute actions, panels, agents, forge providers, MCP tools and full project applications. The release valve for everything that isn't core.
- **Remote Hosts** — A window drives another machine's whole Daintree backend, with one driver per project at a time.

**Strategic Features** (significant, but not pillars):

- **Daintree Assistant** — The user's own Claude Code or Codex, running in a terminal in the help panel, wired to Daintree's MCP tools, docs and runbooks. Orchestration context without a bespoke chat UI.
- **Canopy** — An opt-in reader that ranks every agent by what it needs from you, quoting each screen as its evidence. Reads on the user's own machine with a small open model it downloads from Hugging Face (#14448).
- **Voice Input** — Hands-free delegation while monitoring other agents.
- **Portal** — A tabbed dock for web-based AI agent UIs alongside terminal agents.

**Brand Voice:** "Calm partner" — helpful, not flashy. Reduces cognitive load. Opinionated defaults. Quiet when nothing needs you; it never praises the user for doing their work and never guilts them for not doing it (#11182, #12840).

## The Hard Lines

These are knockouts, not scores. A proposal that crosses any one of them is rejected however well it does on the Green Light test. Most of them restate the Product invariants in `CLAUDE.md`, which hold the full wording.

1. **Never modify user-owned agent config** — `~/.claude/`, `~/.codex/`, `~/.gemini/`, user hooks, the user's own CLAUDE.md or AGENTS.md — not even additively (#4100). The only sanctioned shapes are a display-only launch switch declared in the registry, and a Daintree-owned MCP server added beside the user's own.
2. **Never alter an agent the user didn't ask to have altered.** Orchestration features are opt-in per launch or per project, or for every project where the user says so: an installed plugin's agent access can be set once for every project, and turning Decisions on, after consent that names it, adds its own MCP server to every launch that supports one, and nothing else (#15997). With none of those on, a terminal the user opened for ordinary coding pays nothing and sees nothing: no added MCP server, no appended prompt text, no detector on its hot path beyond the passive state observation every terminal already gets.
3. **Observe, don't reach around.** Agent state comes from passive observation: output, OSC titles, the process tree, and records the CLI already writes, read-only. No active probes, no interrogating an agent's dependencies, no reading its credentials (#11702).
4. **Surface observations, not interpretations.** Agent state is a heuristic and is often wrong; UI and MCP show what was seen, not what was concluded from it. Canopy is the one written exception, and it is attributed, quotes the screen, and never rewrites, clears or hides what Daintree observed.
5. **Nothing leaves the machine without consent.** Terminal contents, prompts and code go off the machine only through a feature the user explicitly turned on, and the local product stays complete without it. See [Hosted Features](#hosted-features).

## Core or Plugin?

Core is managing agent terminals and panels, and what they need to be supervised: worktrees, attention, context, review, the control surface. Everything else should be a plugin, and the work goes into making the plugin surface good enough to carry it.

- **Default to plugin** for anything that isn't about agents, terminals, panels or worktrees. Being rejected from core is not being rejected: time tracking (#5538) and a notes app (#5616) are both fine as plugins. Project plugins may be complete applications — a CRM, a kanban board, a finance tracker — with their own data and agent tools (#12842).
- **Ship as a built-in plugin** when Daintree should have it out of the box but it isn't orchestration: forge providers, the Markdown editor. A built-in plugin still has to pass this rubric.
- **This rubric decides core and built-in plugins.** A third-party or project plugin answers to the plugin trust model and capability consent (`docs/plugins/trust-model.md`), not to these tests.
- **Go to core** when a plugin can't do it because there is no hook — and then ask whether the hook belongs in the plugin surface instead. A first-class WSL execution layer had to be core (#12830) and became part of Remote Hosts.
- **Distribution is curated, not a marketplace** — no ratings, no comments, no third-party uploads (#9305).

## Does the Agent Already Do It?

The CLIs Daintree orchestrates update independently and keep absorbing features: worktree flags, subagents, agent teams, session history and resume, hooks, checkpoints, remote control. Before building something, check whether the agents already ship it.

Daintree adds value when a feature works **across** something: across all supported agents rather than one, across worktrees, projects or hosts, or from observation the agent can't make of itself. Rebuilding one agent's feature in a GUI is duplication. Reading what the agent already exposes and putting it in the cross-agent picture — subagent sessions shown as child chips (#11948), the handback marker — is not.

## Polish Is Always Welcome

This guide gates **new features** — it does not gate **polish**. Improving an empty state, refining a micro-interaction, fixing a visual inconsistency, or smoothing a rough edge in an existing feature is always accepted work. Daintree's ambition is to be the most polished application in its category. Every interaction should feel considered and intentional.

Polish work does not need to pass the Green Light test. If something already exists in Daintree and it can be made better, smoother, or more delightful — do it. The exemption is from the Green Light test only: a "refinement" that adds celebration, a new setting or new behaviour is a feature, and the Hard Lines and the Red Light test apply to it.

## The Habitat Principle

Daintree is a habitat — a place where developers spend hours every day. Features that help users settle into and personalize their environment are not decoration; they're part of the product's core value proposition.

Ask: _"Does this help the user make Daintree feel like **their** space?"_

Theme discovery (random theme, search, hero previews), project identity (colors, emoji), and environmental comfort (dock density, sounds and quiet hours, reduced motion) all serve this principle. They make users want to stay in Daintree rather than reach for another tool.

**Comfort, not engagement.** A habitat is calm. Delight lives in craft — a well-tuned theme, a transition that feels right — not in rewarding the user. Streak coaching, missed-day visuals, milestone toasts and confetti were all removed: they put guilt and praise into a product that is meant to feel calm (#11182, #12840). Quiet observation is fine — a pulse heatmap or an activity count that the user can read or ignore — but nothing that nudges, celebrates or keeps score.

This is distinct from "Purposeless Decoration": habitat features serve _user comfort and ownership_, while purposeless decoration serves no one.

## The Cost of Attention Test

For every feature proposal, ask:

> _Does adding this feature reduce the user's cognitive load by handling an orchestration task, or does it increase load by demanding manual interaction?_

If its net effect is more load or more manual interaction, **reject it**. Review surfaces are interaction, but they pass because they replace a slower round trip through a terminal, an editor and a browser.

## The Green Light Test

A feature belongs in Daintree **only if it satisfies at least two** of these criteria, **and at least one of the two is in the first six**:

| Criterion | Description |
| --- | --- |
| **Accelerates Context In** | Makes it faster to feed the right files, errors, diffs, notes or screenshots to an agent |
| **Shortens Review** | Makes it faster to understand, check and land what an agent produced |
| **Unblocks the Agent** | Detects when an agent is stuck, waiting, or failed, and helps the human intervene quickly |
| **Manages Multiplicity** | Helps manage _multiple_ concurrent workstreams that a human brain can't track alone |
| **Provides Omniscience** | Aggregates what is happening across isolated contexts — agents, worktrees, projects, hosts — into one view |
| **Enables Automation** | Lets the user set up reactive workflows that reduce manual monitoring and intervention |
| **Bridges the Gap** | Fixes a friction point between CLI agents and the GUI orchestration layer |
| **Reinforces Identity** | Strengthens Daintree's visual distinctiveness, user comfort, accessibility, or helps users personalize their habitat |

Bridges the Gap and Reinforces Identity are real criteria but elastic ones: almost anything can be argued into them. Together they don't carry a new feature. The habitat is the exception: a theme, comfort or accessibility feature is judged by [The Habitat Principle](#the-habitat-principle) instead, and still has to pass the Hard Lines and the Red Light test.

## The Red Light Test

Daintree **explicitly rejects** features that:

| Anti-Pattern | Why |
| --- | --- |
| **Reinvents the Code Editor** | Code editing, refactoring tools, linting → send the user to their editor. Read-only viewing and annotation are fine. Markdown editing is the one bounded exception, as a built-in plugin, and the Source view stays read-only. |
| **Reinvents the Git GUI** | Git matters here for worktrees, diffs, and the operations that keep a worktree moving — stage, commit, push, pull, rebase onto or merge in the base, whole-file conflict choices, continue and abort. History graphs, hunk-level or three-way merge editors, interactive rebase and general branch management are a Git client's job. |
| **Reinvents the Chat UI** | Agents run in real terminals, and so does the Assistant: it is the user's own agent CLI (#10649, #12189). Surfaces that summarize an agent, like Canopy's cards, answer into the agent's own terminal; the terminal stays the source of truth. |
| **Excessive Configuration** | Each feature should work with zero configuration beyond the credentials it can't do without, like an API key or a host address. Settings exist for power users, not as requirements. If a feature can't ship with an opinionated default, it's too complex. Settings group by feature area and plugin settings consolidate in one place. |
| **Purposeless Decoration** | Animations or UI elements that don't convey state, reinforce identity, or serve user comfort. Celebration and gamification count as decoration (#12840). |
| **Duplicates Agents Without Context** | If the agent CLI already does it well and you'd just be rebuilding it in a GUI, don't. Wrapping agent capabilities in Daintree's cross-agent, cross-worktree context is the value. See [Does the Agent Already Do It?](#does-the-agent-already-do-it). |

**Additional anti-patterns:**

- One-off utilities without workflow integration
- Anything easily done with a shell alias
- Features better handled by external tools (general file management, system tools) — the file and process tools Daintree has are scoped to cleaning up after agents
- Features that only make sense for one agent in one checkout

## The Automation Gradient

Daintree features should trend toward automation, not interaction:

| Level | Description | Daintree Fit |
| --- | --- | --- |
| **Manual** | User must perform action every time | Poor — should be a shell alias |
| **Assisted** | Daintree detects something, user acts | Acceptable — bridges the gap |
| **Reactive** | Daintree detects and responds with minimal user input | Good — reduces cognitive load |
| **Autonomous** | Daintree handles it entirely, user is notified | Excellent — true orchestration |

Features at the "Manual" level rarely belong. Features at "Reactive" or "Autonomous" level are strong candidates — **provided they act on facts, not guesses.** Exit codes, an explicit handback marker, a CI result and a file change are facts. Heuristic agent state is a guess: it can drive what Daintree shows and in what order, but an autonomous action triggered by it alone does more harm when it's wrong than it saves when it's right.

## Workshop vs Orchestration Layer

Ask yourself:

> _"Does this feature belong in the Workshop (the editor) or the Orchestration Layer (Daintree)?"_

If the answer is **Workshop**, we don't build the feature. At most, we build a **button that opens the Workshop** to the right place (like the existing "Open in Editor" integration).

**The grey area:** Read-only viewing, annotation, Markdown working documents, and lightweight interaction (staging files, reviewing diffs, keeping a worktree current with its base) belong in the Orchestration Layer. Editing code, running linters, and hunk-level merge resolution belong in the Workshop.

## The MCP Surface Has Its Own Budget

The action manifest is a public contract: it is also the tool surface external agents see (`docs/architecture/action-system.md`, `.claude/rules/actions-and-mcp.md`). Registering an action does not expose it over MCP; exposing it is a separate, deliberate decision.

- **On the external tier, keep what only Daintree can do** — terminal and agent orchestration, worktrees, recipes, live IDE context. **Drop what the caller already has** — an agent in a terminal has its own shell, its own git and its own `gh`, so git plumbing, forge reads and writes, and file reads are its job (#11585, #11592).
- **The in-app Core and Full sets reach further** for the Assistant and opted-in agent panes, but they are budgeted too: every tool in them is re-sent to the model on each turn, so Core holds the orchestration loop and the rest waits in Full (#12839).
- **The size is a product constraint.** Clients cap or silently truncate large tool lists, so the external tier is a fixed, individually vetted allowlist with count and byte budgets enforced in CI. Raising the budget is the decision the budget exists to force into the open (#12307).
- **Orchestrator primitives are minimal and observable**: a wait reports whether Daintree is still tracking a terminal, never a liveness verdict; interrupt is a keystroke on panels the caller owns; client metadata is an opaque blob.

## Hosted Features

Daintree runs on machines the user controls. A feature that sends terminal contents, prompts or code anywhere else must be:

- **Off until the user turns it on**, with consent that says what is sent and where.
- **Attributed** — anything it concludes is labelled as coming from it, never presented as something Daintree observed.
- **Optional** — the local product stays complete without it, and turning it off removes it entirely.

Decisions is the one approved feature that does this (#15996, #15997). Once the user turns it on, what an agent puts in a question (its text, context and screenshots) and the user's answers go to a relay the user deploys in their own Cloudflare account, never to a server Daintree runs, end-to-end encrypted between the user's computer and phone. The relay can read routing metadata (ids, timestamps, requirement level, sizes) and holds each paired phone's push endpoint; a push says only that a question needs input. Voice dictation in its phone app is not end-to-end encrypted, and sending decision history to a model provider has its own consent. The design is in [decisions.md](./architecture/decisions.md). Canopy sent screens off the machine until #14448, which moved its reading onto the user's machine: a model is downloaded once (a download, so outside this rule) and no screen leaves the machine. Downloads (updates, tour audio, the plugin blocklist, Canopy's model) and the user's own agents talking to their own model providers are not in scope of this rule.

## Decision Log

Each row is a decision that was actually made, with the issue or PR behind it. When a decision is revisited, update its row and cite the new number rather than adding a contradicting one.

### Agents and attention

| Feature Proposal | Decision | Reasoning |
| --- | --- | --- |
| Completion Notifications | **APPROVE** | Unblocks agent. Manages multiplicity. Enables reactive workflow. |
| Restart and Retry Failures | **APPROVE** | Restart a pane, retry a failed fleet send. Unblocks the agent without retyping. |
| Fleet Broadcast | **APPROVE** | Arm several agents, type once. Manages multiplicity. Saved fleets make it repeatable. |
| Pilot (all agents, every project) | **APPROVE** | Provides omniscience: one keyboard-driven view of every run, grouped by what it needs. |
| Park, Snooze and Read Marks | **APPROVE** | The user's own triage marks. They change ordering, never what was observed. |
| "Waiting for shell" as a separate state | **REJECT** | Useful but unreliable: it needs a per-agent matcher maintained forever across every CLI (#4871). |
| Provider reachability probes | **REMOVED** | The one place Daintree reached around an agent CLI. Passive observation only (#11702). |
| Canopy | **APPROVE (opt-in, bounded)** | An inbox ranked by a model's reading of each screen. Off until turned on, every placement attributed and quoting the screen, never rewrites or hides observed state, gone entirely when off (#13220). Reads locally with an open model since #14448: no hosted service, no paid tier. |
| Answer from another device | **APPROVE (opt-in, paired)** | Answer a waiting agent from a phone or laptop the user paired. Off until turned on, and pairing is the consent for the page. The device sees the observed screen, with common secret patterns redacted first (best effort), and sends back only an option label; Daintree re-reads the screen and plans the keys itself (#13684, #13701). Reaches every connected host through main, and each host reads, redacts and plans its own answers under its own drive lease (#13941). Free and local, with Canopy off, and still the zero-infrastructure path: it needs nothing but the user's own tunnel. #14023 closed with the phone app planned as a native app in its own repository (daintreehq/daintree-mobile), so this page gets no Web Push step. The push-relay question it left open is answered by Decisions: its phone app is notified through a relay the user runs in their own Cloudflare account, and Daintree operates no relay (#15997). |
| Daintree Decisions | **APPROVE (opt-in, own relay)** | An agent asks with one MCP tool and ends its turn; the user answers from their phone whenever they get to it, and Daintree types the answer into the exact terminal that asked once it is idle, resuming a Claude or Codex session first if the pane is gone, and listing what it can't deliver. Unblocks agents without anyone at the keyboard, across every supported agent and enrolled Remote Host (#15996, #15997). A Hosted Feature: one global switch, off until turned on, with consent that names what is sent and where; content is end-to-end encrypted to a relay in the user's own Cloudflare account, so Daintree operates nothing. Core, because it needs guarded delivery into the exact user-launched pane that asked and session resume from main with no window: a plugin can submit only to agents it launched, with no submission guard, and resume only through the renderer. Remote Hosts are enrolled as devices of the same owner, never configured separately. Only agents with launch-time MCP get it, with no manual setup line for the rest, and user agent config is never touched. Trusted gates set the requirement and an agent can only make it stricter; a proxy answer is labelled and never satisfies human-required; the pane shows what was observed. Doesn't replace Canopy or Answer from another device. |
| Handback marker | **APPROVE** | An orchestrator opts in when it sends a prompt: Daintree appends an instruction carrying a `DAINTREE-DONE-<code>` marker pair it minted, and reports the agent's summary once the closing marker appears on screen. An observation only, and it changes nothing about how an agent is launched (#12488). |
| System memory-pressure notice | **APPROVE** | Attribution: tells the user the slowdown is the machine, not the app. A quiet, dismissible notice (#12469). |
| Per-terminal hibernation | **REMOVED** | Overengineering: saved little, broke more, and Chromium already throttles hidden renderers. The live terminal stays the source of truth (#10811). |
| Built-in slash commands and agent instructions | **REMOVED** | CLAUDE.md and AGENTS.md are versioned and agent-specific, and Daintree doesn't write agent config (#4100). |

### Panels and workspace

| Feature Proposal | Decision | Reasoning |
| --- | --- | --- |
| Freeform panel layouts | **REJECT** | Automatic, size-driven layout with dock and maximize is the right shape for monitoring a fleet (#4768). |
| Integrated Browser | **APPROVE** | Localhost preview, console capture, agent-app debugging. Hosts beyond localhost and private networks need the user's approval first. Not a general-purpose browser. |
| Portal (Web Agent Dock) | **APPROVE** | Bridges CLI agents and web agent UIs. Not for viewing GitHub issues or PRs (#9103). |
| Notes Panel | **REJECT (core)** | Removed in #5629: it drifted into an app-within-an-app and the save bug was architectural. A notes plugin is fine (#5538); in core, Markdown files in the worktree cover it. |
| Terminal Scratchpad | **APPROVE** | Not the Notes Panel. Scoped to one terminal and disposable by design: the notes ride that terminal's own record, move with it across worktrees, survive a restart, and are deleted when the terminal is permanently removed. No document list, no cross-terminal store, no agent-facing surface (#12835). |
| Project onboarding wizard | **REMOVED** | Open the folder, show the code immediately, decorate later (#6750). |
| Daintree Tour and plugin tours | **APPROVE** | Stylized animated mocks built from the UI kit, never screenshots (#12775). |
| npm Script Runner (Quick Run) | **APPROVE (bounded)** | Detects scripts from package.json, Makefile, justfile, Taskfile and composer.json and runs them in a terminal. Never edits the manifest. |
| Productivity insights tab | **REJECT** | IDE analytics, not orchestration. Demands manual review of stats; fails Cost of Attention (#4330). |

### Context and review

| Feature Proposal | Decision | Reasoning |
| --- | --- | --- |
| Read-Only File Viewer | **APPROVE** | Accelerates context and review. Read-only with syntax highlighting for reviewing agent output. Not a code editor. |
| Code Editing in FileViewer | **REJECT** | Red Light: reinvents code editor. Workshop feature. Read-only is the line. |
| Markdown editing (built-in plugin) | **APPROVE (bounded)** | Plans, specs, checklists and drafts are the working documents of an agent workflow — prose artefacts, not code. A plain-text Edit mode for Markdown files, shipped as a built-in plugin with a revision-checked save and draft recovery, removes the round trip to another app. The Markdown allowlist is the boundary: Source stays read-only, code editing stays rejected, and widening to other file types is a separate decision (#12323). |
| Element Picker (dev preview) | **APPROVE (bounded)** | Select an element in the live dev preview, trace it as far as the page's framework lets us, and hand it to the user's agent. It is a selection and handoff tool and writes nothing; the agent edits (#12441). It began as the SvelteKit Tools built-in plugin and moved into the dev preview when it went multi-framework (#13867): the CDP guest and the source host it needs had no plugin hook (`previewTools` and `guestAdapters` existed for it alone and were built-in only), so the plugin surface was carrying a core feature. Passive only: nothing is injected into the user's project, and a framework that exposes nothing gets DOM-level picking rather than a guess. A bounded direct-edit path was approved at design time and removed before it shipped because nothing called it (`3f22bdebad`). Bringing source writes back is a fresh decision. |
| Cross-Worktree Diff | **APPROVE** | Manages multiplicity. Provides omniscience. Unique to orchestration. |
| Diff notes sent to an agent | **APPROVE (bounded)** | A review handoff, not a notes store: sent notes clear, only agent terminals are offered, and it pastes without pressing Enter (#12818). |
| Review Hub | **APPROVE** | Shortens review. Stage, commit, push, PR status and checks. Not a full Git GUI. |
| Review marks | **APPROVE (bounded)** | Mark a worktree reviewed at the commit, index and working tree Review Hub displayed, then see how much is new since. Shortens the next round of review. Daintree's own state, kept on the host and never written to the repository; anything that can't be proven unchanged counts as changed, and an incomplete comparison says so instead of "nothing new". A fact about content, never a verdict that the work is reviewed or safe: off the MCP surface and out of the readiness rail (#14580, #14585). |
| Worktree Git operations | **APPROVE (bounded)** | Pull, push, force-with-lease, rebase onto base, merge base in, continue and abort from the worktree card, with the pull, push, rebase and merge rows previewing their real commit set. Getting the base into a worktree shouldn't mean dropping to a terminal (#12098). |
| Discard changes and delete file | **APPROVE (bounded)** | From file rows, behind a confirm, deleted files to the OS Trash, folders and conflicted files excluded (#13435). |
| Merge Conflict Resolution | **APPROVE (bounded)** | Whole-file ours or theirs, a leftover-marker check, mark resolved, continue or abort (#12909). Hunk-level and three-way merge editing stays in the editor. |
| Git Graph/Tree | **REJECT** | Red Light: reinvents Git GUI. Too much visual noise. |
| PR Context in Review Hub | **APPROVE (Read + bounded merge)** | PR number, state, CI rollup and check names on worktree cards and the Review Hub, unresolved review-thread counts per file (count only, #7777), failing checks sendable to an agent, and any pending auto-merge or merge-queue entry GitHub reports, whoever armed it. The one write is merge: arm "merge when ready", cancel it, or merge immediately, each behind a confirm that previews what lands and pinned to the reviewed head (#13747). GitHub decides if and when it merges; Daintree never waits on CI and merges itself. Click-through opens the forge for anything deeper. |
| Native PR Review Threads | **REJECT** | Workshop feature. Reinvents the forge's review UI inside the orchestration layer. Send users to the forge or their editor. |
| Chat History Search | **REMOVED** | Recording transcripts cost CPU on every byte of output, and the agent CLIs keep their own sessions, most of them resumable. Daintree keeps a resume-session palette and prompt history instead. |

### Automation and the control surface

| Feature Proposal | Decision | Reasoning |
| --- | --- | --- |
| Terminal Recipes | **APPROVE** | Enables automation. Repeatable multi-agent setups reduce manual panel configuration. |
| Reintroducing the DAG Workflow Engine | **REJECT** | Removed in #4623 (#4580): zero usage, ~8,000 lines of maintenance, and it bypassed the action system entirely. Scoped to the old DAG engine only — orchestration now runs on agents driving Daintree over MCP, and terminal recipes and worktree actions like `workflow.startWorkOnIssue` stay core. |
| MCP control surface | **APPROVE (budgeted)** | Only what Daintree alone can do, sized to what clients tolerate: the external surface was cut from 100 tools to 23 (#11592), and in-app tiers split into Core and Full (#12839). |
| Native in-app assistant runtime | **REJECT** | The assistant stays a standard agent CLI; Daintree stays a terminal manager (#10649). A native React surface over a bundled engine was closed in favour of better Claude Code and Codex support (#12189). |
| Daintree Assistant | **APPROVE** | The user's own agent CLI in the help panel with Daintree's MCP tools, docs and runbooks. Orchestration-aware without a bespoke chat UI. |
| Scheduled agent runs | **APPROVE (bounded)** | A project schedule launches one agent as an ordinary, visible terminal, records every run (skips included) and resumes like any historic chat, replacing OS jobs that run agents where nobody can see them (#15973). Schedules live in local per-project data, never the repository's `.daintree/`, so a `git pull` can't add an unattended job. Settlement acts on process exits, printed markers and precondition exit codes, never heuristic agent state. No MCP tools, no recipes, no Remote Hosts, and Daintree never wakes a sleeping machine on macOS or Linux. |
| Voice Input | **APPROVE** | Bridges gap. Hands-free delegation while monitoring other agents. Accessibility value. |

### Platform

| Feature Proposal | Decision | Reasoning |
| --- | --- | --- |
| Plugin platform | **APPROVE** | The release valve for everything outside the core. Capability-gated and consent-gated; distribution is curated, not a marketplace (#9305). |
| Project plugins as full applications | **APPROVE** | A project, a plugin, agent instructions and a data store can replace a SaaS tool, with agents working on the same data the panel renders (#12842). |
| Time tracking | **REJECT (core)** | A plugin, not core (#5538). |
| Remote Hosts | **APPROVE** | Run the whole backend on another machine and drive it from this one, the proper version of running separate copies over remote desktop (#11158, #12838). |
| First-class WSL execution | **APPROVE (as Remote Hosts)** | Had to be core because plugins have no hook for it (#12830). Windows drives Linux Hosts inside WSL rather than gaining a second execution layer (#13431). |

### Identity and comfort

| Feature Proposal | Decision | Reasoning |
| --- | --- | --- |
| Theme System | **APPROVE** | Reinforces identity, serves comfort and accessibility, differentiates Daintree. 15 built-in themes, colour-vision modes, reduced motion, and the OS increased-contrast setting respected. |
| Custom Themes | **APPROVE** | Theme JSON import and export plus an accent override. Natural extension of the theme system. |
| Random Theme Cycler | **APPROVE** | Habitat principle: helps users discover the theme that feels right. |
| Streak coaching and missed-day visuals | **REMOVED** | Guilt pressure in a product meant to feel calm; coaching now leads with outcomes (#11182). |
| Milestone toasts and confetti | **REMOVED** | The app stays clean and quiet instead of praising the user for doing their work (#12840). |
| Settings with 10 toggles | **REJECT** | Red Light: excessive configuration. Feature should work out of the box. |

## Architectural Requirements

The basic shape is still Main service → IPC → renderer store → UI, but that is the on-ramp, not the whole picture: utility-process hosts, per-project views, plugin workers and Remote Hosts all sit in the path. `docs/development.md` and `docs/architecture/` are the reference; this list is what a feature must satisfy.

- **Action-integrated** — Registered in the action system for keybindings, palette and menus. Whether it is also exposed over MCP is a separate decision against the MCP budget.
- **Per project view** — Each project has its own renderer and V8 context, evicted under memory pressure. Renderer state belongs to one view; anything shared crosses through Main. Works with multiple windows.
- **Host-aware** — Every IPC channel declares where it runs, so the feature works when the backend is on a Remote Host.
- **Validated at its boundary** — Untrusted input is checked where it crosses: action arguments against their schema, IPC at the envelope, plugin manifests against theirs.
- **Resilient** — Error handling and graceful degradation; survives a crashed utility process and a restart.
- **Cross-platform** — macOS, Windows and Linux, per the priorities below.
- **Plugin-first considered** — If it could be a plugin, [Core or Plugin?](#core-or-plugin) has been answered.

## Platform Priority

Daintree targets all three desktop platforms, but not equally:

- **macOS** — Primary development platform. First-class support. All features tested here first, and the local E2E run comes first in any cross-platform sweep.
- **Linux** — Important for developer adoption, including arm64. PR CI runs on Ubuntu (static checks, lint, unit shards, build and smoke) but no E2E; Linux E2E runs in the release workflow and the on-demand `stabilize` sweep.
- **Windows** — Supported, behind macOS. Windows E2E runs in the release workflow and `stabilize`, not on every PR. Windows can't host Remote Hosts; it drives Linux Hosts inside WSL. Expect friction with native modules and ConPTY.

"Cross-platform" means features must not break on any platform, but macOS is where the bar is set.

## AI-Augmented Development

Daintree is built by a solo developer augmented by AI coding agents — the same agents Daintree orchestrates. This means:

1. **Higher throughput than traditional solo dev** — But maintenance burden is still real. Every feature must be maintained across 3 platforms and remote hosts, and kept compatible with 17 agent CLIs that each update independently.

2. **A new native module needs a case JavaScript can't make** — `node-pty` set the bar. The native modules that ship today each earned their place with a crash-safety or platform fact: process-tree cleanup, the app database, file watching, voice activity detection, memory measurement. Prefer Node built-ins where they exist (plugin databases use `node:sqlite`).

3. **Derive, don't store** — Git and the folder are the source of truth for anything they can answer. Persist only app-owned state, through the two existing engines (better-sqlite3 + drizzle, and electron-store), and never sync state that can be derived from the worktree.

4. **Opinionated integrations** — Support the CLIs that matter (Claude, OpenCode, Aider, Gemini, Antigravity, Codex, Grok, Cursor, GitHub Copilot, Goose, Amp, Crush, Qwen Code, Kimi Code, Open Interpreter, Mistral Vibe, Kiro) and support them _deeply_ through the agent registry (`shared/config/agentIds.ts`, `shared/config/agents/`, `shared/config/agentRegistry.ts`). Gemini CLI is deprecated in favour of Antigravity for consumer accounts (#8811). Plugins and users can add agents, but never shadow a built-in. Don't try to support every AI tool generically.

5. **Maintenance budget** — If a feature can't justify its ongoing cost across platforms, hosts and agent updates, reject it. The ratchets in `scripts/baselines/` and the MCP wire budget make some of that cost visible; most of it is attention. Per-agent matchers are the most expensive kind: a distinction that only works by pattern-matching each agent's rendering has to be maintained for every CLI as each one updates, so it has to be worth that and degrade to the plain state when a matcher misses (#4871).

## Feature Evaluation Checklist

Before implementing any feature in core or as a built-in plugin, verify:

- [ ] Crosses none of the [Hard Lines](#the-hard-lines)
- [ ] Core or plugin decided, with the reason
- [ ] Not something the agent CLIs already do, or it adds cross-agent context they can't
- [ ] Passes Cost of Attention test (reduces net cognitive load)
- [ ] Passes Green Light test (2+ criteria, at least one from the first six)
- [ ] Passes Red Light test (no triggers)
- [ ] Belongs in the Orchestration Layer, not Workshop
- [ ] At "Assisted" automation level or higher (or a context or review interaction that replaces a slower round trip), and automation acts on facts
- [ ] Action-integrated; MCP exposure decided separately
- [ ] Works per project view, with multiple windows, and on a Remote Host
- [ ] Cross-platform compatible (won't break on any OS)
- [ ] No new native module without a case
- [ ] Ships with opinionated defaults (settings are optional, not required)
- [ ] Can't be solved with a shell alias
- [ ] Sustainable maintenance burden

## Evaluating a proposal

There's no automated evaluation command — work each proposal through the checklist above by hand, defaulting to **NO**. A feature has to clearly pass before it ships:

1. **Existence check** — Does it already exist, in core, in a plugin, or in the agent CLIs?
2. **Hard lines** — Does it cross any? Then stop.
3. **Mission alignment** — Does it fit Daintree's purpose, and is it core or a plugin?
4. **Architectural fit** — Does it meet the requirements above?
5. **Implementation complexity** — What's the effort and risk?
6. **Value assessment** — Is the value worth the ongoing maintenance cost?

When it's decided either way, add or update its row in the [Decision Log](#decision-log) with the issue number. Rows that describe a feature as it used to be are how this file drifts.

## Remember

- Daintree is opinionated. Not every good feature belongs here, and not every good feature belongs in core.
- Feature bloat is the new technical debt.
- Just because we _can_ build something doesn't mean we _should_.
- The goal is a focused, cohesive tool for AI agent orchestration, not a general-purpose IDE.
- Every feature must justify itself against: "Could the user just switch to their terminal, their editor, or their agent for this?"
- Themes, visual identity, and polish are not cruft — they're what make Daintree feel like a real product instead of a web page.
