import fsp from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { AgentSubagent } from "../../../shared/types/ipc/agentSubagents";
import type { PerfScenario, ScenarioSample, ScenarioTier } from "../types";
import {
  armBystanderProbe,
  bystanderMetrics,
  type BystanderProbe,
  type BystanderReading,
} from "../lib/bystander";
import {
  buildClaudeSubagentStore,
  emptyTally,
  expectedRows,
  fixtureMisses,
  fsMark,
  fsObserverHookMisses,
  fsSince,
  injectOpenFault,
  installFsObserver,
  loadClaudeSubagentArms,
  PROBE_WINDOW_BYTES,
  rowDifferences,
  specChild,
  uninstallFsObserver,
  writeChildFiles,
  type ChildSpec,
  type FsTally,
  type ListArm,
  type StoreFixture,
} from "../lib/claudeSubagentFixture";

/**
 * The Claude subagent list the way `useSubagents` polls it (#15681).
 *
 * Every Claude terminal whose parent is working, or that has a live child,
 * asks main for its children every 5 s, and main answers with
 * `listSubagentsInDir`. These scenarios build a store of real transcripts and
 * sidecars at the sizes Claude Code writes and drive that function over it in
 * sweeps, one list per polled session, the way a set of terminals would.
 *
 * Two arms share every run: the shipped reader (`current`) and the reader as
 * it stood before #15681, frozen verbatim in `lib/claudeSubagentReference.ts`
 * (`reference`). Each arm keeps its own module cache across its sweeps, the
 * same cache every polled terminal shares in the app, so the reference arm
 * reproduces the cliff the issue measured and the pair is a before/after on
 * one machine in one session.
 *
 * Each run: qualify the filesystem observer, reset both caches, one priming
 * sweep per arm (the cold list, reported separately), then four measured
 * sweeps per arm in alternating arm order, each with a bystander probe on the
 * loop. The status clock advances by the poll interval each sweep, so a row's
 * status is re-derived against a moving `now` exactly as it is between polls;
 * the sweeps themselves run back to back, inside the cache's warm window.
 * Cache expiry across real 5 s gaps belongs to the unit tests.
 *
 * Every row either arm returns is graded twice, outside the timed brackets:
 * against the other arm, and against the fixture's own record of what it
 * wrote. After the sweeps a supplemental session, listed until its targets
 * are cached, takes the mutations the cache has to see through — an appended
 * transcript, an atomic replace that keeps size and mtime, a sidecar that
 * arrives late, symlinked transcript and sidecar, a status that ages out with
 * no write, and newest children that cannot be read (an injected EACCES on
 * every platform, a real chmod where mode bits gate reads).
 *
 * Counts and bytes come from an observer on `fs/promises`, scoped to the
 * fixture root and proven to see the readers' own `open` binding before any
 * count is trusted. Bytes are what `read` returned, not buffer capacity, and
 * are userspace reads from a warm page cache, not disk traffic.
 */

const POLL_MS = 5_000;
const MEASURED_SWEEPS = 4;
const ACTIVE_WINDOW_MS = 2 * 60_000;
const LIST_LIMIT = 50;

const CORRECTNESS = [
  "fsObserverMisses",
  "fixtureMisses",
  "rowMisses",
  "expectedRowMisses",
  "statusAgeMisses",
  "appendMisses",
  "atomicReplaceMisses",
  "lateSidecarMisses",
  "symlinkMisses",
  "unreadableNewestMisses",
  "bystanderProbeMisses",
] as const;

type Correctness = Record<(typeof CORRECTNESS)[number], number>;

const stores = new Map<string, Promise<StoreFixture>>();

/** One store per shape per process, reused across iterations: only the oracle session is mutated. */
function storeFor(sessions: number, children: number): Promise<StoreFixture> {
  const key = `${sessions}x${children}`;
  let store = stores.get(key);
  if (!store) {
    store = buildClaudeSubagentStore(sessions, children);
    stores.set(key, store);
  }
  return store;
}

