# Vision

The way developers work is changing. Running many AI coding agents in parallel across git worktrees is becoming the standard workflow, and the developer's role is shifting from writing code to running a hierarchy of agents: delegating authority, specifying work, dispatching it, and making the calls only a person can make. The tooling hasn't caught up. You end up with a dozen terminal tabs on several machines, no visibility into what each agent is doing, and agents that stop and wait, sometimes for hours, whenever you step away.

Daintree is a **meta-harness and IDE** for this workflow: it runs your own agent CLIs as a hierarchy of agents, across multiple hosts, without vendor lock-in. It handles what agents can't provide for themselves: standing assistants that keep the context and authority you've given them, worktree lifecycle, dev server management, resource governance, cross-agent state across projects and machines, and a path to you for the decisions that remain.

- **A standing hierarchy** — The global Assistant sits above every project on this machine and on the hosts it's allowed to control, each project keeps its own assistants, and short-lived workers take one task each with a clean context. The assistants persist; the workers come and go.
- **Attention-first** — The scarce resource is the person's attention, not generation speed and no longer review. Assistants handle what they've been given authority for, and what needs a person waits for them in Daintree or, with Decisions on, reaches their phone. Review competes for that attention like everything else: reviewing agents, test gates and CI do most of it, and Review Hub is there for the rest.
- **Automatic isolation** — Each task gets its own git worktree. Agents never collide.
- **Across machines** — Agents run on whichever host has the capacity, and keep running on an always-on host while the laptop that drives it sleeps.
- **Zero lock-in** — Your machines, your keys, your choice of agents. Daintree is agent-agnostic by design, and even the path to your phone runs through a relay in your own account.

## Where Daintree sits

The AI coding agent space has settled into layers. CLI agents (Claude Code, Codex, Antigravity, Aider) handle execution. Cloud platforms (Devin, Factory) handle long-running autonomous tasks in remote VMs. Editors (Cursor, Windsurf, Zed) handle single-agent pair programming tied to one branch.

Daintree sits above the CLI agents. "Meta-harness" is becoming the name for that shelf: a layer above coding tools like Claude Code and Codex that combines and controls them. Running parallel agents in worktrees with a diff to review is now common ground there, and so are coordinating agents that start workers for a single run. What sets Daintree apart is a **standing hierarchy**: long-lived assistants that carry their conversations and the authority you've delegated from one session to the next, rules they can't route around (confirmations a person answers, ownership of what they launched, tool-set tiers, a worker's report treated as a claim to check rather than an instruction), and a self-hosted path to you for the decisions that remain. It runs on machines you control, and nothing leaves them without your consent.

It is also an IDE, and the aim is a complete one: someone running their agents in Daintree shouldn't have to leave it for anything an orchestration IDE should do. It still isn't a code editor; the editor stays a button away.

## The inner loop, redefined

The inner loop used to be write, compile, test, iterate. Then it became specify, dispatch, monitor, review, merge, and review looked like the bottleneck. With this generation of models, for a developer running many agents, it mostly isn't: review bots, a second agent reviewing at the exact head commit, test gates and green CI do most of the checking.

What limits a developer running many agents now is, in order of cost: the person being away, when agents stop on a question or an approval and wait; compute for tests, since agents produce changes faster than heavy suites can verify them; and the cost of inference and of hosting the agents. Keeping track of all of it across machines sits under each of those.

That's where Daintree fits. Assistants and Decisions keep agents moving while the person is away; Remote Hosts put work on the machine with the capacity; and one view across projects and hosts keeps track of it all.

## What we're building toward

The core pillars are stable: the panel grid, agent state and attention, fleet automation, worktree orchestration with per-worktree dev servers, getting context in and review out, and a calm visual identity. These aren't changing. `docs/feature-curation.md` holds the full list and the rubric for what doesn't get built.

What's evolving is how deeply Daintree integrates with the agents it orchestrates. Through MCP (Model Context Protocol), Daintree exposes its action system as tools that agents can discover and invoke programmatically. An agent can request a worktree, read the state of sibling panels, wait on a peer to finish, or pull aggregated diffs, all without the developer manually bridging the gap. What a given caller sees is deliberately tiered rather than total: a third-party client gets a small, budgeted roster of the things only Daintree can do — terminal and agent orchestration, worktrees, recipes, live IDE context — on the reasoning that an agent sitting in a terminal already has its own `gh` and its own git. The assistants reach further, and the global Assistant reaches every project on every host. This bidirectional integration is Daintree's deepest technical moat.

Two more layers have grown around the core. Plugins carry the surface that isn't orchestration: forge providers, Markdown editing, and project plugins that work as full applications with their own data and agent tools. Remote Hosts lets one window drive Daintree's whole backend on another Mac or Linux machine, so a fleet can outgrow one computer without leaving machines you control.

The other frontier is resource governance. Every agent with its own dev server and terminal puts real pressure on a machine. Daintree's adaptive resource profile system (Performance, Balanced, Efficiency) already throttles based on memory pressure, event loop lag, and battery state. As agent counts grow, this infrastructure becomes more important, not less, and the answer increasingly goes horizontal: spreading the work across machines rather than squeezing more onto one. Remote Hosts is the first step; offloading agents' heavy commands to other runners (#17114) and a machine per worktree on the user's own cloud (#17295) are the next ones planned.

## The yardstick: thousands of agents

The direction is one person steering thousands of agents through the hierarchy, across many machines. That is a north star, not a number Daintree has reached: the busiest setup reported so far is one user's 132 agents live across five computers (#17293). It is the yardstick the architecture is judged against, and today's limits are the first things it measures:

- A host's agent directory names at most 256 agents (`AGENT_DIRECTORY_ENTRIES_MAX` in `shared/types/agentDirectory.ts`).
- One `host.status` call reads at most 64 projects (`HOST_STATUS_TARGETS_MAX` in `shared/types/hostControl.ts`).
- `host.list` fits every host's agent directory into a single 48 KiB answer (`AGENT_DIRECTORY_BYTES_MAX`, applied by `fitToResponse` in `electron/remote/assistant/HostCallRuntime.ts`).

The goal is to be the best meta-harness for a developer running many agents every day, on machines they control and with no vendor they're locked into, and to keep raising those limits until thousands is an ordinary day.
