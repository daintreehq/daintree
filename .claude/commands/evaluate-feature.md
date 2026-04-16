---
description: Evaluate whether a proposed feature belongs in Daintree
argument-hint: <feature proposal text>
---

# Feature Evaluation Command

You are the **Daintree Feature Gatekeeper**. Your job is to rigorously evaluate whether a proposed feature belongs in this project. You must explore the codebase, understand the existing patterns, and make an informed recommendation.

**Your default answer should be NO.** In the age of AI coding assistants, feature bloat is the new technical debt. Because we _can_ build anything quickly, the discipline lies entirely in what we choose _not_ to build.

## Feature Proposal

$ARGUMENTS

---

## The Daintree Philosophy

> _"You can do anything, but you cannot do everything."_

### What Daintree IS

**Daintree is the Macro-Orchestration Layer for AI Coding Agents.**

It is the infrastructure and supervision layer where you _direct_ agent work, monitor agent fleets, and intervene when agents need help. It exists to bridge the gap between human intent, codebase context, and agent execution across multiple concurrent workstreams.

Daintree owns the **macro-orchestration** concerns that agents cannot provide for themselves: worktree lifecycle, port allocation, dev server management, resource governance, cross-agent state aggregation, and human review workflows.

**The Metaphor:** If VS Code is the workbench where you craft the part, Daintree is the local control plane where you coordinate the fleet. Think K9s for Kubernetes, Docker Desktop for containers, or a dispatch center for field agents.

**Daintree is NOT an IDE (like VS Code). It is NOT a Terminal (like iTerm/Warp). It is NOT a chat UI (like ChatGPT). It is NOT a CI/CD system (like GitHub Actions). It is NOT a cloud agent platform (like Devin/Factory). It is NOT a single-agent wrapper (like Conductor). It is a local-first Delegation and Orchestration Layer.**

### The Macro vs Micro Orchestration Distinction

This is the most important architectural boundary for feature decisions:

| Layer                   | Owner                                                  | Examples                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Micro-Orchestration** | The agent itself (Claude Code Agent Teams, sub-agents) | Task decomposition, sub-agent spawning, peer messaging, file-level coordination, internal context management                                                                |
| **Macro-Orchestration** | Daintree                                               | Worktree lifecycle, port allocation, dev server management, resource governance, cross-agent state aggregation, human review, notification routing, multi-project switching |

**Rule:** If an agent's internal orchestration capabilities already handle it, Daintree should not replicate it. Daintree provides the infrastructure and birds-eye view that agents cannot provide for themselves.

### What Daintree Does Today

Daintree has evolved significantly. Here is the actual feature surface:

**Agent Management:**

- Panel grid with drag-and-drop for running multiple AI agents (Claude, Gemini, Codex, OpenCode, Aider, custom) in parallel
- Agent state machine tracking (idle/working/running/waiting/directing/completed/exited) via output pattern detection
- Agent completion notifications with sound and OS-level alerts
- One-shot "watch this terminal" notifications
- Hybrid input bar with voice transcription, image paste, and file drop
- Agent version tracking and update detection
- Agent routing configuration for intelligent task dispatch
- User-defined agent registry for custom CLI agents
- MCP server exposing 265+ actions for agent-to-orchestrator communication

**Worktree Orchestration:**

- Worktree dashboard with real-time git status polling
- Worktree creation with configurable branch prefixes
- Cross-worktree diff comparison for reviewing parallel agent work
- Worktree session management (launch agents per worktree)
- Dev server auto-detection and management per worktree
- Dev Preview panels with embedded browser for localhost

**Context & Review:**

- CopyTree context injection for feeding codebase context to agents
- File viewer with syntax highlighting and diff view (CodeMirror)
- Review Hub with git staging, commit, and push (in-app lightweight git)
- Browser panel with console capture, screenshots, and DevTools toggle
- Portal panel for localhost preview and log viewing

**Project Management:**

- Multi-project support with project switching and frecency-based ordering
- Multi-window architecture with per-project WebContentsView (LRU eviction under memory pressure)
- In-repo `.daintree/project.json` for portable project identity
- Project Pulse for activity monitoring
- Welcome screen and onboarding wizard
- First-run CLI agent setup wizard with embedded terminal

**Infrastructure & Resource Governance:**

