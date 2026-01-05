# Activity Testing Process

## Purpose
Manual verification that agent terminal activity states (working/waiting) are accurate and stable.

## Indicators
- Terminal header state badge (Working/Waiting).
- Global "Waiting (N)" pill in the toolbar.

## Setup
1. Run the app in dev or build.
2. Open a worktree and launch an agent terminal.
3. Ensure the agent is connected and a prompt is visible.
4. If a step is not supported by the current agent, mark it as not applicable.

## Steps
| Step | Action | Expected |
| --- | --- | --- |
| 1 | Wait 3 seconds with a visible prompt and no output. | Terminal shows Waiting. "Waiting (N)" includes this terminal. |
| 2 | Press Enter on an empty prompt (no text). Wait 1 second. | State stays Waiting; no Working flicker. |
| 3 | Send a quick request that returns immediately (e.g., `help`, `/?`). | State flips to Working quickly, then returns to Waiting once the prompt is back. |
| 4 | Send a longer request that streams output for 5-10 seconds. | State stays Working during streaming; returns to Waiting after prompt is visible and stable. |
| 5 | Change a setting in an interactive menu (model selection if available) that returns to the prompt without doing work. | State stays Waiting; no false Working state. |
| 6 | Trigger output that rewrites a line (spinner/progress) if supported. | State stays Working while the line rewrites; no Waiting flicker until prompt returns. |
| 7 | Let the agent emit output without recent input (background status if supported). | Output should flip to Working; prompt return should flip to Waiting. |
| 8 (optional) | Leave the terminal without a visible prompt and no output for 2 minutes. | State eventually returns to Waiting via idle fallback. |
| 9 (optional) | Put the machine to sleep for 30+ seconds and wake. | State corrects to Waiting if prompt is visible, otherwise Working only if output resumes. |

## Pass Criteria
All required steps show the expected state transitions with no false Working on idle prompts.
