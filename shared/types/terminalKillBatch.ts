import { z } from "zod";

/**
 * Ceiling on one batch kill.
 *
 * Far below `terminal.waitUntilIdleBatch`'s 256: that one is a read-only wait
 * nobody has to look at, while every id here becomes a row a human must read
 * before approving. A list long enough to need real scrolling is a list that
 * gets approved unread, which is the failure this dialog exists to prevent.
 */
export const MAX_KILL_BATCH_TERMINALS = 32;

/**
 * The id list a batch kill acts on.
 *
 * Lives here rather than beside the action because TWO surfaces have to agree
 * on it, and they run at different times: the action validates the dispatch,
 * and the MCP bridge decides — earlier, before any modal exists — whether the
 * args are shaped well enough to build a checklist from. A bridge that accepted
 * more than this would render a dialog the dispatch then refuses, and duplicate
 * ids in particular would give two rows the same React key and the same
 * checkbox identity, so unchecking one would silently uncheck its twin.
 */
export const TerminalKillBatchIdsSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(MAX_KILL_BATCH_TERMINALS)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "terminalIds must not repeat an id",
  });
