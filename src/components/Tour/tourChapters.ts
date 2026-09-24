import type { TourChapter } from "./tourTypes";

/**
 * The narration source of truth. `[[cue]]` markers sit immediately before the
 * word the scene reacts to; `npm run tour:audio` voices the clean text and
 * resolves every cue to the moment that word is spoken.
 *
 * `[single brackets]` are delivery directions for the voice — how a line is
 * said, never what. Inworld's guidance: write them as short stage directions
 * that combine two dimensions (`[warm and welcoming, unhurried]` reads better
 * than `[warm]`), put them at the start of a sentence, and use them sparingly —
 * a direction holds until the next one, and every switch is an audible change
 * of register. The current narration uses none: the plain read is the one
 * that's been chosen.
 *
 * Write for the ear: spell out shortcuts ("Command J"), no symbols, no
 * abbreviations the voice would have to guess at. Editing a chapter's words or
 * directions marks its generated timing stale until the audio is regenerated.
 */
export const TOUR_CHAPTERS: readonly TourChapter[] = [
  {
    id: "welcome",
    title: "Welcome to Daintree",
    summary: "One window for the coding agents you already use, running side by side.",
    narration:
      "Welcome to Daintree. It's one window for the coding agents you already use, like Claude Code and Codex. [[first]] Instead of juggling terminal tabs, [[grid]] you run several of them side by side, and keep an eye on all of them at once. Let's take a quick look around.",
  },
  {
    id: "worktrees",
    title: "One task, one worktree",
    summary:
      "A worktree is a separate working folder on its own branch. Use one per task, and agents on different tasks never touch each other's files.",
    narration:
      "Everything starts with a project: any git repository you open. [[list]] Its worktrees sit down the left. Each one is a separate working folder on its own branch, so use one per task, and agents on different tasks never touch each other's files. [[plus]] To start a new task, click the plus button, [[name]] name its branch, [[create]] and create the worktree.",
  },
  {
    id: "agents",
    title: "Launch any installed agent",
    summary:
      "Every agent CLI you have installed gets a toolbar button. Each one opens in a panel in the current worktree.",
    narration:
      "Daintree works with whichever agent command line tools you've installed, like Claude Code, Codex, or Antigravity. [[pick]] Each one gets a button in the toolbar. [[click]] Click it, [[open]] and the agent opens in a panel inside the current worktree. [[type]] Type into the bar at the bottom of the panel, or click into the terminal and type there directly. [[send]] Press Enter, and your prompt goes straight to the agent.",
  },
  {
    id: "state",
    title: "See who needs you",
    summary:
      "Each panel shows what Daintree can see of its agent: working, waiting for you, or finished its turn.",
    narration:
      "Every panel shows what Daintree can see of its agent. [[working]] A spinner means it's working. [[waiting]] A hollow circle means it looks like it's waiting for you, [[done]] and a check means it's finished its turn, ready for you to review. [[pill]] When agents are waiting, the counter at the bottom right shows how many. [[jump]] Click it to jump straight to one, [[answer]] answer it in its panel, and it gets back to work.",
  },
  {
    id: "fleet",
    title: "One prompt, many agents",
    summary:
      "A fleet is a group of agents that all receive the same prompt. Shift-click panels in, and send once.",
    narration:
      "A fleet is a group of agents that all receive the same prompt. [[pick]] Shift-click each panel you want in it, [[bolt]] or use the lightning bolt in the sidebar to add every agent in a worktree. Shift-click again to take one out. [[armed]] Panels in the fleet are marked with a small radio tower. [[type]] Now type in any one of them, [[send]] press Enter, and every agent in the fleet gets the prompt.",
  },
  {
    id: "files",
    title: "Browse your files",
    summary:
      "Browse files opens the current worktree's files beside your agents. View any file's source, or drag it onto an agent to drop its path into the prompt.",
    narration:
      "You don't need to leave Daintree to look at the code. [[open]] Browse files in the toolbar opens the current worktree's files in a panel, right beside your agents. [[pick]] Click any file to view its source. [[ref]] And drag any file onto an agent's panel to drop its path into the prompt.",
  },
  {
    id: "context",
    title: "Hand your codebase to a web chat",
    summary:
      "Copy context packs the whole worktree into one block, ready to paste into a web-based agent with a bigger allowance.",
    narration:
      "Sometimes you'll want a web-based agent, like ChatGPT or Claude on the web, to see your whole codebase, since they often come with much bigger allowances. [[copy]] Copy context in the toolbar packs the entire worktree into one block on your clipboard. [[paste]] Paste it into any web chat, including the ones in Daintree's Portal, [[portal]] right here in the side panel.",
  },
  {
    id: "preview",
    title: "Preview your app live",
    summary:
      "For web projects, Dev preview starts your dev server and shows the running app in a panel, with its logs underneath.",
    narration:
      "For a web project, you can watch your app change while the agents work on it. [[launch]] Open the launcher from the plus in the toolbar, and pick Dev preview. [[start]] Daintree finds your dev script and starts the server for you, [[live]] and the page updates as the code changes. [[console]] The server's logs and the browser console sit just below it.",
  },
  {
    id: "github",
    title: "Work from your issues",
    summary:
      "Connect GitHub or GitLab and the toolbar counts open issues and pull requests. Pick an issue to start a worktree for it; later, pull request status and checks show on its card.",
    narration:
      "Daintree works with whichever code forge you're on, GitHub or GitLab. [[pill]] Once your project is connected, the counts in the toolbar are its open issues and pull requests. [[list]] Click one to browse them, [[pick]] and choose an issue to start a worktree for it, already linked. [[badge]] Later, once a pull request is open, its status and automated checks show right on the worktree's card.",
  },
  {
    id: "review",
    title: "Review and push",
    summary:
      "Ask your agent to commit and push for you, or review it yourself: Review and Commit shows every change in the worktree, then commits and pushes its branch.",
    narration:
      "When an agent finishes, you can simply ask it to commit and push the work for you. If you'd rather review it yourself, [[files]] its worktree in the sidebar shows what changed. [[open]] Press Review and Commit to see every file that changed, [[diff]] and step through the diff. [[commit]] Then write a message, and commit and push the branch, right from here.",
  },
  {
    id: "pilot",
    title: "Every agent, every project",
    summary:
      "Pilot lists every agent across every project, with whatever is waiting on you at the top of each project. Park anything that can wait.",
    narration:
      "Once you have agents running in more than one project, [[open]] press Command Option O to open Pilot. [[sort]] It lists every agent everywhere, grouped by project, with whatever is waiting on you at the top of each group. [[park]] Anything that can wait, you can park, and it stays out of your way until you're ready.",
  },
  {
    id: "assistant",
    title: "Meet the Daintree Assistant",
    summary:
      "An agent that runs Daintree for you. Ask in plain words, and it creates worktrees, starts agents, sends prompts, and keeps watch.",
    narration:
      "Finally, the Daintree Assistant: an agent that runs Daintree for you, while your other agents write the code. [[open]] Open it from the right of the toolbar. [[ask]] Ask for what you want in plain words, [[act]] and it creates worktrees, starts agents, and sends them their instructions. [[watch]] Then it keeps an eye on them, and tells you when one needs you. [[runs]] It runs on an agent you already have, like Claude Code or Codex, so there's nothing extra to set up.",
  },
  {
    id: "palette",
    title: "Find anything",
    summary:
      "Command Shift P searches every action in Daintree. The Help menu has this tour, the Getting Started checklist, and every shortcut.",
    narration:
      "When you can't remember where something lives, [[palette]] press Command Shift P. Type what you want to do, and every action in Daintree is right there. [[help]] The Help menu has this tour, the Getting Started checklist, and all the keyboard shortcuts.",
  },
  {
    id: "outro",
    title: "That's Daintree",
    summary:
      "Run the agents you already use side by side, each on its own task, and stay on top of all of them from one window.",
    narration:
      "[[logo]] That's Daintree. The agents you already use, side by side, each on its own task, [[why]] and one place to see what they're doing, step in when they need you, and ship what they build. [[next]] Next, the Getting Started checklist walks you through your first task.",
  },
];
