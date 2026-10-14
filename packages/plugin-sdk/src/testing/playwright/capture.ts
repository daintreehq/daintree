/** `story` under `theme`: one cell of the matrix a spec declares. */
export function pairKey(story: string, theme: string): string {
  return `${story} × ${theme}`;
}

/**
 * Which declared (story, theme) pairs have a verified capture. A pair counts
 * only once `snap` has accepted a frame of it, so opening a story that never
 * rendered, or one whose capture failed, leaves it missing.
 */
export class PreviewCoverage {
  private readonly captured = new Set<string>();

  constructor(
    readonly stories: readonly string[],
    readonly themes: readonly string[]
  ) {}

  record(story: string, theme: string): void {
    this.captured.add(pairKey(story, theme));
  }

  missing(): string[] {
    return this.stories.flatMap((story) =>
      this.themes.map((theme) => pairKey(story, theme)).filter((key) => !this.captured.has(key))
    );
  }
}

/**
 * Console errors, uncaught page errors and failed requests, in the order the
 * page raised them. They are kept for the whole test: opening the next story
 * does not forgive the last one.
 */
export class BrowserProblems {
  private readonly problems: string[] = [];
  private reported = 0;

  add(problem: string): void {
    this.problems.push(problem);
  }

  /** Throw if anything went wrong since the last call, naming what. */
  throwIfAny(when: string): void {
    const fresh = this.problems.slice(this.reported);
    this.reported = this.problems.length;
    if (fresh.length > 0) {
      throw new Error(`The panel preview reported ${when}:\n  ${fresh.join("\n  ")}`);
    }
  }
}

export interface StableCaptureOptions {
  take: () => Promise<Buffer>;
  /** Runs between two captures that differ: a frame or two of settling. */
  between: () => Promise<void>;
  maxAttempts?: number;
}

/**
 * Capture until two consecutive frames are byte-identical, and return that
 * frame. A panel still animating, scrolling or laying out never settles, and
 * that throws rather than handing back whichever frame came last.
 */
export async function captureStableFrame(opts: StableCaptureOptions): Promise<Buffer> {
  const maxAttempts = opts.maxAttempts ?? 10;
  let previous = await opts.take();
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    const next = await opts.take();
    if (next.equals(previous)) return next;
    previous = next;
    await opts.between();
  }
  throw new Error(
    `The panel never held still: ${maxAttempts} captures in a row differed. Disable the animation, or wait in the story's play for the state to settle.`
  );
}

/** A capture name as a file name: `Populated / bondi` → `Populated-bondi`. */
export function captureFileName(name: string): string {
  const slug = name
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`"${name}" is not a usable capture name`);
  return `${slug}.png`;
}
