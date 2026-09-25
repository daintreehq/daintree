// The preview page. Built into dist/tour-preview/ with every host specifier left
// bare, so it shares the page's one React and one TourPlayerContext with the
// plugin's scenes through the import map.
import {
  Component,
  Suspense,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { TourPlayer, type TourChapterTiming } from "@daintreehq/tour";
import { TourPlayerContext, useTourPlayerState } from "@daintreehq/tour/react";
import { TOUR_CANVAS, TourCanvas, measureAnchor } from "@daintreehq/tour/kit";
import {
  CONFIG_ELEMENT_ID,
  PREVIEW_HANDLE,
  REPORT_PATH,
  cuesInOrder,
  pinTiming,
  recordCueReads,
  sceneMapProblem,
  undefinedCues,
  type CanvasRect,
  type PreviewChapterReport,
  type PreviewSnapshot,
  type TourPreviewConfig,
  type TourPreviewHandle,
} from "../protocol.js";
import { formatErrorMessage } from "../../../../../../shared/utils/errorMessage.js";

const config = JSON.parse(
  document.getElementById(CONFIG_ELEMENT_ID)!.textContent!
) as TourPreviewConfig;
const params = new URLSearchParams(window.location.search);
const capture = params.get("capture") === "1";

const handle: TourPreviewHandle = {
  ready: false,
  error: null,
  chapters: config.chapters.map((c) => c.id),
  goTo: () => Promise.reject(new Error("The preview is not ready")),
  seek: () => Promise.reject(new Error("The preview is not ready")),
  snapshot: () => {
    throw new Error("The preview is not ready");
  },
};
Reflect.set(window, PREVIEW_HANDLE, handle);

/** Cues each chapter's scene has read, and scene errors, as a subscribable store. */
class Observations {
  private readonly referenced = new Map<string, Set<string>>();
  private readonly errors = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly sent = new Map<string, string>();
  private version = 0;
  private scheduled = false;

  readCue = (chapterId: string, cue: string): void => {
    const set = this.referenced.get(chapterId) ?? new Set<string>();
    if (set.has(cue)) return;
    set.add(cue);
    this.referenced.set(chapterId, set);
    this.changed();
  };

  sceneFailed(chapterId: string, message: string): void {
    this.errors.set(chapterId, message);
    this.changed();
  }

  report(chapterId: string): PreviewChapterReport {
    const chapter = config.chapters.find((c) => c.id === chapterId)!;
    const error = this.errors.get(chapterId);
    return {
      chapterId,
      undefinedCues: undefinedCues(this.referenced.get(chapterId) ?? [], chapter.narrationCues),
      ...(error ? { error } : {}),
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  // Reads happen during a scene's render, so listeners run after it.
  private changed(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.version++;
      for (const listener of this.listeners) listener();
      this.post();
    });
  }

  /** Tell the terminal about any chapter whose findings changed. */
  private post(): void {
    for (const chapter of config.chapters) {
      const report = this.report(chapter.id);
      if (report.undefinedCues.length === 0 && !report.error) continue;
      const key = JSON.stringify(report);
      if (this.sent.get(chapter.id) === key) continue;
      this.sent.set(chapter.id, key);
      void fetch(REPORT_PATH, { method: "POST", body: key }).catch(() => {});
    }
  }
}

const observations = new Observations();

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Two frames: React has committed, and the browser has laid the result out. */
async function rendered(): Promise<void> {
  await nextFrame();
  await nextFrame();
}

/** The chapter whose scene last committed; a suspended (lazy) scene hasn't yet. */
let mountedChapter: string | null = null;
const SCENE_MOUNT_TIMEOUT_MS = 10_000;

/** Placed after the scene inside its Suspense boundary, so it commits with it. */
function SceneMounted({ chapterId }: { chapterId: string }) {
  useLayoutEffect(() => {
    mountedChapter = chapterId;
    return () => {
      if (mountedChapter === chapterId) mountedChapter = null;
    };
  }, [chapterId]);
  return null;
}

/** Resolve once `chapterId`'s scene has committed and been laid out. */
async function sceneRendered(chapterId: string): Promise<void> {
  const deadline = performance.now() + SCENE_MOUNT_TIMEOUT_MS;
  while (mountedChapter !== chapterId) {
    if (observations.report(chapterId).error) break;
    if (performance.now() > deadline) {
      throw new Error(
        `Chapter "${chapterId}"'s scene didn't render within ${SCENE_MOUNT_TIMEOUT_MS / 1000}s`
      );
    }
    await nextFrame();
  }
  await rendered();
}

function canvasElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-tour-canvas]");
}

