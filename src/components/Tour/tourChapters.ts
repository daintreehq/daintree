import type { TourChapter } from "./tourTypes";

/**
 * The narration source of truth. `[[cue]]` markers sit immediately before the
 * word the scene reacts to; `npm run tour:audio` voices the clean text and
 * resolves every cue to the moment that word is spoken.
 *
 * Write for the ear: spell out shortcuts ("Command J"), no symbols, no
 * abbreviations the voice would have to guess at. Editing a chapter's words
 * marks its generated timing stale until the audio is regenerated.
 */
export const TOUR_CHAPTERS: readonly TourChapter[] = [
  {
    id: "welcome",
    title: "Welcome to Daintree",
    summary: "Run several AI coding agents side by side and keep an eye on all of them.",
    narration:
      "Welcome to Daintree. [[first]] It's a home for your AI coding agents. Instead of juggling terminal tabs, [[grid]] you run several agents side by side, and keep an eye on all of them from one window. Let's take a quick look around.",
  },
  {
    id: "worktrees",
    title: "One task, one worktree",
    summary:
      "Each worktree is its own copy of the repo on its own branch, so parallel agents never collide.",
    narration:
      "Everything starts with a project, which is any git repository. [[list]] Its worktrees sit down the left. Each one is a separate copy of the repo on its own branch, so agents working on different tasks never trip over each other's changes. [[plus]] To start something new, click the plus button, [[name]] name the branch, [[create]] and create the worktree.",
  },
  {
    id: "agents",
    title: "Launch an agent",
    summary:
      "Start any agent CLI you have installed, then talk to it from the bar under its panel.",
    narration:
      "Daintree works with the agent tools you already have, like Claude Code, Codex, and Gemini. [[pick]] Click an agent in the toolbar, [[open]] and it opens in a panel inside the current worktree. [[type]] Type into the bar at the bottom of the panel. [[send]] Press Enter, and your prompt goes straight to the agent.",
  },
  {
    id: "state",
    title: "See who needs you",
    summary:
      "Each panel shows what Daintree can see of its agent: working, waiting for you, or done.",
    narration:
      "Every panel shows what Daintree can see of its agent. [[working]] A spinner means it's working. [[waiting]] A hollow circle means it looks like it's waiting for you, [[done]] and a check means it's finished. [[pill]] When agents are waiting, the dock shows how many. [[jump]] Click it to jump straight to them.",
  },
  {
    id: "fleet",
    title: "One prompt, many agents",
    summary:
      "Add panels to the fleet, then anything you send from one of them goes to all of them.",
    narration:
      "Sometimes several agents need the same instruction. [[menu]] Right-click a panel and choose Add to fleet, or press Command J. [[armed]] Panels in the fleet are marked with a small radio tower. [[type]] Now type in any one of them, [[send]] press Enter, and the prompt goes to the whole fleet at once.",
  },
  {
    id: "review",
    title: "Review and ship",
    summary: "Check every change an agent made, then commit and push without leaving Daintree.",
    narration:
      "When an agent finishes, check its work before it goes anywhere. [[files]] Open the worktree's changes to see every file it touched, [[diff]] and step through the diff. [[commit]] Then write a message, and commit and push, right from here. [[outro]] That's the essentials. You can replay this tour any time from the Help menu.",
  },
];
