import type { TourChapter } from "@daintreehq/tour";

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
 * Write for the ear: no symbols, no abbreviations the voice would have to guess
 * at. Shortcuts are `{{tokens}}`, never spelled out: `{{action.id}}` for an
 * action's default binding, `{{Alt+Enter}}` for a key the app hard-codes. A
 * chapter with a token is voiced once per keyboard ("Command Option O" on a
 * Mac, "Control Alt O" on Windows and Linux), each with its own timing.
 * Editing a chapter's words or directions marks its generated timing stale
 * until the audio is regenerated.
 */
export const TOUR_CHAPTERS: readonly TourChapter[] = [
  {
    id: "welcome",
    title: "Welcome to Daintree",
    summary: "One window for the coding agents you already use, running side by side.",
    narration:
      "Welcome to Daintree. It's one window for the coding agents you already use, like [[first]] Claude Code and [[second]] Codex. Instead of juggling terminal tabs, [[grid]] you run several of them side by side, and [[watch]] keep an eye on all of them at once. Let's take a quick look around.",
  },
  {
    id: "worktrees",
    title: "One task, one worktree",
    summary:
      "A worktree is a separate working folder on its own branch. Use one per task, and agents on different tasks don't step on each other's files.",
    narration:
      "Everything starts with a [[project]] project: any folder you open. When it's a git repository, [[list]] its worktrees sit down the left. Each one is a separate working folder on [[branch]] its own branch, so use one per task, and agents on different tasks don't step on each other's files. [[plus]] To start a new task, click the plus button, [[name]] name its branch, like add search, [[create]] and create the worktree. It opens empty, ready for its first agent.",
  },
  {
    id: "agents",
    title: "Launch any installed agent",
    summary:
      "Pin your agents to the toolbar, or launch any installed one from the plus button. Each opens in a panel in the current worktree.",
    narration:
      "Daintree works with any agent command line tool you've installed, like [[agents]] Claude Code, Codex, or Antigravity. [[pick]] Your agents get buttons in the toolbar, [[launcher]] and the plus button lists every one you have installed. [[click]] Click one, [[open]] and it opens in a panel inside the current worktree. [[type]] Type your prompt into the bar at the bottom of the panel, [[send]] and press Enter to send it. [[term]] Or click into the terminal itself and type there, just like any other terminal.",
  },
  {
    id: "state",
    title: "See who needs you",
    summary:
      "Each panel shows what Daintree can see of its agent: working, waiting for you, or finished.",
    narration:
      "Every panel shows what Daintree can see of its agent. [[working]] A spinner means it's working. [[waiting]] A hollow circle means it looks like it's waiting for you, [[done]] and a check means it looks finished, ready for you to review. [[pill]] When agents are waiting, the counter at the bottom right shows how many. [[jump]] Click it to see which ones, [[pick]] pick one to jump to its panel, [[answer]] answer it, and it gets back to work.",
  },
  {
    id: "fleet",
    title: "One prompt, many agents",
    summary:
      "A fleet is a group of agents that all receive the same prompt. Shift-click title bars to build one; click any panel to leave it.",
    narration:
      "A fleet is a group of agents that all receive the same prompt. [[pick]] Shift-click a panel's title bar to add it, [[out]] and shift-click again to take it out. [[armed]] Panels in the fleet show a small radio tower. [[bolt]] You can also click the lightning bolt in the sidebar to pick them from a list. [[type]] Now type in any one of them, and your words appear in the others too. [[send]] Press Enter, and every agent gets the prompt. [[exit]] Click any panel without Shift to leave the fleet.",
  },
  {
    id: "files",
    title: "Browse your files",
    summary:
      "Browse files opens the current worktree's files beside your agents. View any file's source, or drag it onto an agent to drop a reference into its prompt.",
    narration:
      "You don't need to leave Daintree to look at the code. [[open]] Browse files in the toolbar opens the current worktree's files in a panel, right beside your agents. [[pick]] Click any file to view its source. [[ref]] Then drag it onto an agent's panel, [[drop]] and a reference to that file drops into the prompt bar, ready to send.",
  },
  {
    id: "context",
    title: "Hand your codebase to a web chat",
    summary:
      "Copy context copies the whole worktree in one go, ready to paste into a web chat with a bigger allowance.",
    narration:
      "Web chats like ChatGPT or Claude often come with bigger allowances, so sometimes you'll want them to see your whole codebase. [[copy]] Copy context in the toolbar copies the entire worktree to your clipboard in one go. [[portal]] Open the Portal in the side panel, [[paste]] and paste it into any web chat there.",
  },
  {
    id: "preview",
    title: "Preview your app live",
    summary:
      "For web projects, Dev preview runs your dev server and shows the app in a panel, with its logs a click away.",
    narration:
      "For a web project, you can watch your app change while the agents work on it. [[launch]] Open the launcher from the plus in the toolbar, and pick [[pickpreview]] Dev preview. The first time, Daintree finds your dev script and asks to run it. [[start]] Click Run, [[live]] and the page updates as the code changes. [[console]] The console button opens the server's logs and the browser console underneath.",
  },
  {
    id: "github",
    title: "Work from your issues",
    summary:
      "Add your GitHub or GitLab token and the toolbar counts open issues and pull requests. Start a worktree from an issue's actions menu; its pull request and checks show on the card.",
    narration:
      "Daintree works with whichever code forge you're on, GitHub or GitLab. [[pill]] Once you add your token in Settings, the counts in the toolbar are the project's open issues and pull requests. [[list]] Click one to browse them. Clicking an issue's title opens it in your browser; to work on it here, [[pick]] open its actions menu and [[choose]] choose Create worktree. The form opens with the branch already named. [[create]] Create it, and the worktree stays tied to that issue. [[badge]] Later, once a pull request is open, its status and checks show right on the worktree's card.",
  },
  {
    id: "review",
    title: "Review and push",
    summary:
      "Ask your agent to commit and push for you, or review it yourself: Review & commit shows every change in the worktree, then commits and pushes its branch.",
    narration:
      "When an agent finishes, you can simply [[ask]] ask it to commit and push the work for you. If you'd rather review it yourself, [[files]] its worktree in the sidebar shows what changed. [[open]] Press Review and commit to see every file that changed, [[diff]] and step through the diff. [[commit]] Then write a message, and commit and push the branch, right from here.",
  },
  {
    id: "pilot",
    title: "All your agents at once",
    summary:
      "All agents lists every agent across every project, with whatever is waiting on you at the top of each group. Park anything that can wait.",
    narration:
      "Once you have agents running in more than one project, [[open]] press {{pilot.toggle}} to see all your agents at once. They're grouped by project, with [[sort]] whatever is waiting on you at the top of each group. [[park]] If something can wait, press {{Alt+Enter}} to park it. The agent keeps running, but it stops asking for your attention until you're ready.",
  },
  {
    id: "assistant",
    title: "Meet the Daintree Assistant",
    summary:
      "An agent that runs Daintree for you. Start it, ask in plain words, and it creates worktrees, starts agents, sends prompts, and keeps watch.",
    narration:
      "Finally, the Daintree Assistant: an agent that runs Daintree for you, while your other agents write the code. [[open]] Open it from the right of the toolbar, and [[start]] start it. [[ask]] Ask for what you want in plain words, [[act]] and it creates worktrees, starts agents, and sends them their instructions. [[watch]] Then it keeps an eye on them, and [[tell]] tells you when one needs you. [[runs]] It runs on an agent you already have, like Claude Code or Codex, so there's no extra subscription.",
  },
  {
    id: "palette",
    title: "Find anything",
    summary:
      "The command palette searches every action in Daintree. The Help menu has this tour, the Getting Started checklist, and every shortcut.",
    narration:
      "When you can't remember where something lives, [[palette]] press {{action.palette.open}}. [[type]] Type what you want to do, and every action in Daintree is right there. [[help]] The Help menu has this tour, the Getting Started checklist, and all the keyboard shortcuts.",
  },
  {
    id: "outro",
    title: "That's Daintree",
    summary:
      "Run the agents you already use side by side, each on its own task, and stay on top of all of them from one window.",
    narration:
      "[[logo]] That's Daintree. The agents you already use, [[side]] side by side, each on [[task]] its own task, and one place to [[see]] see what they're doing, step in when they need you, and [[ship]] ship what they build. [[next]] Next, the Getting Started checklist walks you through running your first agents.",
  },
];