let runCounter = 0;

interface SweepReading {
  lists: number;
  wallMs: number;
  cpuMs: number;
  fs: FsTally;
  /** Rows per list, in sweep-then-session order. */
  rows: AgentSubagent[][];
  nows: number[];
}

function emptySweep(): SweepReading {
  return {
    lists: 0,
    wallMs: 0,
    cpuMs: 0,
    fs: emptyTally(),
    rows: [],
    nows: [],
  };
}

function addTally(into: FsTally, from: FsTally): void {
  into.transcriptOpens += from.transcriptOpens;
  into.sidecarOpens += from.sidecarOpens;
  into.transcriptReadBytes += from.transcriptReadBytes;
  into.sidecarReadBytes += from.sidecarReadBytes;
  into.readCalls += from.readCalls;
  into.lstatCalls += from.lstatCalls;
}

/** One list per session, each bracketed for wall, CPU and filesystem calls on its own. */
async function sweep(
  arm: ListArm,
  store: StoreFixture,
  now: number,
  into: SweepReading
): Promise<void> {
  for (const session of store.sessions) {
    const mark = fsMark();
    const cpu = process.cpuUsage();
    const started = performance.now();
    const rows = await arm.list(session.dir, now);
    into.wallMs += performance.now() - started;
    const spent = process.cpuUsage(cpu);
    into.cpuMs += (spent.user + spent.system) / 1000;
    addTally(into.fs, fsSince(mark));
    into.lists += 1;
    into.rows.push(rows);
    into.nows.push(now);
  }
}

function sweepMetrics(
  prefix: string,
  reading: SweepReading,
  sweeps: number
): Record<string, number> {
  const lists = Math.max(1, reading.lists);
  return {
    [`${prefix}TranscriptProbesPerList`]: reading.fs.transcriptOpens / lists,
    [`${prefix}TranscriptProbesPerSweep`]: reading.fs.transcriptOpens / Math.max(1, sweeps),
    [`${prefix}SidecarOpensPerList`]: reading.fs.sidecarOpens / lists,
    [`${prefix}ReadBytesPerList`]:
      (reading.fs.transcriptReadBytes + reading.fs.sidecarReadBytes) / lists,
    [`${prefix}StatCallsPerList`]: reading.fs.lstatCalls / lists,
    [`${prefix}WallMsPerList`]: reading.wallMs / lists,
    [`${prefix}CpuMsPerList`]: reading.cpuMs / lists,
  };
}

/**
 * 0 when the observer provably sees both readers' opens and reads.
 *
 * Two facts. The named `open` binding the readers import is the wrapper —
 * without `syncBuiltinESMExports` it would not be, and every count would read
 * a flattering zero. And a cold list of one fresh child past both probe
 * windows registers exactly the reads a cold list has to make: one transcript
 * open with a full window from each end, and one sidecar open returning the
 * whole sidecar. A path neither cache has seen guarantees the list is cold.
 */
async function fsObserverQualification(
  root: string,
  arms: ListArm[],
  baseNowMs: number
): Promise<number> {
  let misses = fsObserverHookMisses();
  const dir = path.join(root, `qualify-${runCounter}`, "subagents");
  await fsp.mkdir(dir, { recursive: true });
  try {
    for (const arm of arms) {
      const child = specChild(
        dir,
        900_000 + runCounter,
        baseNowMs - 3_600_000,
        "ended",
        true,
        300 * 1024
      );
      await writeChildFiles(child, 900_000 + runCounter);
      const sidecarSize = (await fsp.stat(child.file.replace(/\.jsonl$/, ".meta.json"))).size;
      const mark = fsMark();
      const rows = await arm.list(dir, baseNowMs);
      const seen = fsSince(mark);
      if (rows.length !== 1 || rows[0]?.id !== child.id) misses += 1;
      if (seen.transcriptOpens !== 1) misses += 1;
      if (seen.transcriptReadBytes !== 2 * PROBE_WINDOW_BYTES) misses += 1;
      if (seen.sidecarOpens !== 1) misses += 1;
      if (seen.sidecarReadBytes !== sidecarSize) misses += 1;
      if (seen.lstatCalls < 2) misses += 1;
      await fsp.rm(child.file);
      await fsp.rm(child.file.replace(/\.jsonl$/, ".meta.json"));
    }
  } finally {
    await fsp.rm(path.dirname(dir), { recursive: true, force: true });
  }
  return misses;
}

