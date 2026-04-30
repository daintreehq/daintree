# Feature Curation Guide

> _"You can do anything, but you cannot do everything."_

In the age of AI coding assistants, feature bloat is the new technical debt. Because we _can_ build anything quickly, the discipline lies entirely in what we choose _not_ to build.

## What Daintree IS

**Daintree is a habitat for your AI coding agents.**

It is the orchestration layer where you direct agent work, monitor agent fleets, and intervene when agents need help. It bridges the gap between human intent, codebase context, and agent execution.

**The Metaphor:** If VS Code is the workbench where you craft the part, Daintree is the habitat where your agents live, work, and collaborate — and where you observe and guide them.

**Daintree is NOT an IDE (like VS Code). It is NOT a Chat UI (like ChatGPT). It is a terminal-based orchestration layer** — agents run in real terminals, and Daintree wraps them with state intelligence, context injection, and multi-agent coordination.

## Core Pillars

1. **Panel Grid** — Manage multiple panel sessions running AI agents in parallel
2. **Agent State Intelligence** — Know when agents are working, waiting, stuck, or completed — and react automatically
3. **Worktree Orchestration** — Partition work across git worktrees, monitor status, compare results
4. **Context Injection** — Generate and inject the right codebase context into agents via CopyTree
5. **Review & Intervention** — Review agent output, stage changes, diff across worktrees, and push — without leaving Daintree
6. **Dev Server Management** — Auto-detect and manage dev servers per worktree with embedded preview
7. **Visual Identity & Comfort** — A rich theme system that makes Daintree feel like a native app, reduces eye strain during long sessions, and supports accessibility needs
8. **Automation & Recipes** — Terminal recipes for repeatable multi-agent setups, and workflow engine for reactive automation

**Strategic Features** (not pillars, but significant capabilities):

- **Daintree Assistant** — Built-in AI assistant with orchestration-layer context (sees all panels, worktrees, actions)
- **Voice Input** — Hands-free delegation while monitoring other agents
- **Notes** — Annotation and note-taking alongside agent work
- **Portal** — Tabbed dock for web-based AI agent UIs alongside terminal agents

**Brand Voice:** "Calm partner" — helpful, not flashy. Reduces cognitive load. Opinionated defaults.

## The Habitat Principle

Daintree is a habitat — a place where developers spend hours every day. Features that help users settle into and personalize their environment are not decoration; they're part of the product's core value proposition.

Ask: _"Does this help the user make Daintree feel like **their** space?"_

Theme discovery (random cycling, search, hero previews), project identity (colors, emojis), and environmental comfort (dock sizing, focus dimming, sound preferences) all serve this principle. They make users want to stay in Daintree rather than reach for another tool.

This is distinct from "Purposeless Decoration" — habitat features serve _user comfort and ownership_, while purposeless decoration serves no one. A random theme cycler helps users discover the theme that reduces their eye strain; a bouncing logo does not.

**Engagement and delight are welcome.** Features like streak animations, milestone celebrations, and playful moments make Daintree a place users _want_ to be. The pulse streak is already gamification — and that's fine. Sticky features that reward consistent use reinforce the habitat. The line is features that _only_ exist to manipulate behavior with no underlying value.

## Polish Is Always Welcome

This guide gates **new features** — it does not gate **polish**. Improving an empty state, refining a micro-interaction, fixing a visual inconsistency, or smoothing a rough edge in an existing feature is always accepted work. Daintree's ambition is to be the most polished application in its category. Every interaction should feel considered and intentional.

Polish work does not need to pass the Green Light test. If something already exists in Daintree and it can be made better, smoother, or more delightful — do it.

## The Cost of Attention Test

For every feature proposal, ask:

> _Does adding this feature reduce the user's cognitive load by handling an orchestration task, or does it increase load by demanding manual interaction?_

If it increases cognitive load or demands manual interaction, **reject it**.

## The Green Light Test

A feature belongs in Daintree **only if it satisfies at least two** of these criteria:

| Criterion                         | Description                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Accelerates Context Injection** | Makes it faster to feed the "right" files, errors, diffs, or screenshots to an agent                                 |
| **Unblocks the Agent**            | Detects when an agent is stuck, waiting, or failed, and helps human intervene quickly                                |
| **Manages Multiplicity**          | Helps manage _multiple_ concurrent workstreams that a human brain can't track alone                                  |
| **Bridges the Gap**               | Fixes a friction point between CLI agents and the GUI orchestration layer                                            |
| **Provides Omniscience**          | Aggregates data from multiple isolated contexts (worktrees/agents) into a single view                                |
| **Enables Automation**            | Allows the user to set up reactive workflows that reduce manual monitoring and intervention                          |
| **Reinforces Identity**           | Strengthens Daintree's visual distinctiveness, user comfort, accessibility, or helps users personalize their habitat |

