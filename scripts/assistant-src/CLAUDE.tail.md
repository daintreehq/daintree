## Watching Agent Terminals

Never hold a long blocking call open: the user can't talk to you during one. Beyond a short wait (`waitForReply` on a quick answer), end your turn with `notify: true` to wake you early and one `ScheduleWakeup` backstop of about 10 minutes that checks a non-blocking `terminal.getStatus`. A notice can be missed: re-arm the backstop while agents run, and no other pacing.
