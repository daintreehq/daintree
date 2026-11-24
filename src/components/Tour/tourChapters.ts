import type { TourChapter } from "@daintreehq/tour";

/**
 * The narration source of truth. `[[cue]]` markers sit immediately before the
 * word the scene reacts to; `npm run tour:audio` voices the clean text and
 * resolves every cue to the moment that word is spoken.
 *
 * `[single brackets]` are delivery directions for the voice — how a line is
 * said, never what. Keep them to one word, at the start of a sentence, and use
 * them sparingly: a direction holds until the next one, and every switch is an
 * audible change of register. The current narration uses none: the plain read
 * is the one that's been chosen.
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
    summary:
      "One window for the coding agents you already use, running side by side on one computer or several.",
    narration:
      "Welcome to Daintree. It's one window for the coding agents you already use, like [[first]] Claude Code and [[second]] Codex. Instead of juggling terminal tabs, [[grid]] you run several of them side by side, on this computer or spread across a few, and [[watch]] keep an eye on all of them from here. Let's take a quick look around.",
  },
  {
    id: "worktrees",
    title: "One task, one worktree",
    summary:
      "A worktree is a separate working folder on its own branch. Use one per task, and agents on different tasks don't step on each other's files.",
    narration:
      "Everything starts with a [[project]] project: any folder you open. When it's a git repository, its [[list]] worktrees are listed down the left. Each one is a separate working folder on [[branch]] its own branch, so use one per task, and agents on different tasks don't step on each other's files. To start a new task, click the [[plus]] plus button, [[name]] name its branch, like add search, and [[create]] create the worktree. The [[form]] same form can also start an [[agent]] agent there with its [[prompt]] first task, or you can leave the worktree [[empty]] empty and add agents yourself.",
  },
  {
    id: "agents",
    title: "Launch any installed agent",
    summary:
      "Pinned agents get buttons in the toolbar, and the plus button launches any installed one. Each opens in a panel in the current worktree.",
    narration:
      "Daintree works with any agent command line tool you've installed, like [[agents]] Claude Code, Codex, or Antigravity. The ones you [[pick]] pin get buttons in the toolbar, and the [[launcher]] plus button lists every one you have installed. [[click]] Click one, and it [[open]] opens in a panel inside the current worktree. [[type]] Type your prompt into the bar at the bottom of the panel, and [[send]] press Enter to send it. Or click into the [[term]] terminal itself and type there, just like any other terminal.",
  },
  {
    id: "state",
    title: "See who needs you",
    summary:
      "Each panel shows what Daintree can see of its agent: working, waiting for you, or finished with something new to read.",
    narration:
      "Every panel shows what Daintree can see of its agent. A [[working]] spinner means it's working. A [[waiting]] hollow circle means it looks like it's waiting for you. A [[unread]] solid circle means it looks finished and has something new for you to read, and once you've read it, it turns into a [[done]] check. When agents are waiting, the [[pill]] Attention counter at the bottom right shows how many. [[jump]] Click it to see which ones, [[pick]] pick one to jump to its panel, [[answer]] answer it, and it gets back to work.",
  },
  {
    id: "fleet",
    title: "One prompt, many agents",
    summary:
      "A fleet is a group of agents that all receive the same prompt. Shift-click title bars to build one, and press Exit in the fleet bar to leave it.",
    narration:
      "A fleet is a group of agents that all receive the same prompt. [[pick]] Shift-click a panel's title bar to add it, and [[out]] shift-click again to take it out. Panels in the fleet show a small [[armed]] radio tower. You can also [[hover]] hover over the top of the sidebar and click the [[bolt]] lightning bolt to pick them from a [[list]] list. Now [[type]] type in any one of them, and your words appear in the others too. [[send]] Press Enter, and every agent gets the prompt. When you're done, press [[exit]] Exit in the fleet bar at the top.",
  },
  {
    id: "files",
    title: "Your code, beside your agents",
    summary:
      "Browse files opens the worktree's files beside your agents; drag one onto an agent to reference it. Copy context copies the whole worktree for a web chat.",
    narration:
      "You don't need to leave Daintree to look at the code. [[open]] Browse files in the toolbar opens the current worktree's files in a panel, right beside your agents. [[pick]] Click any file to view its source, then [[ref]] drag it onto an agent's panel, and a [[drop]] reference to that file drops into the prompt bar, ready to send. And when you want a web chat like ChatGPT or Claude to see the whole codebase, click [[copy]] Copy context in the toolbar and choose [[full]] Copy full context. The entire worktree goes to your [[clipboard]] clipboard, ready to [[paste]] paste wherever you like.",
  },
  {
    id: "preview",
    title: "Preview your app live",
    summary:
      "For web projects, Dev preview runs your dev server and shows the app in a panel, with its logs in the Output drawer.",
    narration:
      "For a web project, you can watch your app change while the agents work on it. [[launch]] Open the launcher from the plus in the toolbar, and pick [[pickpreview]] Dev preview. The first time, Daintree finds your dev script and asks to run it. [[start]] Click Run, and the page [[live]] updates as the code changes. The [[output]] Output drawer along the bottom has the server's logs and the browser [[console]] console.",
  },
  {
    id: "github",
    title: "From issue to pull request",
    summary:
      "Add your forge token and the toolbar counts open issues and pull requests. Start a worktree from a GitHub issue, then have the agent open the pull request, or review it yourself in Review Hub.",
    narration:
      "Daintree works with whichever code forge you're on, like GitHub or GitLab. Once you add your token in Settings, the [[pill]] counts in the toolbar are the project's open issues and pull requests. On GitHub, [[list]] click one to browse them right here, [[pick]] open an issue's actions menu, and [[choose]] choose Create worktree. The form opens with the branch already named, and the [[create]] worktree stays tied to that issue. When the agent's done, the simplest thing is to [[ask]] ask it to commit, push and [[pr]] open the pull request for you. Its [[badge]] status and checks then show right on the worktree's card. If you'd rather [[files]] look first, click the [[open]] commit icon on that card. It opens Review Hub, which [[diff]] steps you through every change, and [[commit]] commits and pushes the branch from there.",
  },
  {
    id: "pilot",
    title: "All your agents at once",
    summary:
      "All agents lists every agent on this computer, grouped by project, with whatever is waiting on you at the top of each group. Park anything that can wait.",
    narration:
      "Once you have agents running in more than one project, [[open]] press {{pilot.toggle}} to see every agent on this computer at once. They're grouped by project, with [[sort]] whatever is waiting on you at the top of each group. [[park]] If something can wait, press {{Alt+Enter}} to park it. The agent keeps running, but it stops asking for your attention until you're ready.",
  },
  {
    id: "hosts",
    title: "Spread the work across machines",
    summary:
      "Add a machine over SSH or from a cloud account, switch the window to it from the chip by the project name, and run worktrees there.",
    narration:
      "When one computer isn't enough, add another. In [[settings]] Settings, under [[hosts]] Hosts, click [[add]] Add host and point it at a Mac or Linux machine you can reach over [[ssh]] SSH, and Daintree [[install]] installs itself there. Or connect a [[cloud]] cloud account, like DigitalOcean, AWS or Google Cloud, and Daintree [[provision]] creates the machine for you. Once you've added one, a [[chip]] chip next to the project name shows which machine this window is working on. [[pick]] Pick another machine from it, and the whole window [[switch]] switches over. When you create a worktree, you [[placement]] choose the machine it runs on, or ask for a [[fresh]] brand new one just for that task. Your agents [[running]] keep running there, even while your laptop sleeps.",
    // Remote Hosts reach only WSL distributions from Windows, so its SSH and cloud lines aren't true there.
    platforms: ["darwin", "linux"],
  },
  {
    id: "canopy",
    title: "One inbox for every agent",
    summary:
      "Canopy reads each agent's screen with a small model on your computer and gathers them all into one inbox, permission requests first.",
    narration:
      "Once your agents are spread across projects and machines, Canopy gives you one inbox for all of them. Click the [[telescope]] telescope in the toolbar, and the first time, press [[enable]] Turn on Canopy. A small model that comes with Daintree [[local]] reads each agent's screen, right here on your computer. Anything asking for [[permission]] permission goes to the top of the list, across every project, and across [[machines]] every machine if you choose. It shows [[progress]] how far each run has got, and pulls out the one that's gone [[quiet]] quiet. You can [[answer]] answer straight from the list.",
  },
  {
    id: "decisions",
    title: "Answer from anywhere",
    summary:
      "An agent can send you its question and carry on; it reaches your phone through your own encrypted relay, and your answer is typed into the terminal that asked.",
    narration:
      "Agents often stop on a question the moment you step away. [[enable]] Turn on Decisions in Settings, and an agent can [[ask]] send that question through Daintree and keep going with whatever doesn't depend on the answer. The question reaches your phone through a [[relay]] relay you set up in your own Cloudflare account, [[encrypted]] encrypted the whole way. [[answer]] Answer it on your phone, and Daintree [[deliver]] types your answer into the terminal that asked. When you're back at your desk, the same questions wait in the [[inbox]] Decisions inbox in the toolbar.",
  },
  {
    id: "assistant",
    title: "Meet the Daintree Assistant",
    summary:
      "An agent that runs Daintree for you. Ask in plain words, and it creates worktrees, starts agents, sends prompts, and keeps watch, for one project or all of them.",
    narration:
      "Finally, the Daintree Assistant: an agent that runs Daintree for you, while your other agents write the code. [[open]] Open it from the right of the toolbar, and [[start]] start it. [[ask]] Ask for what you want in plain words, and it [[act]] creates worktrees, starts agents, and sends them their instructions. Then it [[watch]] keeps an eye on them, and [[tell]] tells you when one needs you. Switch it to [[global]] Global, and one assistant looks after every project, and the other [[machines]] machines you've let it work on. It [[runs]] runs on an agent you already have, like Claude Code or Codex, so there's no extra subscription.",
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
      "Run the agents you already use side by side, each on its own task, on whichever machine has the room, and stay on top of all of them from one window.",
    narration:
      "[[logo]] That's Daintree. The agents you already use, [[side]] side by side, each on [[task]] its own task, on whichever machine has the room, and one place to [[see]] see what they're doing, step in when they need you, and [[ship]] ship what they build. [[next]] Next, the Getting Started checklist walks you through running your first agents.",
  },
];
