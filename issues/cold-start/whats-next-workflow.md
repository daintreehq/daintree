# Panel Grid Empty State: "What's Next" Workflow

## Problem
When a user opens a project (worktree) in Canopy after some time, they often face a "cold start" problem. They need to reorient themselves, recall the project's state, and decide what to work on next. Manually checking GitHub issues (`gh issue list`) and browsing the file tree is high-friction.

## Proposal
Add a **"What's Next?"** action to the `ContentGrid` empty state. This button triggers an automated workflow that leverages the "Default Agent" to analyze the project's status and suggest actionable tasks.

## User Experience
1.  **Entry Point:**
    *   In the `EmptyState` component (`src/components/Terminal/ContentGrid.tsx`), add a prominent "What's Next?" button (distinct from the standard Agent Launchers).
    *   Ideally, place this near the "Resume" or "Project Pulse" area to suggest continuity.

2.  **Interaction:**
    *   User clicks "What's Next?".
    *   Canopy checks for `gh` CLI availability.
        *   *If missing:* Prompt user to install/auth `gh`.
    *   Canopy initiates a background process to fetch open issues (e.g., `gh issue list`).
    *   Canopy launches the **Default Agent** (e.g., Gemini or Claude) with a specialized "Mission" prompt.

3.  **Agent Output:**
    *   The agent receives the list of issues and a directive to explore the codebase.
    *   The agent outputs a concise summary of the project status and **4 recommended tasks** based on priority, feasibility, and codebase state.
    *   The user can then click one of these recommendations (if the agent supports interactive plans) or simply instruct the agent to "Start on task #1".

## Technical Implementation

### 1. Default Agent Configuration
*   We need a concept of a "Default Agent" in `Settings`.
*   *Interim:* If no default is set, prompt the user to select one (Claude or Gemini) or default to the most recently used one.

### 2. Context Gathering
*   Use `SystemClient` or a simplified shell execution to run:
    ```bash
    gh issue list --limit 30 --state open --json number,title,body,labels,updatedAt
    ```
*   (Optional) Include a high-level file tree summary using `CopyTreeService` or `tree`.

### 3. Prompt Construction
Construct a prompt similar to:
> "You are the Lead Engineer for this project. I am returning after a break.
>
> 1.  Analyze the following GitHub issues:
>     <ISSUES_JSON>
>
> 2.  Briefly explore the codebase to understand the current architecture and recent changes.
>
> 3.  Based on this, identify **4 high-impact, actionable tasks** for me to tackle today.
>     *   Prioritize bugs or clearly defined features.
>     *   Avoid vague 'refactoring' unless critical.
>     *   For each task, explain *why* it's important and *where* to start in the code.
>
> Output your response as a structured list."

### 4. UI Changes (`src/components/Terminal/ContentGrid.tsx`)
*   Add the visual component for the button.
*   Implement the handler `handleWhatsNext()` that orchestrates the above steps.

## Dependencies
*   **`gh` CLI:** Must be installed and authenticated in the user's environment.
*   **Agent Protocol:** Requires the ability to seed an agent with an initial prompt payload (which is already supported via `onLaunchAgent` context or initial input injection).

## Future Enhancements
*   **One-Click Start:** Allow the agent to return clickable "Task Cards" that immediately set up the environment (open files, run tests) for that specific task.
*   **Smart Context:** Include local git diffs or recent commit history in the prompt.
