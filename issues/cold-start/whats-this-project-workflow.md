# Panel Grid Empty State: "What's This Project?" Workflow

## Problem
When opening a new repository or revisiting an old, unfamiliar one, users often need a high-level overview before they can start working. They need to answer: "What is this?", "How do I run it?", and "Where is the core logic?".

## Proposal
Add a **"What's This Project?"** (or "Explain This Project") action to the `ContentGrid` empty state. This triggers an agent workflow to generate a comprehensive project summary.

## User Experience
1.  **Entry Point:**
    *   Located in the `ContentGrid` empty state, alongside "What's Next?".
    *   Useful for:
        *   Freshly cloned repositories.
        *   Old projects with no recent activity.
        *   Onboarding new team members.

2.  **Interaction:**
    *   User clicks "What's This Project?".
    *   Canopy launches the Default Agent with a "Project Explanation" mission.

3.  **Agent Workflow:**
    *   **Exploration:** The agent uses file listing tools (`ls`, `tree`, or internal `read_dir`) to understand the structure.
    *   **Key Files:** It reads `README.md`, `package.json` (or equivalent), and entry points (e.g., `main.ts`, `index.js`, `Cargo.toml`).
    *   **Analysis:** It identifies the tech stack, build system, and architectural patterns.

4.  **Output:**
    *   The agent generates a **Markdown Summary** containing:
        *   **Project Name & Purpose:** What does it do?
        *   **Tech Stack:** Languages, frameworks, key libraries.
        *   **Architecture:** Brief map of key directories (`src/`, `components/`, etc.).
        *   **Quick Start:** Validated commands to install dependencies and run the project (e.g., `npm install && npm run dev`).
    *   *Optionally:* This summary can be saved to a "Project Note" (see `issues/notes-panel-assistant-style.md`) for future reference.

## Technical Implementation
### 1. Prompt Strategy
*   "You are an expert software architect. Analyze this codebase to explain what it is and how to run it.
    1.  List the files in the root.
    2.  Read the README and configuration files.
    3.  Summarize the stack and architecture.
    4.  Provide the exact commands to start the development server."

### 2. UI Integration
*   Reuse the button style from "What's Next?" but perhaps with an "Info" or "Book" icon.

## Future Enhancements
*   **Auto-Readme Generation:** If no README exists, offer to generate one based on the analysis.
*   **Architecture Diagram:** Generate a Mermaid.js diagram of the system.