const enforcesModeBits = process.platform !== "win32" && process.getuid?.() !== 0;

interface OracleResult extends Pick<
  Correctness,
  | "rowMisses"
  | "expectedRowMisses"
  | "statusAgeMisses"
  | "appendMisses"
  | "atomicReplaceMisses"
  | "lateSidecarMisses"
  | "symlinkMisses"
  | "unreadableNewestMisses"
> {
  skippedOracleSteps: number;
}

/**
 * The mutations a cache has to see through, on a supplemental session of 53
 * children listed through both arms after their caches are emptied, so the
 * targets are cached before they change.
 *
 * Each step lists through both arms and charges its own term for any row
 * that differs between them or from the fixture's record — and the record is
 * updated to say what the mutation did, so a step whose mutation silently
 * failed shows up as the old row against the new expectation.
 */
async function mutationOracle(
  root: string,
  current: ListArm,
  reference: ListArm,
  baseNowMs: number
): Promise<OracleResult> {
  const result: OracleResult = {
    rowMisses: 0,
    expectedRowMisses: 0,
    statusAgeMisses: 0,
    appendMisses: 0,
    atomicReplaceMisses: 0,
    lateSidecarMisses: 0,
    symlinkMisses: 0,
    unreadableNewestMisses: 0,
    skippedOracleSteps: 0,
  };
  const top = path.join(root, `oracle-${runCounter}`);
  const dir = path.join(top, "subagents");
  await fsp.mkdir(dir, { recursive: true });
  const locked: string[] = [];
  const excluded = new Set<string>();
  const children: ChildSpec[] = [];

  try {
    const seedBase = 800_000 + runCounter * 1_000;
    for (let index = 0; index < 53; index += 1) {
      const ending =
        index === 1 || index === 2 || index === 6
          ? "open"
          : index % 2 === 0
            ? "ended"
            : "bookkeeping";
      // Index 6 sits two seconds inside the active window, so one poll later
      // it ages out of it with nothing on disk changing.
      const mtimeMs =
        index === 6
          ? baseNowMs - (ACTIVE_WINDOW_MS - 2_000)
          : baseNowMs - (200 + index * 60) * 1000;
      const spec = specChild(
        dir,
        seedBase + index,
        mtimeMs,
        ending,
        index !== 3,
        index % 2 === 0 ? 72 * 1024 : 180 * 1024
      );
      await writeChildFiles(spec, seedBase + index);
      children.push(spec);
    }
    const at = (index: number): ChildSpec => children[index] as ChildSpec;

    const grade = async (
      now: number
    ): Promise<{
      misses: number;
      referenceMisses: number;
      expectedMisses: number;
      rows: AgentSubagent[];
    }> => {
      const referenceRows = await reference.list(dir, now);
      const currentRows = await current.list(dir, now);
      const referenceMisses = rowDifferences(currentRows, referenceRows);
      const expectedMisses = rowDifferences(currentRows, expectedRows(children, now, excluded));
      return {
        misses: referenceMisses + expectedMisses,
        referenceMisses,
        expectedMisses,
        rows: currentRows,
      };
    };

    // Unchanged: a cold list and the warm one after it.
    for (let pass = 0; pass < 2; pass += 1) {
      const unchanged = await grade(baseNowMs);
      result.rowMisses += unchanged.referenceMisses;
      result.expectedRowMisses += unchanged.expectedMisses;
    }

    // The append, replace and symlink steps test a cached entry being seen
    // through, which is vacuous unless the targets are cached to begin with.
    // An unchanged re-list that opens nothing is the proof; without it each of
    // those steps is charged a miss rather than passing on a cold read.
    const warmMark = fsMark();
    await current.list(dir, baseNowMs);
    const warm = fsSince(warmMark);
    const uncached = warm.transcriptOpens === 0 && warm.sidecarOpens === 0 ? 0 : 1;

    // A status that ages out with no write: the cached probe must not carry it.
    const fresh = await grade(baseNowMs);
    const aged = await grade(baseNowMs + POLL_MS);
    const row = (rows: AgentSubagent[]) => rows.find((r) => r.id === at(6).id)?.status.type;
    result.statusAgeMisses +=
      fresh.misses +
      aged.misses +
      (row(fresh.rows) === "working" ? 0 : 1) +
      (row(aged.rows) === "unknown" ? 0 : 1);

    // Appended: a child that finished its turn since the last look.
    const appended = at(1);
    await fsp.appendFile(
      appended.file,
      JSON.stringify({
        type: "assistant",
        isSidechain: true,
        timestamp: new Date(appended.mtimeMs).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          stop_reason: "end_turn",
        },
      }) + "\n"
    );
    await fsp.utimes(appended.file, new Date(appended.mtimeMs), new Date(appended.mtimeMs));
    appended.ending = "ended";
    result.appendMisses += (await grade(baseNowMs)).misses + uncached;

    // Atomic replace keeping size and mtime: only the inode and ctime change.
    const replaced = at(2);
    const before = await fsp.lstat(replaced.file);
    const body = await fsp.readFile(replaced.file, "utf8");
    const marker = '"stop_reason":"tool_use"';
    const cut = body.lastIndexOf(marker);
    const staged = path.join(dir, "staged.tmp");
    await fsp.writeFile(
      staged,
      body.slice(0, cut) + '"stop_reason":"end_turn"' + body.slice(cut + marker.length)
    );
    await fsp.utimes(staged, new Date(replaced.mtimeMs), new Date(replaced.mtimeMs));
    await fsp.rename(staged, replaced.file);
    const after = await fsp.lstat(replaced.file);
    replaced.ending = "ended";
    // A replacement that changed the size or the time, or kept the inode,
    // would not be the case this step claims to test.
    const qualified =
      cut !== -1 &&
      after.size === before.size &&
      Math.round(after.mtimeMs) === Math.round(before.mtimeMs) &&
      after.ino !== before.ino;
    result.atomicReplaceMisses += (await grade(baseNowMs)).misses + (qualified ? 0 : 1) + uncached;

    // A sidecar written after its transcript was already listed.
    const late = at(3);
    late.sidecar = {
      description: "Late arrival",
      agentType: "general-purpose",
      role: "General purpose",
      model: "claude-sonnet-5-5",
      depth: 1,
      mtimeMs: late.mtimeMs - 1_000,
    };
    const lateMeta = late.file.replace(/\.jsonl$/, ".meta.json");
    await fsp.writeFile(
      lateMeta,
      JSON.stringify({
        agentType: "general-purpose",
        description: "Late arrival",
        model: "claude-sonnet-5-5",
        spawnDepth: 1,
      })
    );
    await fsp.utimes(lateMeta, new Date(late.sidecar.mtimeMs), new Date(late.sidecar.mtimeMs));
    result.lateSidecarMisses += (await grade(baseNowMs)).misses;

    // A transcript and a sidecar swapped for symlinks that point out of the store.
    const linkedTranscript = at(4);
    const linkedMeta = at(5);
    const outsideTranscript = path.join(top, "outside.jsonl");
    const outsideMeta = path.join(top, "outside.meta.json");
    await fsp.copyFile(linkedTranscript.file, outsideTranscript);
    await fsp.writeFile(
      outsideMeta,
      JSON.stringify({ description: "Planted", agentType: "Explore" })
    );
    const linkedMetaFile = linkedMeta.file.replace(/\.jsonl$/, ".meta.json");
    // Asked of a scratch path first, so a platform that refuses leaves both
    // originals untouched rather than half swapped under the later steps.
    let linked = true;
    try {
      await fsp.symlink(outsideMeta, path.join(top, "symlink-probe"));
    } catch (error) {
      // Windows refuses an unprivileged symlink. That is reported, never
      // passed as though the case had run.
      if (process.platform !== "win32") throw error;
      linked = false;
      result.skippedOracleSteps += 1;
    }
    if (linked) {
      await fsp.rm(linkedTranscript.file);
      await fsp.symlink(outsideTranscript, linkedTranscript.file);
      await fsp.rm(linkedMetaFile);
      await fsp.symlink(outsideMeta, linkedMetaFile);
      excluded.add(linkedTranscript.id);
      linkedMeta.sidecar = null;
      result.symlinkMisses += (await grade(baseNowMs)).misses + uncached;
    }

    // A newest child that turns out unreadable: it costs its row and the next
    // one down fills the list, as before.
    const injected = specChild(dir, seedBase + 900, baseNowMs - 10_000, "ended", true, 72 * 1024);
    await writeChildFiles(injected, seedBase + 900);
    children.push(injected);
    excluded.add(injected.id);
    injectOpenFault(injected.file);
    let unreadable = await grade(baseNowMs);
    result.unreadableNewestMisses +=
      unreadable.misses + (unreadable.rows.length === LIST_LIMIT ? 0 : 1);

    if (enforcesModeBits) {
      const denied = specChild(dir, seedBase + 901, baseNowMs - 5_000, "ended", true, 72 * 1024);
      await writeChildFiles(denied, seedBase + 901);
      children.push(denied);
      excluded.add(denied.id);
      await fsp.chmod(denied.file, 0o000);
      locked.push(denied.file);
      unreadable = await grade(baseNowMs);
      result.unreadableNewestMisses +=
        unreadable.misses + (unreadable.rows.length === LIST_LIMIT ? 0 : 1);
    } else {
      result.skippedOracleSteps += 1;
    }
  } finally {
    for (const file of locked) await fsp.chmod(file, 0o600).catch(() => undefined);
    await fsp.rm(top, { recursive: true, force: true });
  }
  return result;
}

