# Workflows

## Overview

The workflow engine enables reactive automation in Canopy. Workflows are event-driven sequences that respond to conditions in your development environment — agent state changes, file modifications, build results — and execute actions automatically.

## What Workflows Solve

Without workflows, you manually monitor agents and react when things happen:

- An agent finishes → you check its output
- A test fails → you restart the agent with different context
- A build succeeds → you push the changes

Workflows automate these reactions so you can focus on higher-level orchestration.

## Workflow Concepts

### Triggers

Workflows start with a trigger — an event that initiates the workflow:

- Agent state changes (working → completed, idle → error)
- File system events in a worktree
- Timer-based intervals
- Manual invocation

### Actions

Each workflow step executes an action from Canopy's action system. Any action available in the command palette can be used in a workflow.

### Conditions

Steps can have conditions that determine whether they execute, allowing branching logic based on agent state, file existence, or other criteria.

## Built-In Workflows

Canopy includes several pre-built workflow templates:

- **Code Quality Check** — Runs quality checks on agent output
- **Standard PR Review** — Structured review workflow for pull requests
- **Worktree Snapshot** — Captures the state of a worktree at a point in time

## Automation Levels

Canopy features trend toward automation:

| Level          | Description                 | Example                                  |
| -------------- | --------------------------- | ---------------------------------------- |
| **Manual**     | You do everything           | Opening terminals, typing commands       |
| **Assisted**   | Canopy detects, you act     | State notifications, waiting indicators  |
| **Reactive**   | Canopy detects and responds | Auto-inject context when agent asks      |
| **Autonomous** | Canopy handles it           | Workflow chains run without intervention |

Workflows operate at the Reactive and Autonomous levels — reducing the manual monitoring and intervention that slows down multi-agent development.

## Tips

- Start simple: automate your most repetitive reaction first
- Workflows compose with recipes — use a recipe to set up panels, then workflows to automate the interactions
- The workflow engine uses Canopy's action system, so any new action automatically becomes available in workflows