If a feature doesn't satisfy at least 2 of these, it doesn't belong in Daintree.

## The Red Light Test

Daintree **explicitly rejects** features that:

| Anti-Pattern                          | Why                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reinvents the Code Editor**         | Code editing, refactoring tools, linting → Send user to VS Code. Read-only viewing and annotation are fine.                                                                                                                                                            |
| **Reinvents the Git GUI**             | We are not making SourceTree. Git matters for worktrees, diffs, and lightweight commit/push only.                                                                                                                                                                      |
| **Reinvents the Chat UI**             | We are not building ChatGPT. Agents run in real terminals. The Assistant is the exception — it has orchestration context.                                                                                                                                              |
| **Excessive Configuration**           | Each feature should work with zero configuration. Settings exist for power users, not as requirements. If a feature can't ship with opinionated defaults, it's too complex.                                                                                            |
| **Purposeless Decoration**            | Animations or UI elements that don't convey state, reinforce identity, or serve user comfort. Themes, pulse animations, and project colors are purposeful — gratuitous animation is not.                                                                               |
| **Duplicates Agents Without Context** | If the CLI agent already does it well and you're just rebuilding the same thing in a GUI, don't. But wrapping agent capabilities with Daintree's orchestration context (seeing all panels, worktrees, project state) adds real value — that's what the Assistant does. |

**Additional anti-patterns:**

- One-off utilities without workflow integration
- Anything easily done with a shell alias
- Features better handled by external tools (file management, system tools)
- Features that only benefit single-agent, single-worktree workflows

## The Automation Gradient

Daintree features should trend toward automation, not interaction:

| Level          | Description                                           | Daintree Fit                   |
| -------------- | ----------------------------------------------------- | ------------------------------ |
| **Manual**     | User must perform action every time                   | Poor — should be a shell alias |
| **Assisted**   | Daintree detects something, user acts                 | Acceptable — bridges the gap   |
| **Reactive**   | Daintree detects and responds with minimal user input | Good — reduces cognitive load  |
| **Autonomous** | Daintree handles it entirely, user is notified        | Excellent — true orchestration |

Features at the "Manual" level rarely belong. Features at "Reactive" or "Autonomous" level are strong candidates.

## Workshop vs Orchestration Layer

Ask yourself:

> _"Does this feature belong in the Workshop (VS Code) or the Orchestration Layer (Daintree)?"_

If the answer is **Workshop**, we don't build the feature. At most, we build a **button that opens the Workshop** to the right place (like the existing "Open in Editor" integration).

**The grey area:** Read-only viewing, annotation, and lightweight interaction (staging files, reviewing diffs, writing notes) belong in the Orchestration Layer. Editing code, running linters, resolving merge conflicts belong in the Workshop.

## Decision Examples

| Feature Proposal           | Decision                 | Reasoning                                                                                                                |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Full File Editor           | **REJECT**               | Workshop feature. VS Code exists. Red Light: reinvents code editor.                                                      |
| Agent "Retry" Button       | **APPROVE**              | Reduces cognitive load. Unblocks agent. Bridges CLI gap.                                                                 |
| Theme System               | **APPROVE**              | Reinforces identity, serves comfort/accessibility, differentiates Daintree. 14 built-in themes with accessibility modes. |
| Custom Themes              | **APPROVE**              | Natural extension of theme system. User identity, community sharing potential. Approve when infrastructure is ready.     |
| Read-Only File Viewer      | **APPROVE**              | Accelerates context injection. Read-only with syntax highlighting for reviewing agent output. Not a code editor.         |
| Cross-Worktree Diff        | **APPROVE**              | Manages multiplicity. Provides omniscience. Unique to orchestration.                                                     |
| Review Hub                 | **APPROVE**              | Bridges gap. Lightweight stage/commit/push. Not a full Git GUI.                                                          |
| Completion Notifications   | **APPROVE**              | Unblocks agent. Manages multiplicity. Enables reactive workflow.                                                         |
| Voice Input                | **APPROVE**              | Bridges gap. Hands-free delegation while monitoring other agents. Accessibility value.                                   |
| Integrated Browser         | **APPROVE**              | Localhost preview, console capture, and agent-app debugging. Bridges gap. Not a general-purpose browser.                 |
| Daintree Assistant         | **APPROVE**              | Wraps AI with orchestration context (panels, worktrees, actions). Not a generic chat — it's orchestration-aware.         |
| Notes Panel                | **APPROVE**              | Annotation alongside agent work. Markdown editing for note-taking, not code editing. Bridges gap.                        |
| Terminal Recipes           | **APPROVE**              | Enables automation. Repeatable multi-agent setups reduce manual panel configuration.                                     |
| Portal (Web Agent Dock)    | **APPROVE**              | Bridges gap between CLI agents and web agent UIs. Manages multiplicity across agent interfaces.                          |
| Workflow Engine            | **APPROVE**              | Enables automation. DAG-based reactive workflows with approval gates. Core orchestration.                                |
| Chat History Search        | **APPROVE**              | Manages multiplicity. Essential for auditing agent work across sessions.                                                 |
| npm Script Runner          | **APPROVE (Simplified)** | Only start/stop via Dev Preview. Not editing package.json.                                                               |
| Random Theme Cycler        | **APPROVE**              | Habitat principle: helps users discover the theme that feels right. Reinforces identity through exploration.             |
| Git Graph/Tree             | **REJECT**               | Red Light: reinvents Git GUI. Too much visual noise.                                                                     |
| Code Editing in FileViewer | **REJECT**               | Red Light: reinvents code editor. Workshop feature. Read-only is the line.                                               |
| Settings with 10 toggles   | **REJECT**               | Red Light: excessive configuration. Feature should work out of the box.                                                  |
| Merge Conflict Resolution  | **REJECT**               | Red Light: reinvents Git GUI. Send to VS Code.                                                                           |

