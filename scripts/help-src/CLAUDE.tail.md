## Watching Agent Terminals

Never hold a long blocking call open: the user can't talk to you during one. Beyond a short wait (`waitForReply` on a quick answer), end your turn and let a `notify: true` notice wake you, or pace with `ScheduleWakeup` and a non-blocking `terminal.getStatus` each time; one pacing mechanism at a time.
