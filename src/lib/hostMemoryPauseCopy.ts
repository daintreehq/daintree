/**
 * Copy for the app-wide terminal-host memory pause (#12375).
 *
 * The governor measures each terminal host's own budget (heap plus worker
 * isolates), never system RAM, and with the per-project PTY fabric only one
 * host may be paused — so nothing here says "system memory" or claims that
 * every terminal stopped. Nor does it promise a time: a pause can run to about
 * 12 seconds and re-engage straight away at critical pressure.
 */
export const HOST_MEMORY_PAUSE_COPY = {
  paused: {
    ariaLabel: "Terminal output paused for memory, show details",
    title: "Terminal output paused",
    body: "A terminal host went over its memory budget and paused output from its terminals. Output resumes on its own.",
  },
  monitoring: {
    ariaLabel: "Terminal host memory still high, show details",
    title: "Terminal host memory still high",
    body: "Output resumed, but a terminal host is still using most of its memory budget and may pause again.",
  },
  announcePaused: "Terminal output paused: a terminal host is over its memory budget",
  announceEnded: "Terminal host memory pause ended",
  stall: {
    title: "Terminal host memory still high",
    description:
      "A terminal host paused output over 30 seconds ago and still reports high memory use.",
    action: "Why am I slow?",
  },
} as const;