## Architectural Requirements

Every feature must follow Daintree's 4-layer pattern:

```
Service → IPC → Store → UI
```

1. **Service** (`electron/services/`) — Business logic, system operations
2. **IPC Handlers** (`electron/ipc/handlers/`) — Bridge main↔renderer with Zod validation
3. **Store** (`src/store/`) — Zustand state management
4. **UI** (`src/components/`) — React 19 components

**Key requirements:**

- Multi-project aware (filters by projectId, handles project switching)
- Event-driven (emits events, doesn't call services directly across boundaries)
- Type-safe (TypeScript throughout, Zod for IPC validation)
- Resilient (error handling, graceful degradation)
- Cross-platform (macOS, Windows, Linux)
- Action-integrated (register in Action System for keybinding/palette/menu access)

## Platform Priority

Daintree targets all three desktop platforms, but not equally:

- **macOS** — Primary development platform. First-class support. All features tested here first.
- **Linux** — Growing focus. CI runs full E2E on Linux. Important for developer adoption.
- **Windows** — Supported but lower priority. Nightly CI only for E2E. Known friction with native modules.

"Cross-platform" means features must not break on any platform, but macOS is where the bar is set.

## AI-Augmented Development

Daintree is built by a solo developer augmented by AI coding agents — the same agents Daintree orchestrates. This means:

1. **Higher throughput than traditional solo dev** — But maintenance burden is still real. Every feature must be maintained across 3 platforms and kept compatible with 15 agent CLIs that each update independently.

2. **No unnecessary native dependencies** — `node-pty` is already complex enough. Avoid adding more native modules unless they provide 10x value.

3. **State over database** — Use the file system (git) as the source of truth whenever possible. Don't sync state that can be derived from the folder structure.

4. **Opinionated integrations** — Support the CLIs that matter (Claude, Gemini, Codex, OpenCode, Cursor, Kiro, GitHub Copilot, Goose, Crush, Qwen, Open Interpreter, Mistral Vibe, Kimi, Amp, Aider) and support them _deeply_ via the agent registry. Don't try to support every AI tool generically.

5. **Maintenance budget** — If a feature can't justify its ongoing maintenance cost across platforms and agent updates, reject it.

## Feature Evaluation Checklist

Before implementing any feature, verify:

- [ ] Passes Cost of Attention test (reduces cognitive load)
- [ ] Passes Green Light test (satisfies 2+ criteria)
- [ ] Passes Red Light test (no triggers)
- [ ] Belongs in the Orchestration Layer, not Workshop
- [ ] At "Assisted" automation level or higher
- [ ] Follows 4-layer architectural pattern
- [ ] Multi-project compatible
- [ ] Cross-platform compatible (won't break on any OS)
- [ ] No new native dependencies
- [ ] Ships with opinionated defaults (settings are optional, not required)
- [ ] Can't be solved with a shell alias
- [ ] Sustainable maintenance burden

## Using the Slash Command

For automated evaluation, use:

```
/evaluate-feature <paste your feature proposal here>
```

This command runs a rigorous 5-phase evaluation:

1. **Existence Check** — Does it already exist?
2. **Mission Alignment** — Does it fit Daintree's purpose?
3. **Architectural Fit** — Does it follow patterns?
4. **Implementation Complexity** — What's the effort and risk?
5. **Value Assessment** — Is the value worth the cost?

The command defaults to **NO** and requires features to clearly pass all tests.

## Remember

- Daintree is opinionated. Not every good feature belongs here.
- Feature bloat is the new technical debt.
- Just because we _can_ build something doesn't mean we _should_.
- The goal is a focused, cohesive tool for AI agent orchestration, not a general-purpose IDE.
- Every feature must justify itself against: "Could the user just switch to their terminal/VS Code for this?"
- Themes, visual identity, and polish are not cruft — they're what make Daintree feel like a real product instead of a web page.