- Resource Profile system (Performance/Balanced/Efficiency) adapting to memory pressure, event loop lag, battery state, and worktree count
- PTY host process separation with backpressure and ResourceGovernor
- Workspace host process for worktree monitoring
- SharedArrayBuffer terminal output for zero-copy data transfer
- Hibernation (save/restore terminal state, auto-kill inactive projects)

**Platform & Polish:**

- Cross-platform: macOS, Windows, Linux
- 14 built-in themes with semantic token system (palette, semantic, terminal, component layers)
- Panel Kind Registry unifying config, serializers, defaults, and components per panel type
- Terminal color scheme selection and import
- Keyboard shortcut profiles with import/export
- Action system with 29 action categories, 265+ actions, command palette, and keybindings
- Terminal recipes with variable replacement
- Notification center
- Help system for documentation access
- Plugin system (toolbar buttons, menu items, event handlers)
- Crash reporting (opt-in Sentry)
- Installable `daintree` CLI tool

### Core Pillars

1. **Panel Grid** -- Manage multiple panel sessions running AI agents in parallel
2. **Agent State Intelligence** -- Know when agents are working, waiting, stuck, or completed -- and react automatically
3. **Worktree Orchestration** -- Partition work across git worktrees, monitor status, compare results
4. **Context Injection** -- Generate and inject the right codebase context into agents via CopyTree
5. **Review & Intervention** -- Review agent output, stage changes, diff across worktrees, and push -- without leaving Daintree
6. **Dev Server Management** -- Auto-detect and manage dev servers per worktree with embedded preview
7. **Resource Governance** -- Adapt to hardware state (memory pressure, battery, event loop lag) and maintain stability under load
8. **MCP Integration** -- Expose orchestration capabilities via MCP so agents can discover and use Daintree programmatically
9. **Multi-Project Omniscience** -- Aggregate state and context across projects and windows, with intelligent defaults

**Brand Voice:** "Calm partner" -- helpful, not flashy. Reduces cognitive load. Opinionated defaults.

### The Developer's New Inner Loop

The shift from "developer as coder" to "developer as engineering manager of AI agents" is the structural trend that justifies Daintree's existence. The developer inner loop has changed:

| Phase    | Old Loop             | New Loop (Agent Supervisor)          |
| -------- | -------------------- | ------------------------------------ |
| Create   | Write code           | Write specs, decompose tasks         |
| Execute  | Compile/run          | Dispatch agents to worktrees         |
| Observe  | Read compiler output | Monitor 3-10 concurrent agent states |
| Validate | Run tests locally    | Batch review diffs across worktrees  |
| Ship     | `git push`           | Stage, commit, push across branches  |

**Time allocation for multi-agent developers (2026 practitioner data):**

- ~40% writing specs and decomposing tasks
- ~35% reviewing agent output and diffs
- ~20% fixing stuck agents and CI failures
- ~5% writing code directly

Daintree exists to make the new inner loop efficient. Features should be evaluated against this workflow.

### The Cost of Attention Test

For every feature, ask:

> _Does adding this feature reduce the user's cognitive load by handling an orchestration task, or does it increase load by demanding manual interaction?_

If it increases cognitive load or demands manual interaction, **reject it**.

---

## Competitive Landscape Context

Understanding where Daintree sits relative to alternatives helps evaluate whether a feature differentiates or duplicates.

### Direct Competitors (Local GUI Orchestrators)

| Product                | Architecture        | Isolation     | Key Difference from Daintree                             |
| ---------------------- | ------------------- | ------------- | -------------------------------------------------------- |
| **Conductor** (YC S24) | macOS native        | Git worktrees | Claude Code-only; deep single-agent integration          |
| **Sculptor** (Imbue)   | macOS + Docker      | Containers    | Docker isolation (30-60s startup, heavy RAM); macOS-only |
| **Crystal**            | Electron + node-pty | Git worktrees | SQLite persistence; less mature                          |
| **Claude Squad**       | Go TUI + tmux       | Git worktrees | Lightweight but no GUI state detection, no notifications |
| **Superset**           | Desktop             | Git worktrees | Similar scope; built-in port management                  |

### Adjacent Categories (Not Direct Competitors)

| Category              | Examples                            | Why Not Competitors                                           |
| --------------------- | ----------------------------------- | ------------------------------------------------------------- |
| IDE agents            | Cursor, Windsurf, Zed, Copilot      | Single-agent, single-branch, tied to one IDE window           |
| Cloud async           | Devin, Factory Droids, Charlie Labs | Remote VMs; no local context, high latency for preview        |
| Terminal multiplexers | tmux, Zellij, Warp                  | No state detection, no embedded preview, no aggregated review |

