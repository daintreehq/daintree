# When done

Any agent terminal can be armed with a **When done** choice (#16171): keep (the default, and the behaviour of a terminal nobody armed), background, or close. The agent reports a fact, `done` or `needs-you`, through a handback marker, and the terminal's choice decides what happens. There is no separate "close" marker for an agent to print. Scheduled runs keep their own done policy (`scheduled-runs.md`, "The done policy") and share only its close and background operations.

## Arming

- **From the pane's menu.** Right-click → When done → Keep open, Move to background, or Close, keeping the session (`terminal.setWhenDone`). Only a pane with a live agent offers it, never the Assistant's own terminal, and only the project's driver may arm it, as only the driver may submit to it. The pane header shows a chip naming the choice while it holds.
- **The instruction goes at once.** Any choice but keep sends the agent the handback instruction that offers both markers (`HANDBACK_RUN_INSTRUCTION_TEMPLATE`) with a fresh code, as one message of its own, so an agent working on a prompt typed straight into it hands that work back. Picking a choice again renews it with a new code. Choices asked for in quick succession settle on the last one asked: an earlier one whose host read answers later commits nothing.
- **Every later prompt carries its own code.** While the terminal stays armed, `PtyClient.submit` rewrites every submission to it, whoever sent it (input bar, fleet, Review Hub, MCP and assistant sends), to end with the instruction for a fresh code, which becomes the outstanding request. A caller's own code (an orchestrator waiting on its handback) is kept, its instruction swapped for the one offering `needs-you`, so its wait still sees the marker. A bare Enter or a slash command is no prompt: it isn't rewritten, and it supersedes the outstanding request as any later send does on the host.
- **Prompts typed into the agent's own prompt** never pass through Daintree and carry no code. Arming from the menu is how those panes take part.

## Acting

- **Only the agent's own report acts.** The pty-host reports a marker for an armed request (`agent:run-handback-observed`) only for the capture that retires its code, under the ordinary detector rules: the echoed instruction, a marker still streaming, and one on a spinner line are refused, and a marker drafted while the agent works waits for its settle. Main acts only when the code is the terminal's outstanding one, from the incarnation it was armed on, once. A marker with no code, a wrong code, or an earlier request's code does nothing, wherever it appears: a file the agent reads, command output, or a transcript Codex re-prints on resize.
- **`needs-you` never moves anything.** It answers the request; the terminal stays armed for the next prompt. Agent state, process exit and silence never act either.
- **Background** matches a scheduled run's: each local view moves the pane to the background and main parks it in the saved layout. The terminal stays armed.
- **Close** matches a scheduled run's: a graceful kill that captures the session id and journals it for resuming (`agent-session:captured`, boundary `kill`), guarded by the incarnation's `spawnedAt` and launch generation; then each view removes the pane and main takes it out of the saved layout.
- **A newer word wins.** Between the report and the move, main waits on the views. If a newer send reaches the terminal, its choice changes, it restarts, someone takes the project over from another machine, or Daintree starts quitting, nothing moves. Main asks again just before the kill and before each view is sent the move, and a removal is never delivered once a successor has spawned under the id.

## Never from under someone

Before moving a pane, main asks every on-screen view of the project whether someone is using it, and leaves it where it is if any says yes or can't answer within two seconds. A view says yes when the pane, or its expanded composer (which portals out of the pane and names it with `data-composer-terminal-id`), holds real keyboard focus in a focused window, or its composer holds a non-blank draft. A cached view is off screen and isn't asked. A project driven from another machine's Shell always counts as in use. A view checks again when main asks it to move the pane, and keeps a pane someone started using in between; a closed terminal's pane is then left exited, its session already captured.

A `done` that finds the pane in use is consumed without moving it, and nothing tries again later: losing focus afterwards does nothing. The choice stays for the next prompt.

## After a restart

The choice lives in main's memory alone and belongs to one incarnation: a terminal restart, a crash replay, the terminal exiting or its agent leaving the PTY drops it, and an app restart loses it. A view reads main's list when it loads and shows a terminal as armed only while main still holds it, so nothing shown as armed can act on a code minted for an agent that is no longer there, and nothing acts on one that isn't shown.

Main follows the facts it needs (the handback reports, exits, losses) and decorates submissions only while a terminal is armed; with none armed it pays nothing.