interface Workload {
  id: string;
  name: string;
  sessions: number;
  children: number;
  tier: ScenarioTier;
  description: string;
}

const WORKLOADS: readonly Workload[] = [
  {
    id: "PERF-414",
    name: "Claude Subagent Poll — 1 Session × 13 Children",
    sessions: 1,
    children: 13,
    tier: "fast",
    description:
      "One polled session at the p90 child count seen on a real machine (13). Inside the envelope both arms list every child; the measured sweeps show what an unchanged poll costs once the caches are warm: the reference re-reads every sidecar, the current reader takes a stat per file.",
  },
  {
    id: "PERF-415",
    name: "Claude Subagent Poll — 1 Session × 50 Children",
    sessions: 1,
    children: 50,
    tier: "fast",
    description:
      "One polled session at exactly the 50-row list limit, where every child is a shown row: the sidecar read per child per poll is the whole difference between the arms once probes are cached.",
  },
  {
    id: "PERF-416",
    name: "Claude Subagent Poll — 1 Session × 347 Children",
    sessions: 1,
    children: 347,
    tier: "heavy",
    description:
      "One polled session of 347 children, the largest seen on a real machine, past the reference's 256-entry probe cache. The reference probes all 347 on every poll — a head and a tail window each — to show 50 rows; the current reader ranks them by stat and opens only the rows it shows.",
  },
  {
    id: "PERF-417",
    name: "Claude Subagent Poll — 20 Sessions × 13 Children",
    sessions: 20,
    children: 13,
    tier: "heavy",
    description:
      "Twenty polled sessions of thirteen children sharing one module cache: 260 shown rows, just past the reference's 256 entries, where FIFO eviction under cyclic polling turns every probe into a miss.",
  },
  {
    id: "PERF-418",
    name: "Claude Subagent Poll — 40 Sessions × 13 Children (Past the Envelope)",
    sessions: 40,
    children: 13,
    tier: "heavy",
    description:
      "Forty polled sessions of thirteen children: 520 shown rows, past what the current reader's caches retain. Shows how it degrades — re-reads per sweep should track the overflow past the retained set, not jump to every child — beside the reference missing on every row.",
  },
];

