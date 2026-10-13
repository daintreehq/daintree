/** QuickRun's per-project localStorage keys: each prefix, then the host-scoped project key. */
export const QUICK_RUN_HISTORY_KEY_PREFIX = "daintree_cmd_history_";
export const QUICK_RUN_AUTO_RESTART_KEY_PREFIX = "daintree_quickrun_autorestart_";
export const QUICK_RUN_EXPANDED_KEY_PREFIX = "daintree_quickrun_expanded_";

export const QUICK_RUN_KEY_PREFIXES = [
  QUICK_RUN_HISTORY_KEY_PREFIX,
  QUICK_RUN_AUTO_RESTART_KEY_PREFIX,
  QUICK_RUN_EXPANDED_KEY_PREFIX,
] as const;
