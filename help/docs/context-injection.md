# Context Injection

## Overview

Context injection is how you feed your AI agents the right codebase information. Canopy's CopyTree service generates structured context summaries that you can paste into agent prompts, giving them a clear picture of the relevant code.

## What is CopyTree?

CopyTree generates a text representation of your project's file structure and contents, optimized for AI agent consumption. It includes:

- Directory tree structure
- File contents (respecting .gitignore and size limits)
- Focused selections when you want to highlight specific files or directories

## Using Context Injection

### Quick Inject

Press **Cmd+Shift+I** to inject context into the focused terminal. This pastes a CopyTree summary directly into the agent's input.

### Copy Tree Context

Press **Cmd+Shift+C** to copy a tree context summary for the active worktree to the clipboard. You can then paste it into any agent manually.

### Send to Agent

Press **Cmd+Shift+E** to send a selection from one terminal to another. This is useful for forwarding error messages or code snippets between agents.

## Context Workflow

A typical context injection workflow:

1. **Identify the relevant code** — Know which files or directories the agent needs to see
2. **Generate context** — Use Cmd+Shift+I or Cmd+Shift+C to create the summary
3. **Inject into agent** — The context is pasted into the agent's terminal input
4. **Ask your question** — The agent now has the codebase context to give an informed answer

## Tips

- Context injection works best when you focus it on the relevant subset of your codebase rather than the entire project
- Agents that support context injection: Claude, Gemini, Codex, OpenCode, Cursor (all built-in agents)
- The generated context respects .gitignore rules to avoid including build artifacts, dependencies, or sensitive files
- For large codebases, consider using worktree-scoped context (Cmd+Shift+C) to limit the scope