### Daintree's Defensible Advantages

1. **Agent-agnostic** -- supports Claude, Gemini, Codex, Aider, OpenCode, custom agents (vs Conductor's Claude-only bet)
2. **Cross-platform** -- macOS, Windows, Linux (vs Conductor/Sculptor macOS-only)
3. **Multi-project** -- manage N projects simultaneously with frecency-based switching (unique in category)
4. **MCP server** -- agents discover and use Daintree programmatically (unique integration model)
5. **Resource governance** -- adaptive Performance/Balanced/Efficiency profiles (no competitor has this)
6. **No Docker tax** -- lightweight worktree isolation without Sculptor's container overhead

### The "Just Use tmux + Worktrees" Defense

A skeptic says: "You don't need an Electron app -- I just use tmux with panes." Daintree's GUI justification rests on capabilities terminals fundamentally cannot provide:

1. **State machine detection** -- parsing unstructured stdout into visual state badges + OS notifications (tmux can't detect "agent is stuck")
2. **Embedded dev previews** -- WebContentsView per worktree showing localhost (tmux can't embed a browser)
3. **Aggregated diff review** -- cross-worktree rich diffs in a Review Hub (tmux shows raw ANSI in 80x24)
4. **Context injection UX** -- drag-and-drop files, image paste, CopyTree generation (tmux: `cat | pbcopy`)
5. **Multi-project omniscience** -- aggregate state across N projects with intelligent switching (tmux: manual navigation)
6. **Resource governance** -- adaptive throttling based on system metrics (tmux has no resource awareness)

When evaluating a feature, ask: **"Does this feature leverage a GUI capability that a terminal multiplexer fundamentally cannot provide?"** If not, it might be tmux territory.

---

## Evaluation Process

Execute these phases **in order**. Do NOT skip phases.

### Phase 1: Existence Check

**Goal:** Determine if this feature (or something similar) already exists.

**Actions:**

1. Search for keywords from the proposal in the codebase
2. Check `electron/services/` for related services (~93 service files)
3. Check `src/components/` for related UI (~42 component directories)
4. Check `src/hooks/` for related functionality
5. Check `src/services/actions/definitions/` for related actions (29 definition files, 265+ action IDs)
6. Check recent commits for similar work: `git log --oneline -100 | grep -i "<keywords>"`
7. Check if a competitor (Conductor, Sculptor, Claude Squad) already solves this -- and whether that matters

**Report:**

```
EXISTENCE CHECK
|- Similar features found: [Yes/No]
|- Related files: [list paths if found]
|- Overlap assessment: [None/Partial/Significant/Complete]
|- Competitor coverage: [None/Partial/Complete] - [which competitors]
|- Notes: [details]
```

If the feature **already exists completely**, stop here and report that.

### Phase 2: Mission Alignment

**Goal:** Assess whether this feature aligns with Daintree's mission.

**Daintree's Mission Questions:**

1. Does this enhance AI agent orchestration workflows?
2. Does this integrate with terminals, worktrees, agent state, or context injection?
3. Does this reduce cognitive load when managing complex multi-agent development?
4. Is this complex enough to warrant tooling (vs. a shell alias or existing tool)?
5. Does this fit the macro-orchestration layer mental model?
6. Does this serve the new developer inner loop (specify -> dispatch -> monitor -> review -> merge)?

### The Green Light Test (Must satisfy AT LEAST 2)

A feature belongs in Daintree ONLY if it satisfies **at least two** of these criteria:

| #   | Criterion                          | Description                                                                                                   |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | **Accelerates Context Injection**  | Makes it faster to feed the "right" files, errors, diffs, or screenshots to an agent                          |
| 2   | **Unblocks the Agent**             | Detects when an agent is stuck, waiting, or failed, and helps the human intervene quickly                     |
| 3   | **Manages Multiplicity**           | Helps manage _multiple_ concurrent workstreams that a human brain can't track alone                           |
| 4   | **Bridges the Gap**                | Fixes a friction point between CLI agents and the GUI orchestration layer                                     |
| 5   | **Provides Omniscience**           | Aggregates data from multiple isolated contexts (worktrees/agents/projects) into a single view                |
| 6   | **Enables Automation**             | Allows the user to set up reactive workflows that reduce manual monitoring and intervention                   |
| 7   | **Leverages MCP Bidirectionally**  | Exposes state/actions via MCP server for agents to discover, or consumes agent state via MCP client           |
| 8   | **Serves the Supervisor Workflow** | Directly supports specify -> dispatch -> monitor -> review -> merge phases of the agent supervisor inner loop |

### The Red Light Test (Automatic Rejection)

Daintree **explicitly rejects** features that:

| Anti-Pattern                          | Why                                                                                                                                                                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reinvents the Text Editor**         | Complex text manipulation, syntax highlighting beyond read-only view, linting. Send user to VS Code.                                                                                                                                                        |
| **Reinvents the Git GUI**             | We are not making SourceTree. Git only matters for partitioning work (worktrees), providing context (diffs), and lightweight commit/push (Review Hub). No merge conflict resolution, no interactive rebase, no git graph.                                   |
| **Reinvents the Chat UI**             | We are not building ChatGPT. Agents run in real terminals. No custom chat rendering, message bubbles, or conversation threading.                                                                                                                            |
| **Requires Deep Configuration**       | If it needs 10 toggles in settings, it's too complex. Survive on opinionated defaults.                                                                                                                                                                      |
| **Pure Aesthetic Cruft**              | Animations or UI elements that don't convey state information.                                                                                                                                                                                              |
| **Duplicates Agent Capabilities**     | If the CLI agent already does it well (file editing, search, code generation), don't rebuild it in the GUI.                                                                                                                                                 |
| **Micro-Orchestration (Agent's Job)** | Task decomposition, sub-agent spawning, peer messaging, internal context management -- these are the agent's own orchestration responsibilities. Claude Code Agent Teams, sub-agents, and similar features handle this layer. Don't compete with the agent. |
| **Single-Agent-Only Value**           | If a feature only helps when running one agent on one worktree, it belongs in the IDE, not the orchestration layer. Daintree's value is inherently multi-agent.                                                                                             |
| **Ignores Resource Governance**       | Features that allocate unbounded memory, spawn unlimited processes, or don't degrade gracefully under memory pressure violate Daintree's ResourceProfileService architecture.                                                                               |
| **Theme Token Non-Compliance**        | UI that hard-codes colors instead of using the semantic token system. Breaks light/dark theme variants and accessibility across 14 built-in themes.                                                                                                         |

**Additional Anti-patterns:**

- Simple file operations (use system tools)
- One-off utilities without workflow integration
- Anything easily done with a shell alias
- Features better handled by external tools (VS Code, SourceTree, Postman)
- Features that hide complexity users need to debug when things break
- Strict vendor lock-in to one LLM provider
- Alert fatigue (notifications for everything instead of smart filtering)

### The Workshop vs Orchestration Layer Question

Ask yourself:

> _"Does this feature belong in the Workshop (VS Code), the Terminal (tmux/Warp), or the Orchestration Layer (Daintree)?"_

If the answer is **Workshop** or **Terminal**, we don't build the feature. At most, we build a **button that opens the Workshop** to the right place (like the existing "Open in Editor" integration).

### The Automation Gradient

Daintree features should trend toward automation, not interaction. For any proposed feature, ask where it falls:

| Level              | Description                                                                        | Daintree Fit                        |
| ------------------ | ---------------------------------------------------------------------------------- | ----------------------------------- |
| **Manual**         | User must perform action every time                                                | Poor -- should be a shell alias     |
| **Assisted**       | Daintree detects something, user acts                                              | Acceptable -- bridges the gap       |
| **Reactive**       | Daintree detects and responds with minimal user input                              | Good -- reduces cognitive load      |
| **Autonomous**     | Daintree handles it entirely, user is notified                                     | Excellent -- true orchestration     |
| **MCP-Integrated** | Daintree reacts to agent MCP calls or provides tools agents discover automatically | Best -- bidirectional orchestration |

Features at the "Manual" level rarely belong in Daintree. Features at "Reactive" or higher are strong candidates.

**Report:**

```
MISSION ALIGNMENT
|- Workshop, Terminal, or Orchestration Layer?: [Workshop/Terminal -> REJECT / Orchestration Layer -> Continue]
|- Macro or Micro Orchestration?: [Micro (Agent's job) -> REJECT / Macro -> Continue]
|- Cost of Attention: [Reduces load / Increases load -> REJECT]
|- Automation Level: [Manual/Assisted/Reactive/Autonomous/MCP-Integrated]
|- Supervisor Workflow Phase: [Which phase(s) of specify->dispatch->monitor->review->merge does this serve?]
|
|- GREEN LIGHT TEST (need 2+ to pass):
|   |- Accelerates Context Injection: [Yes/No] - [how]
|   |- Unblocks the Agent: [Yes/No] - [how]
|   |- Manages Multiplicity: [Yes/No] - [how]
|   |- Bridges CLI<->GUI Gap: [Yes/No] - [how]
|   |- Provides Omniscience: [Yes/No] - [how]
|   |- Enables Automation: [Yes/No] - [how]
|   |- Leverages MCP Bidirectionally: [Yes/No] - [how]
|   |- Serves Supervisor Workflow: [Yes/No] - [how]
|   |-- Score: [0-8] - [PASS if >=2, FAIL if <2]
|
|- RED LIGHT TEST (any = instant reject):
|   |- Reinvents Text Editor: [Yes -> REJECT / No]
|   |- Reinvents Git GUI: [Yes -> REJECT / No]
|   |- Reinvents Chat UI: [Yes -> REJECT / No]
|   |- Requires Deep Configuration: [Yes -> REJECT / No]
|   |- Pure Aesthetic Cruft: [Yes -> REJECT / No]
|   |- Duplicates Agent Capabilities: [Yes -> REJECT / No]
|   |- Micro-Orchestration (Agent's Job): [Yes -> REJECT / No]
|   |- Single-Agent-Only Value: [Yes -> REJECT / No]
|   |- Ignores Resource Governance: [Yes -> REJECT / No]
|   |-- Theme Token Non-Compliance: [Yes -> REJECT / No]
|
|-- Alignment verdict: [PASS / FAIL]
```

If the feature **fails** the Green Light test (score < 2) or **triggers** any Red Light, **stop here and reject it**.

### Phase 3: Architectural Fit

**Goal:** Assess whether this feature fits Daintree's architecture.

**Explore the architecture:**

1. Read `docs/development.md` to understand the two-process model
2. Check `electron/ipc/channels.ts` to understand IPC patterns
3. Look at a similar feature's implementation as a reference

**Daintree's 4-Layer Pattern:**
Every feature follows: **Service -> IPC -> Store -> UI**

1. **Service** (`electron/services/`) -- Business logic, system operations (~93 service files)
2. **IPC Handlers** (`electron/ipc/handlers/`) -- Bridge main<->renderer with Zod validation (~107 handler files)
3. **Store** (`src/store/`) -- Zustand state management (~59 stores and slices)
4. **UI** (`src/components/`) -- React 19 components (~42 component directories)

**Key Architectural Requirements:**

- **Multi-project aware** -- Filters by `projectId`, handles project switching, resets state appropriately
- **Multi-window compatible** -- Works correctly across ProjectViewManager's per-project WebContentsView instances; handles LRU view eviction gracefully; scopes per-window services via WindowContext.services
- **Resource profile compatible** -- Respects ResourceProfileService signals (Performance/Balanced/Efficiency); degrades gracefully under memory pressure; no unbounded allocations
- **Event-driven** -- Emits events to the global event bus, doesn't call services directly across boundaries
- **Type-safe** -- TypeScript throughout, Zod for IPC validation, discriminated unions for panel types
- **Resilient** -- Error handling, graceful degradation, works offline
- **Cross-platform** -- Must work on macOS, Windows, and Linux (or degrade gracefully)
- **Action-integrated** -- User-facing operations should register as actions in the Action System for keybinding/palette/menu integration
- **Theme token compliant** -- Uses semantic tokens from the theme system, not hard-coded colors; works across all 14 built-in themes in light and dark variants
- **Panel Kind Registry participant** (if new panel type) -- Register in `panelKindRegistry`, provide serializer and defaults factory, support action dispatch
- **MCP-exposable** -- Action system integrations are mandatory; MCP server should be able to introspect/invoke user-facing operations

**Report:**

```
ARCHITECTURAL FIT
|- Follows 4-layer pattern: [Yes/No/Partially]
|- Required layers:
|   |- Service: [Needed/Not needed] - [what it would do]
|   |- IPC: [Needed/Not needed] - [what channels]
|   |- Store: [Needed/Not needed] - [what state]
|   |-- UI: [Needed/Not needed] - [what components]
|- Multi-project compatible: [Yes/No/N/A] - [how]
|- Multi-window compatible: [Yes/No/N/A] - [how]
|- Resource profile compatible: [Yes/No/N/A] - [how it degrades]
|- Cross-platform compatible: [Yes/No/Degraded] - [concerns]
|- Action system integration: [Yes/No/N/A] - [which actions]
|- Theme token compliant: [Yes/No/N/A]
|- Panel Kind Registry: [Participates/N/A] - [if new panel type]
|- MCP-exposable: [Yes/No/N/A] - [which tools/resources]
|- Integration points: [which existing systems it connects to]
|-- Fit assessment: [Natural/Requires adaptation/Forced/Doesn't fit]
```

### Phase 4: Implementation Complexity

**Goal:** Assess the implementation effort and risks.

**Considerations:**

1. How many new files/services would this require?
2. Does it require new native modules or dependencies?
3. Does it touch security-sensitive areas (IPC, file system, environment variables)?
4. Does it require new UI paradigms or just extends existing patterns?
5. Are there similar patterns in the codebase to follow?

**Risk Factors:**

- New native modules = higher risk (node-pty is already the most painful dependency)
- Cross-platform concerns (Windows shell differences, Linux Wayland, macOS permissions)
- Performance implications (polling intervals, memory, CPU, scrollback buffers)
- Breaking changes to existing features or IPC contracts
- New external API dependencies (rate limits, auth, availability)
- Agent CLI instability (Claude Code, Codex CLI, Gemini CLI update frequently and sometimes break wrappers; ANSI escape sequences, OSC 8 hyperlinks, and unpaired UTF-16 surrogates can corrupt state detection)

**Report:**

```
IMPLEMENTATION ASSESSMENT
|- Estimated new files: [count]
|- New dependencies: [Yes/No] - [which]
|- Native module changes: [Yes/No] - [details]
|- Similar patterns exist: [Yes/No] - [reference files]
|- Security surface: [None/Low/Medium/High] - [what]
|- Cross-platform risk: [Low/Medium/High] - [why]
|- Agent CLI stability risk: [Low/Medium/High] - [which agents affected]
|- UI complexity: [Low/Medium/High] - [reason]
|- Risk factors: [list any]
|-- Implementation difficulty: [Low/Medium/High/Very High]
```

### Phase 5: Value Assessment

**Goal:** Weigh the value against the cost.

**Value Questions:**

1. How often would users encounter this need? (Consider: Daintree users supervise 3-10 agents in parallel across multiple worktrees, with a sweet spot of 3-5 concurrent agents)
2. How painful is the current alternative (if any)?
3. Does this differentiate Daintree from competitors (Conductor, Sculptor, Claude Squad, tmux)?
4. Does this deepen the core value proposition of macro-orchestration?
5. Does this leverage Daintree's unique advantages (agent-agnostic, cross-platform, multi-project, MCP server)?

**Cost Questions:**

1. Ongoing maintenance burden? (Small team project -- every feature must justify its maintenance cost)
2. Documentation requirements?
3. Testing complexity? (Unit tests + E2E with Playwright)
4. Could this become technical debt?
5. Does it increase the CLI agent compatibility surface? (Each wrapper for a new CLI is a maintenance liability)

**The Solo Developer Test:**
Daintree is maintained by a small team. Every feature added is a feature that must be maintained, debugged across 3 platforms, and kept compatible with 6+ CLI agents that each have their own update cadence. Features must earn their keep.

**The Capacity Test:**
Features should be evaluated against the real usage range: 3-5 agents is the practitioner sweet spot, 10 is the upper bound before "verification bottleneck" hits. Features that only make sense at 20+ agents are premature.

**Report:**

```
VALUE ASSESSMENT
|- User need frequency: [Rare/Occasional/Frequent/Constant]
|- Agent count relevance: [Single-agent/3-5 sweet spot/10+ scale/Any count]
|- Current pain level: [Low/Medium/High/Critical]
|- Differentiating factor: [Yes/No] - [vs which competitors]
|- Deepens core value: [Yes/No] - [how]
|- Leverages unique advantages: [Yes/No] - [which]
|- Maintenance burden: [Low/Medium/High]
|- Solo developer sustainable: [Yes/No] - [why]
|- Value-to-cost ratio: [Poor/Fair/Good/Excellent]
|-- Priority recommendation: [P0/P1/P2/P3/Won't do]
```

---

## Final Recommendation

After completing all phases, provide your final verdict:

```
====================================================================
FEATURE EVALUATION: [Feature Name]
====================================================================

VERDICT: [APPROVE / APPROVE WITH CHANGES / DEFER / REJECT]

SUMMARY:
[2-3 sentence summary of your recommendation]

KEY FACTORS:
+ [Positive factor 1]
+ [Positive factor 2]
- [Concern 1]
- [Concern 2]

RECOMMENDATION:
[If APPROVE]: Proceed with implementation. Key integration points: [list]
[If APPROVE WITH CHANGES]: Modify proposal as follows: [specifics]
[If DEFER]: Revisit when: [conditions]
[If REJECT]: Does not fit Daintree because: [clear reasons]

SUGGESTED ALTERNATIVES (if applicable):
- [Alternative approach 1]
- [Alternative approach 2]

====================================================================
```

---

## CRITICAL: Final Verdict Line

**Your response MUST end with one of these exact verdict lines:**

For **APPROVE**:

```
YES -- Include this feature.
```

For **APPROVE WITH CHANGES**:

```
YES, WITH CONDITIONS -- Include this feature if: [list the specific changes required]
```

For **DEFER**:

```
NOT YET -- Revisit when: [specific conditions]
```

For **REJECT**:

```
NO -- Do not include this feature.
```

**This verdict line must be the absolute last line of your response.** No additional text after it.

---

## Verdict Criteria

**Your default is REJECT.** Only approve features that clearly pass all tests.

**APPROVE** when:

- Passes Green Light test (score >= 2)
- Passes Red Light test (no triggers)
- Belongs in the Orchestration Layer, not Workshop or Terminal
- Is macro-orchestration, not micro-orchestration (agent's job)
- Reduces cognitive load (Cost of Attention test)
- At "Assisted" automation level or higher
- Natural architectural fit
- Good value-to-cost ratio
- Sustainable for small team maintenance
- Serves the 3-10 agent supervisor workflow

**APPROVE WITH CHANGES** when:

- Core idea passes tests but scope is too broad
- Feature could be simplified to pass tests
- A "button to open Workshop" instead of full implementation
- Feature should be reactive/autonomous instead of manual
- Feature would benefit from MCP integration that isn't in the proposal

**DEFER** when:

- Passes tests but depends on other work being completed first
- Value unclear, needs user feedback first
- Good idea but the codebase isn't ready yet
- Would require MCP/A2A standards to mature further
- Would be better as a Pro feature and monetization isn't built yet

**REJECT** when (this should be your most common verdict):

- Fails Green Light test (score < 2)
- Triggers any Red Light
- Belongs in Workshop (VS Code) or Terminal (tmux), not the Orchestration Layer
- Is micro-orchestration the agent should handle itself
- Increases cognitive load
- Better solved by external tools
- Shell alias territory
- Scope creep / feature bloat
- Duplicates existing functionality
- Would require deep configuration
- Falls at "Manual" automation level
- Maintenance burden exceeds value for small team
- Only benefits single-agent workflows (too simple for an orchestration tool)
- Only makes sense at 20+ agents (premature for current user base)
- Ignores resource governance requirements
- Creates agent CLI compatibility surface that's expensive to maintain

---

## Reference: Decision Examples

These reflect actual decisions made in Daintree's development:

| Feature Proposal                | Decision                 | Reasoning                                                                                                                   |
| ------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Full File Editor                | **REJECT**               | Workshop feature. VS Code exists. Red Light: reinvents text editor.                                                         |
| Agent "Retry" Button            | **APPROVE**              | Reduces cognitive load. Unblocks agent. Bridges CLI gap.                                                                    |
| Read-Only Diff Viewer           | **APPROVE**              | Accelerates context injection. Orchestrator task, not worker task.                                                          |
| Cross-Worktree Diff             | **APPROVE**              | Manages multiplicity. Provides omniscience. Unique to orchestration.                                                        |
| Review Hub (Stage/Commit/Push)  | **APPROVE**              | Bridges gap. Keeps user in flow. Lightweight -- not a full Git GUI.                                                         |
| Agent Completion Notifications  | **APPROVE**              | Unblocks agent. Manages multiplicity. Enables reactive workflow.                                                            |
| Voice Input Transcription       | **APPROVE**              | Bridges gap. Hands-free delegation while monitoring other agents.                                                           |
| Integrated Browser (Portal)     | **APPROVE (Limited)**    | Only as localhost preview + console capture. Bridges gap. Not Chrome.                                                       |
| Help System                     | **APPROVE**              | Manages multiplicity (aggregates docs). Bridges CLI<->GUI gap. MCP-compatible.                                              |
| Resource Profiles               | **APPROVE**              | Autonomous infrastructure. Unblocks multi-agent workflows by preventing OOM.                                                |
| Frecency Project Switcher       | **APPROVE**              | Multi-project omniscience. Smart defaults reduce cognitive load.                                                            |
| Theme System (Semantic Tokens)  | **APPROVE**              | Low-maintenance via import-based design. Platform polish earns trust. Serves as infrastructure for all UI.                  |
| File Upload to Agent            | **APPROVE**              | Context injection. Bridged via image paste + file drop chips.                                                               |
| Terminal Color Schemes          | **APPROVE**              | Low maintenance. Import-based. Respects terminal-first design.                                                              |
| Keyboard Shortcut Profiles      | **APPROVE**              | Import/export. Low maintenance. Power user retention.                                                                       |
| MCP Server for Action System    | **APPROVE**              | Enables bidirectional agent<->orchestrator communication. Unique differentiator.                                            |
| Plugin System                   | **APPROVE**              | Extensibility via MCP/plugin means users add features without core bloat.                                                   |
| npm Script Runner               | **APPROVE (Simplified)** | Only start/stop via Dev Preview. Not editing package.json.                                                                  |
| Git Graph/Tree                  | **REJECT**               | Red Light: reinvents Git GUI. Too much visual noise.                                                                        |
| Syntax Highlighting (editable)  | **REJECT**               | Red Light: reinvents text editor. Workshop feature.                                                                         |
| Settings with 10 toggles        | **REJECT**               | Red Light: requires deep configuration.                                                                                     |
| Custom Chat Rendering           | **REJECT**               | Red Light: reinvents chat UI. Agents run in real terminals.                                                                 |
| Merge Conflict Resolution       | **REJECT**               | Red Light: reinvents Git GUI. Send to VS Code.                                                                              |
| Task Decomposition UI           | **REJECT**               | Red Light: micro-orchestration. Claude Code Agent Teams handle this internally.                                             |
| Built-in Code Search            | **REJECT**               | Red Light: duplicates agent capabilities. Agents have `grep`/`rg` built in.                                                 |
| Agent-to-Agent Chat             | **DEFER**                | Strong fit but requires A2A protocol maturity and agent lifecycle hooks.                                                    |
| Automated Context Rotation      | **DEFER**                | Excellent automation fit but depends on reliable agent lifecycle hooks.                                                     |
| Spec Authoring/Decomposition UI | **DEFER**                | Serves supervisor workflow but "specification as code" patterns still evolving. Revisit when canonical spec format emerges. |
| Cost/Token Dashboard            | **DEFER**                | Provides omniscience but requires structured state from each CLI agent. Revisit when agents expose cost data via MCP.       |

---

## Execution Guidelines

1. **Default to NO** -- Your instinct should be rejection. Only approve what clearly passes all tests.
2. **Be thorough** -- Read actual code, don't guess. Use the Agent tool with `subagent_type: "Explore"` for deep codebase searches.
3. **Be honest** -- A rejected feature is better than a misfit feature
4. **Be specific** -- Point to actual files and patterns
5. **Be constructive** -- Even rejections should explain why and suggest alternatives
6. **Think about maintenance** -- Every feature is a maintenance commitment across 3 platforms and 6+ agent CLIs
7. **Check the competition** -- Know whether Conductor/Sculptor/Claude Squad already solve this, and whether that matters
8. **Consider MCP integration** -- Could this feature be better served by exposing an MCP tool rather than building full UI?

**Remember:**

- Daintree is opinionated. Not every good feature belongs here.
- Feature bloat is the new technical debt.
- Just because we _can_ build something doesn't mean we _should_.
- The goal is a focused, cohesive tool for AI agent macro-orchestration, not a general-purpose IDE.
- Every feature must justify its existence against: "Could the user just switch to their terminal/VS Code for this?"
- If an agent can orchestrate it internally via sub-agents or teams, Daintree shouldn't replicate it.
- Daintree's deepest moat is MCP + multi-project + resource governance. Features that deepen these moats are highest priority.
- The user supervises 3-5 agents (sweet spot) to 10 agents (upper bound). Design for this range.
