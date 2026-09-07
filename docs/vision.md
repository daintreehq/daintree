# Vision

The way developers work is changing. Running multiple AI coding agents in parallel across git worktrees is becoming the standard workflow, and the developer's role is shifting from writing code to supervising agent fleets: specifying tasks, dispatching agents, monitoring progress, reviewing output, and shipping results. The tooling hasn't caught up. You end up with a dozen terminal tabs, no visibility into what each agent is doing, and no clean way to review or merge the results.

Daintree is the **macro-orchestration layer** for this workflow. It handles the infrastructure concerns that agents can't provide for themselves: worktree lifecycle, dev server management, resource governance, cross-agent state aggregation, and human review workflows.

- **Automatic isolation** — Each task gets its own git worktree. Agents never collide.
- **Visibility at a glance** — See what every agent is doing, which ones need input, and what's changed across all branches.
- **Review-first workflows** — The bottleneck isn't generation speed, it's reviewing what agents produce. Daintree is built around making that fast.
- **Zero lock-in** — Your machine, your keys, your choice of agents. Daintree is agent-agnostic by design.

## Where Daintree sits

The AI coding agent space has settled into clear layers. CLI agents (Claude Code, Gemini CLI, Codex, Aider) handle execution. Cloud platforms (Devin, Factory) handle long-running autonomous tasks in remote VMs. IDEs (Cursor, Windsurf, Zed) handle single-agent pair programming tied to one branch.

Daintree occupies the space between these: a local desktop environment for supervising 3 to 10 concurrent CLI agents, each running in its own worktree, with the infrastructure and visibility that terminals can't provide. It's agent-agnostic, cross-platform, and entirely local-first. Your machine, your keys, your code.

## The inner loop, redefined

The inner loop used to be write, compile, test, iterate. Now it's specify, dispatch, monitor, review, merge. Most of a developer's time goes to writing good specs, reviewing agent output, and unblocking stuck agents. Almost none of it goes to typing code.

This shift creates a real gap in tooling. IDEs are built for writing code. Terminals are built for running commands. Neither is built for supervising a fleet of concurrent agents across isolated worktrees.

That's where Daintree fits. It's the local control plane for this new workflow.

## What we're building toward

The core pillars are stable: panel grid, agent state intelligence, worktree orchestration, context injection, review workflows, dev server management. These aren't changing.

What's evolving is how deeply Daintree integrates with the agents it orchestrates. Through MCP (Model Context Protocol), Daintree exposes its action system as tools that agents can discover and invoke programmatically. An agent can request a worktree, read the state of sibling panels, wait on a peer to finish, or pull aggregated diffs, all without the developer manually bridging the gap. What a given caller sees is deliberately tiered rather than total: a third-party client gets a small, budgeted roster of the things only Daintree can do — terminal and agent orchestration, worktrees, recipes, live IDE context — on the reasoning that an agent sitting in a terminal already has its own `gh` and its own git. The in-app assistant reaches further. This bidirectional integration is Daintree's deepest technical moat.

The other frontier is resource governance. Running 5 to 10 agents, each with its own dev server and terminal, puts real pressure on a developer's machine. Daintree's adaptive resource profile system (Performance, Balanced, Efficiency) already throttles based on memory pressure, event loop lag, and battery state. As agent counts grow, this infrastructure becomes more important, not less.

The goal isn't to become an IDE or a cloud platform. It's to be the best possible local supervision layer for the developer who's managing a small fleet of agents every day, and to stay focused on that.
