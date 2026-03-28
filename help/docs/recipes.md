# Terminal Recipes

## Overview

Terminal recipes are saved panel configurations that let you launch repeatable multi-agent setups with a single action. Instead of manually opening panels and configuring agents each time, you define a recipe once and replay it whenever needed.

## What Recipes Solve

When working on a complex task, you might want:

- A Claude agent for the main implementation
- A Gemini agent for architecture review
- A terminal running your test suite in watch mode
- A dev preview showing your app

Setting this up manually every time is tedious. A recipe captures this entire setup and restores it instantly.

## Using Recipes

Recipes are accessible from the command palette (Cmd+Shift+P) and the terminal recipe interface.

### Creating a Recipe

1. Set up your panels the way you want them — agents, terminals, browsers, in whatever layout works for your workflow
2. Save the current layout as a recipe
3. Give it a descriptive name (e.g., "Frontend dev setup", "PR review workflow")

### Launching a Recipe

1. Open the command palette (Cmd+Shift+P) or recipe picker
2. Select your saved recipe
3. Canopy recreates the full panel setup

## Recipe Contents

A recipe captures:

- Which panels to create (agent type, terminal, browser, etc.)
- Agent configurations (which agent CLI, which model)
- Panel positions in the grid
- The worktree context

## Tips

- Create recipes for your most common workflows to save setup time
- Recipes work well with worktree switching — launch a recipe in a specific worktree
- You can share recipe configurations with your team
