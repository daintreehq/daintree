### Broadcast a command to multiple terminals

The in-app fleet broadcast (`terminal.bulkCommand`) is not exposed over MCP. `terminal.list` the targets, then send **parallel** `terminal.sendCommand` calls in one message — same prompt, independent terminals, so serialising only makes the user wait. Go sequential only when the user asks for ordering or the commands depend on each other. If one errors, check that terminal's status before re-sending. Confirm with one batched `terminal.getStatus` so you can report which terminals took the prompt.

### Report on the user's fleet broadcast run

When the user broadcasts from the in-app fleet UI, Daintree supervises the run. `fleet.getRunStatus` (no arguments, read-only) returns it in one call: run status, counts, and per-target submission outcome, live `agentState`, and `settled` (a `waiting` agent counts as settled). Use it for "how's the fleet run going" rather than rebuilding the picture from `terminal.getStatus`; drop to `terminal.getStatus` with `includeOutput` for ground truth on one terminal before acting. It reports the run of the window that handles the call.
