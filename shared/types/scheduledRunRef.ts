/**
 * The scheduled run a `schedule`-spawned terminal belongs to (#15977): the
 * schedule and the run record ids from `shared/types/scheduledRuns.ts`. Present
 * exactly when `spawnedBy` is `"schedule"`; `shared/utils/scheduledRunProvenance.ts`
 * keeps the pair together wherever it is read back.
 *
 * In a module of its own, importing nothing, because `actions.ts` names it and
 * the plugin packages bundle that file's declarations: reaching it through
 * `panel.ts` would pull the theme and xterm's typings into their build.
 */
export interface ScheduledRunRef {
  scheduleId: string;
  runId: string;
}