/** Every rendered anchor in canvas space, the rectangles a cursor step aims at. */
function measureAnchors(): Record<string, CanvasRect> {
  const canvas = canvasElement();
  if (!canvas) return {};
  const anchors: Record<string, CanvasRect> = {};
  for (const el of canvas.querySelectorAll<HTMLElement | SVGElement>("[data-tour-anchor]")) {
    const name = el.dataset.tourAnchor;
    if (!name || name in anchors) continue;
    const rect = measureAnchor(canvas, name);
    if (rect) anchors[name] = rect;
  }
  return anchors;
}

/** Built-in preview convention: canvas-space centres of every anchor. */
Reflect.set(window, "__tourAnchors", () =>
  Object.fromEntries(
    Object.entries(measureAnchors()).map(([name, r]) => [
      name,
      { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
    ])
  )
);

class SceneBoundary extends Component<
  { chapterId: string; children: ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: formatErrorMessage(error, "The scene threw") };
  }

  componentDidCatch(error: unknown) {
    observations.sceneFailed(this.props.chapterId, formatErrorMessage(error, "The scene threw"));
  }

  render() {
    if (this.state.error) {
      return <div className="tp-scene-error">Scene error: {this.state.error}</div>;
    }
    return this.props.children;
  }
}

function formatTime(seconds: number): string {
  return `${seconds.toFixed(2)}s`;
}

function AnchorOutlines({ player }: { player: TourPlayer }) {
  const [anchors, setAnchors] = useState<Record<string, CanvasRect>>({});
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setAnchors(measureAnchors()));
    };
    update();
    // Anchors move with the scene: on every tick, and once transitions settle.
    const offTime = player.subscribeTime(update);
    const offState = player.subscribe(update);
    const timer = window.setInterval(update, 250);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(timer);
      offTime();
      offState();
    };
  }, [player]);
  return (
    <div className="tp-anchors" aria-hidden="true">
      {Object.entries(anchors).map(([name, r]) => (
        <div
          key={name}
          className="tp-anchor"
          style={{ left: r.x, top: r.y, width: r.width, height: r.height }}
        >
          <span>{name}</span>
        </div>
      ))}
    </div>
  );
}

function Timeline({ player, timing }: { player: TourPlayer; timing: TourChapterTiming }) {
  const time = useSyncExternalStore(player.subscribeTime, player.getTime);
  const duration = timing.duration;
  return (
    <div className="tp-timeline">
      <input
        type="range"
        aria-label="Scrub"
        min={0}
        max={duration}
        step={0.01}
        value={time}
        onChange={(e) => player.seek(Number(e.currentTarget.value))}
      />
      <div className="tp-cues">
        {cuesInOrder(timing.cues).map(({ cue, time: at }) => (
          <button
            key={cue}
            type="button"
            className={time >= at ? "tp-cue tp-cue-passed" : "tp-cue"}
            style={{ left: `${(at / duration) * 100}%` }}
            title={`${cue} @ ${formatTime(at)}`}
            onClick={() => player.seek(at)}
          >
            <span>{cue}</span>
          </button>
        ))}
      </div>
      <div className="tp-caption">
        {timing.captions.find((c) => time >= c.start && time < c.end)?.text ?? ""}
      </div>
      <div className="tp-time">
        {formatTime(time)} / {formatTime(duration)}
      </div>
    </div>
  );
}

