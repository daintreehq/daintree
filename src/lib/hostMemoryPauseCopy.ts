/**
 * Copy for the app-wide terminal-host memory pause (#12375).
 *
 * It says what the governor did, not what it measured. The governor watches
 * each terminal host's own budget (heap plus worker isolates), never system
 * RAM, and pauses well short of the whole budget; a lifted pause doesn't mean
 * output is flowing either, since a pane's own backpressure can still hold it.
 * With the per-project PTY fabric only one host may be paused, so nothing
 * claims that every terminal stopped. Nor is a time promised: a pause can run
 * to about 12 seconds and re-engage straight away at critical pressure — and
 * what lifts on its own is the memory pause, not output as such.
 */
export const HOST_MEMORY_PAUSE_COPY = {
  paused: {
    ariaLabel: "Terminal output paused for memory, show details",
    title: "Terminal output paused",
    body: "A terminal host paused its output to reduce its memory use. The pause lifts on its own.",
  },
  monitoring: {
    ariaLabel: "Memory pause lifted, terminal host memory warning, show details",
    title: "Memory pause lifted",
    body: "A terminal host still reports a memory warning and may pause output again.",
  },
  detailsHint: "Click to open Why slow?",
  whySlow: {
    paused: "A terminal host paused its output to reduce its memory use",
    monitoring: "A terminal host lifted its memory pause but still reports a memory warning",
    suggestion: "The pause lifts on its own",
    chipPaused: "terminal output paused for memory",
    chipLifted: "terminal host memory warning",
  },
  announcePaused: "Terminal output paused to reduce terminal host memory use",
  announceEnded: "Terminal host memory pause ended",
  stall: {
    title: "Terminal host memory pressure persists",
    description:
      "A terminal host paused output over 30 seconds ago and still reports memory pressure.",
    action: "Why am I slow?",
  },
} as const;
