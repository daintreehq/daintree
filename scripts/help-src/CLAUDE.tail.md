## Watching Agent Terminals

Never hold a long blocking call open: the user can't talk to you during one. Beyond one short wait, end your turn and let a `notify: true` notice wake you, or pace with `ScheduleWakeup` and take a non-blocking `terminal.getStatus` snapshot each time — one pacing mechanism at a time. For a fleet, the `daintree` server's `triage_terminals` prompt has the polling recipe.