function Warnings({ chapterId }: { chapterId: string }) {
  useSyncExternalStore(observations.subscribe, observations.getVersion);
  const report = observations.report(chapterId);
  const lines = [
    ...config.warnings,
    ...report.undefinedCues.map(
      (cue) =>
        `Chapter "${chapterId}": a scene waits on cue "${cue}", which the narration doesn't mark, so it never fires`
    ),
    ...(report.error ? [`Chapter "${chapterId}": the scene threw: ${report.error}`] : []),
  ];
  if (lines.length === 0) return null;
  return (
    <ul className="tp-warnings">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function Preview({
  player,
  views,
  scenes,
}: {
  player: TourPlayer;
  /** Per chapter, the player with that chapter's timing pinned. */
  views: TourPlayer[];
  scenes: Record<string, ComponentType>;
}) {
  const state = useTourPlayerState(player);
  const [outlines, setOutlines] = useState(!capture);
  const chapter = config.chapters[state.chapterIndex]!;
  const Scene = scenes[chapter.id]!;

  const stage = (
    <TourPlayerContext.Provider value={views[state.chapterIndex]!}>
      <TourCanvas
        canvasKey={chapter.id}
        className="tp-stage"
        wrapStage={(canvas) => (
          <SceneBoundary key={chapter.id} chapterId={chapter.id}>
            {canvas}
          </SceneBoundary>
        )}
      >
        <Suspense fallback={null}>
          <Scene />
          <SceneMounted chapterId={chapter.id} />
        </Suspense>
        {outlines && <AnchorOutlines key={chapter.id} player={player} />}
      </TourCanvas>
    </TourPlayerContext.Provider>
  );

  if (capture) return <div className="tp-capture">{stage}</div>;

  return (
    <div className="tp-root">
      <header className="tp-header">
        <strong>{config.title}</strong>
        <select
          aria-label="Chapter"
          value={chapter.id}
          onChange={(e) =>
            player.goTo(config.chapters.findIndex((c) => c.id === e.currentTarget.value))
          }
        >
          {config.chapters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id}
              {c.timingSource === "manifest" ? "" : ` (${c.timingSource} timing)`}
            </option>
          ))}
        </select>
      </header>
      {stage}
      <div className="tp-controls">
        <button type="button" onClick={() => player.toggle()}>
          {state.status === "playing" ? "Pause" : "Play"}
        </button>
        <button type="button" onClick={() => player.setMuted(!state.muted)}>
          {state.muted ? "Unmute" : "Mute"}
        </button>
        <label>
          <input
            type="checkbox"
            checked={outlines}
            onChange={(e) => setOutlines(e.currentTarget.checked)}
          />
          Anchors
        </label>
        <span className="tp-audio">
          {chapter.timing.audioUrl === null
            ? "no audio"
            : state.silent
              ? `audio ${state.audioStatus}`
              : "voiced"}
        </span>
      </div>
      <Timeline player={player} timing={chapter.timing} />
      <Warnings chapterId={chapter.id} />
    </div>
  );
}

function Failure({ message }: { message: string }) {
  return <pre className="tp-failure">{message}</pre>;
}

async function main(): Promise<void> {
  const root = createRoot(document.getElementById("root")!);
  let module: unknown;
  try {
    module = await import(/* @vite-ignore */ config.componentUrl);
  } catch (error) {
    const message = `Couldn't load the tour module ${config.componentUrl}: ${(error as Error).message}`;
    handle.error = message;
    root.render(<Failure message={message} />);
    return;
  }
  const problem = sceneMapProblem(module, handle.chapters);
  if (problem) {
    handle.error = problem;
    root.render(<Failure message={problem} />);
    return;
  }
  const scenes = (module as { default: Record<string, ComponentType> }).default;

  const timings = config.chapters.map((chapter) => ({
    ...chapter.timing,
    cues: recordCueReads(chapter.timing.cues, (cue) => observations.readCue(chapter.id, cue)),
  }));
  const player = new TourPlayer(
    timings,
    {
      createAudio: (url) => new Audio(url),
      now: () => performance.now(),
      requestFrame: (cb) => requestAnimationFrame(cb),
      cancelFrame: (id) => cancelAnimationFrame(id),
    },
    { muted: capture || params.get("muted") === "1" }
  );
  Reflect.set(window, "__tour", player);
  const views = timings.map((timing) => pinTiming(player, timing));

  const start = Math.max(
    0,
    config.chapters.findIndex((c) => c.id === params.get("chapter"))
  );
  if (start > 0) player.goTo(start, { autoplay: false });
  const freezeAt = params.get("t");
  if (freezeAt !== null) player.seek(Number(freezeAt));

  Object.assign(handle, {
    async goTo(chapterId: string) {
      const index = config.chapters.findIndex((c) => c.id === chapterId);
      if (index < 0) throw new Error(`No chapter "${chapterId}"`);
      player.goTo(index, { autoplay: false });
      await sceneRendered(chapterId);
    },
    async seek(seconds: number) {
      player.pause();
      player.seek(seconds);
      await rendered();
    },
    snapshot(): PreviewSnapshot {
      const chapterId = config.chapters[player.getState().chapterIndex]!.id;
      return {
        chapterId,
        time: player.getTime(),
        canvas: { width: TOUR_CANVAS.width, height: TOUR_CANVAS.height },
        anchors: measureAnchors(),
        report: observations.report(chapterId),
      };
    },
  } satisfies Partial<TourPreviewHandle>);

  root.render(<Preview player={player} views={views} scenes={scenes} />);
  await sceneRendered(config.chapters[player.getState().chapterIndex]!.id);
  handle.ready = true;
}

void main().catch((error: unknown) => {
  handle.error = formatErrorMessage(error, "The preview failed to start");
});