function scenarioDescription(workload: Workload): string {
  return `${workload.description} Real transcripts (72-900 KiB, most past 128 KiB at each end) and ~230-byte sidecars, driven through listSubagentsInDir in sweeps of one list per session, against the frozen pre-#15681 reader in the same run. Predicates grade the apparatus and the rows, never the speed-up: the fs observer must see both readers' own open binding, every row from either arm must match the other and the fixture's record, and a supplemental session, listed once its targets are cached, must come through an append, an atomic replace that keeps size and mtime, a late sidecar, symlinks, a status that ages out with no write, and unreadable newest children. Windows skips the symlink step and the chmod variant of the unreadable step, and reports how many it skipped.`;
}

function scenarioFor(workload: Workload): PerfScenario {
  const totalChildren = workload.sessions * workload.children;
  return {
    id: workload.id,
    name: workload.name,
    description: scenarioDescription(workload),
    tier: workload.tier,
    modes: ["smoke", "ci", "nightly"],
    // Each run primes its own caches from cold, so a warmup buys nothing.
    warmups: 0,
    iterations: { smoke: 1, ci: 3, nightly: 5 },
    correctness: [...CORRECTNESS],
    workloadFloors: {
      fixtureSessionCount: workload.sessions,
      fixtureTranscriptFiles: totalChildren,
      fixtureLargeTranscriptFiles: Math.floor(totalChildren * 0.4),
      measuredListCalls: workload.sessions * MEASURED_SWEEPS,
    },
    async run(): Promise<ScenarioSample> {
      runCounter += 1;
      const { current, reference, readerStats, referenceStats } = await loadClaudeSubagentArms();
      const store = await storeFor(workload.sessions, workload.children);
      const watches: BystanderProbe[] = [];
      installFsObserver(store.root);
      try {
        const fsObserverMisses = await fsObserverQualification(
          store.root,
          [current, reference],
          store.baseNowMs
        );
        const fixture = await fixtureMisses(store);
        current.reset();
        reference.reset();

        // The cold list: what the first poll after launch pays.
        const coldReference = emptySweep();
        const coldCurrent = emptySweep();
        await sweep(reference, store, store.baseNowMs, coldReference);
        await sweep(current, store, store.baseNowMs, coldCurrent);

        const measured = { current: emptySweep(), reference: emptySweep() };
        const readings: Partial<Record<ListArm["name"], BystanderReading>> = {};
        const order = runCounter % 2 === 0 ? [reference, current] : [current, reference];
        for (const arm of order) {
          globalThis.gc?.();
          const watch = await armBystanderProbe();
          watches.push(watch);
          for (let index = 1; index <= MEASURED_SWEEPS; index += 1) {
            await sweep(arm, store, store.baseNowMs + index * POLL_MS, measured[arm.name]);
          }
          readings[arm.name] = watch.stop();
        }
        const cache = readerStats();
        const referenceCache = referenceStats();

        let rowMisses = 0;
        let expectedRowMisses = 0;
        const sessionsInOrder = store.sessions;
        const grade = (
          currentRows: AgentSubagent[][],
          referenceRows: AgentSubagent[][],
          nows: number[]
        ) => {
          currentRows.forEach((rows, index) => {
            const session = sessionsInOrder[index % sessionsInOrder.length];
            rowMisses += rowDifferences(rows, referenceRows[index] ?? []);
            expectedRowMisses += rowDifferences(
              rows,
              expectedRows(session?.children ?? [], nows[index] ?? 0)
            );
          });
        };
        grade(coldCurrent.rows, coldReference.rows, coldCurrent.nows);
        grade(measured.current.rows, measured.reference.rows, measured.current.nows);

        // Emptied first, so the oracle's targets are admitted: PERF-418 leaves
        // the current cache full of warm entries, which refuses newcomers.
        // Correctness under that pressure is what the measured sweeps graded.
        current.reset();
        reference.reset();
        const oracle = await mutationOracle(store.root, current, reference, store.baseNowMs);

        const currentReading = readings.current;
        const referenceReading = readings.reference;
        if (!currentReading || !referenceReading) {
          throw new Error(`${workload.id}: a bystander arm produced no reading`);
        }

        const correctness: Correctness = {
          fsObserverMisses,
          fixtureMisses: fixture,
          rowMisses: rowMisses + oracle.rowMisses,
          expectedRowMisses: expectedRowMisses + oracle.expectedRowMisses,
          statusAgeMisses: oracle.statusAgeMisses,
          appendMisses: oracle.appendMisses,
          atomicReplaceMisses: oracle.atomicReplaceMisses,
          lateSidecarMisses: oracle.lateSidecarMisses,
          symlinkMisses: oracle.symlinkMisses,
          unreadableNewestMisses: oracle.unreadableNewestMisses,
          bystanderProbeMisses: currentReading.probeMisses + referenceReading.probeMisses,
        };

        const currentMetrics = sweepMetrics("current", measured.current, MEASURED_SWEEPS);
        return {
          durationMs: currentMetrics.currentWallMsPerList as number,
          metrics: {
            ...currentMetrics,
            ...sweepMetrics("reference", measured.reference, MEASURED_SWEEPS),
            currentColdWallMsPerList: coldCurrent.wallMs / Math.max(1, coldCurrent.lists),
            currentColdTranscriptProbesPerList:
              coldCurrent.fs.transcriptOpens / Math.max(1, coldCurrent.lists),
            referenceColdWallMsPerList: coldReference.wallMs / Math.max(1, coldReference.lists),
            referenceColdTranscriptProbesPerList:
              coldReference.fs.transcriptOpens / Math.max(1, coldReference.lists),
            currentProbeCacheEntryCount: cache.probes.entries,
            currentProbeCacheBytes: cache.probes.bytes,
            currentSidecarCacheEntryCount: cache.sidecars.entries,
            currentSidecarCacheBytes: cache.sidecars.bytes,
            referenceProbeCacheEntryCount: referenceCache.entries,
            referenceProbeCacheBytes: referenceCache.approxBytes,
            ...bystanderMetrics("current", currentReading),
            ...bystanderMetrics("reference", referenceReading),
            fixtureSessionCount: store.sessions.length,
            fixtureTranscriptFiles: store.transcriptFiles,
            fixtureLargeTranscriptFiles: store.largeTranscriptFiles,
            fixtureTranscriptBytes: store.transcriptBytes,
            fixtureSidecarFiles: store.sidecarFiles,
            fixtureSidecarBytes: store.sidecarBytes,
            measuredListCalls: measured.current.lists,
            skippedOracleStepCount: oracle.skippedOracleSteps,
            ...correctness,
          },
          notes:
            oracle.skippedOracleSteps > 0
              ? `${oracle.skippedOracleSteps} oracle step(s) could not be arranged on this platform`
              : undefined,
        };
      } finally {
        // A live probe holds a referenced timer; never leave one running.
        watches.forEach((watch) => watch.stop());
        uninstallFsObserver();
      }
    },
  };
}

export const claudeSubagentScenarios: PerfScenario[] = WORKLOADS.map(scenarioFor);
