import { eq } from "drizzle-orm";
import type { ClaudeUsageStorage } from "../claude/ClaudeUsageObservations.js";
import { getSharedDb, getSharedSqlite } from "./db.js";
import { appState as appStateTable } from "./schema.js";

/**
 * The Claude Code usage readings' row in `app_state` (#17610), beside other
 * Main-only state: sightings rather than settings, so nothing that exports or
 * syncs configuration carries the folders they name.
 */
const CLAUDE_USAGE_KEY = "claudeUsageObservations";

export const appStateClaudeUsageStorage: ClaudeUsageStorage = {
  read() {
    const row = getSharedDb()
      .select({ value: appStateTable.value })
      .from(appStateTable)
      .where(eq(appStateTable.key, CLAUDE_USAGE_KEY))
      .get();
    return row?.value ?? null;
  },
  write(value) {
    // getSharedDb() silently reopens a closed database, and shutdown closes it
    // while a pane's last reading may still be on its way to a save.
    if (getSharedSqlite() === null) return;
    getSharedDb()
      .insert(appStateTable)
      .values({ key: CLAUDE_USAGE_KEY, value })
      .onConflictDoUpdate({ target: appStateTable.key, set: { value } })
      .run();
  },
};
