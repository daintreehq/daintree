import { describe, expect, it } from "vitest";
import {
  getPluginManifestSchema,
  MANIFEST_CONTRIBUTION_CAPS,
  parsePluginManifestForLoad,
  TOUR_CONTRIBUTION_LIMITS,
} from "../plugin.js";

const schema = getPluginManifestSchema("user");

function chapter(overrides: Record<string, unknown> = {}) {
  return { id: "intro", duration: 10, audioUrl: null, narrationHash: "0a1b2c3d", ...overrides };
}

function tour(overrides: Record<string, unknown> = {}) {
  return {
    id: "welcome",
    title: "Welcome Tour",
    componentPath: "dist/tours/welcome.js",
    chapters: [chapter()],
    ...overrides,
  };
}

function parse(tours: unknown, contributes: Record<string, unknown> = {}) {
  return schema.safeParse({
    name: "acme.tours-plugin",
    version: "1.0.0",
    contributes: { tours, ...contributes },
  });
}

function errorCodes(result: ReturnType<typeof schema.safeParse>): string[] {
  if (result.success) return [];
  return result.error.issues
    .map((i) => (i as { params?: { errorCode?: string } }).params?.errorCode)
    .filter((c): c is string => typeof c === "string");
}

function issuePaths(result: ReturnType<typeof schema.safeParse>): string[] {
  return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
}

/** Fails, and every issue sits at `path` (or beneath it) — so it failed for the stated reason. */
function expectOnlyAt(result: ReturnType<typeof schema.safeParse>, path: string) {
  expect(result.success).toBe(false);
  const paths = issuePaths(result);
  expect(paths.length).toBeGreaterThan(0);
  for (const p of paths) expect(p === path || p.startsWith(`${path}.`), p).toBe(true);
}

const panel = { id: "site-builder", name: "Site Builder", iconId: "globe", color: "#336699" };

describe("contributes.tours schema (#12768)", () => {
  it("accepts a plugin tour and defaults its optional collections", () => {
    const result = parse([tour()]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [parsed] = result.data.contributes.tours;
    expect(parsed.audioHosts).toEqual([]);
    expect(parsed.chapters[0].cues).toEqual({});
    expect(parsed.chapters[0].captions).toEqual([]);
  });

  it("defaults contributes.tours to an empty array", () => {
    const result = schema.safeParse({ name: "acme.tours-plugin", version: "1.0.0" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.contributes.tours).toEqual([]);
  });

  it("accepts a panel tour naming one of the plugin's own panels", () => {
    const result = parse([tour({ panelKind: "site-builder" })], { panels: [panel] });
    expect(result.success).toBe(true);
  });

  it("rejects a panel tour naming a panel the plugin does not declare", () => {
    const result = parse([tour({ panelKind: "terminal" })], { panels: [panel] });
    expect(result.success).toBe(false);
    expect(errorCodes(result)).toContain("tour_panel_kind_unknown");
    expect(issuePaths(result)).toContain("contributes.tours.0.panelKind");
  });

  it("accepts full timing data with bundled and declared remote audio", () => {
    const result = parse([
      tour({
        audioHosts: ["cdn.example.com"],
        chapters: [
          chapter({
            cues: { "open-preview": 2.5, end: 10 },
            captions: [
              { start: 0, end: 4, text: "Welcome." },
              { start: 4, end: 10, text: "Let's begin." },
            ],
            audioUrl: "https://cdn.example.com/tours/intro.mp3?v=2",
          }),
          chapter({ id: "next", audioUrl: "./tours/next.mp3" }),
        ],
      }),
    ]);
    expect(result.success).toBe(true);
  });

  it("matches declared audio hosts case-insensitively", () => {
    const result = parse([
      tour({
        audioHosts: ["CDN.Example.com"],
        chapters: [chapter({ audioUrl: "https://cdn.example.com/a.mp3" })],
      }),
    ]);
    expect(result.success).toBe(true);
  });

  it("rejects remote audio from an undeclared host, including a subdomain of a declared one", () => {
    for (const audioUrl of [
      "https://other.example.com/a.mp3",
      "https://evil.cdn.example.com/a.mp3",
    ]) {
      const result = parse([
        tour({ audioHosts: ["cdn.example.com"], chapters: [chapter({ audioUrl })] }),
      ]);
      expect(result.success).toBe(false);
      expect(errorCodes(result)).toContain("tour_audio_host_undeclared");
      expect(issuePaths(result)).toContain("contributes.tours.0.chapters.0.audioUrl");
    }
  });

  it("rejects non-https, credentialed and private remote audio", () => {
    const cases: [string, string][] = [
      ["http://cdn.example.com/a.mp3", "scope_url_not_https"],
      ["https://user:pw@cdn.example.com/a.mp3", "scope_url_has_credentials"],
      ["https://127.0.0.1/a.mp3", "scope_url_private_target"],
      ["file:///etc/passwd", "scope_url_not_https"],
    ];
    for (const [audioUrl, code] of cases) {
      const result = parse([
        tour({ audioHosts: ["cdn.example.com"], chapters: [chapter({ audioUrl })] }),
      ]);
      expect(result.success).toBe(false);
      expect(errorCodes(result)).toContain(code);
    }
  });

  it("rejects an unsafe bundled audio path", () => {
    for (const audioUrl of ["../escape.mp3", "/abs/a.mp3", "a\\b.mp3"]) {
      const result = parse([tour({ chapters: [chapter({ audioUrl })] })]);
      expect(result.success).toBe(false);
      expect(errorCodes(result)).toContain("tour_audio_path_unsafe");
    }
  });

  it("rejects malformed audio host declarations", () => {
    for (const host of [
      "https://cdn.example.com",
      "cdn.example.com:8443",
      "cdn.example.com/path",
      "*.example.com",
      "localhost",
      "8.8.8.8",
      "[::1]",
      "cdn.example.com.",
      "user@cdn.example.com",
      "exämple.com",
    ]) {
      const result = parse([tour({ audioHosts: [host] })]);
      expect(result.success, host).toBe(false);
      expect(errorCodes(result), host).toContain("tour_audio_host_invalid");
    }
  });

  it("rejects a duplicate audio host", () => {
    expect(
      errorCodes(parse([tour({ audioHosts: ["cdn.example.com", "CDN.example.com"] })]))
    ).toContain("tour_audio_host_duplicate");
  });

  it("rejects an unsafe componentPath", () => {
    for (const componentPath of ["../x.js", "/x.js", "https://cdn.example.com/x.js"]) {
      expectOnlyAt(parse([tour({ componentPath })]), "contributes.tours.0.componentPath");
    }
  });

  it("rejects a malformed narration fingerprint", () => {
    for (const narrationHash of ["0A1B2C3D", "abc", "0a1b2c3d4", ""]) {
      expectOnlyAt(
        parse([tour({ chapters: [chapter({ narrationHash })] })]),
        "contributes.tours.0.chapters.0.narrationHash"
      );
    }
  });

  it("requires audioUrl to be present, even when null", () => {
    const { audioUrl: _omit, ...withoutAudio } = chapter();
    expectOnlyAt(
      parse([tour({ chapters: [withoutAudio] })]),
      "contributes.tours.0.chapters.0.audioUrl"
    );
  });

  it("classifies audioUrl edge cases", () => {
    const at = "contributes.tours.0.chapters.0.audioUrl";
    const withAudio = (audioUrl: string) =>
      parse([tour({ audioHosts: ["cdn.example.com"], chapters: [chapter({ audioUrl })] })]);
    for (const audioUrl of [
      "",
      "//cdn.example.com/a.mp3",
      " //other.example.com/a.mp3",
      "\t//other.example.com/a.mp3",
      "tours/a.mp3 ",
      "https://cdn.example.com/a.mp3 ",
      "https://127.1/a.mp3",
    ]) {
      expectOnlyAt(withAudio(audioUrl), at);
    }
    expect(withAudio("HTTPS://cdn.example.com/a.mp3").success).toBe(true);
    // An unused declaration is allowed: a tour may list its host before its audio moves there.
    expect(parse([tour({ audioHosts: ["cdn.example.com"] })]).success).toBe(true);
  });

  it("rejects a __proto__ cue instead of silently dropping it", () => {
    const cues = JSON.parse('{"__proto__": 1}') as Record<string, number>;
    const result = parse([tour({ chapters: [chapter({ cues })] })]);
    expect(errorCodes(result)).toContain("tour_cue_name_reserved");
    expectOnlyAt(result, "contributes.tours.0.chapters.0.cues");
  });

  it("rejects cues and captions outside the chapter duration", () => {
    const cue = parse([tour({ chapters: [chapter({ cues: { late: 11 } })] })]);
    expect(errorCodes(cue)).toContain("tour_cue_out_of_range");
    expectOnlyAt(cue, "contributes.tours.0.chapters.0.cues.late");

    for (const caption of [
      { start: 5, end: 5, text: "empty" },
      { start: 6, end: 4, text: "backwards" },
      { start: 8, end: 12, text: "overrun" },
    ]) {
      const result = parse([tour({ chapters: [chapter({ captions: [caption] })] })]);
      expect(errorCodes(result)).toContain("tour_caption_out_of_range");
      expectOnlyAt(result, "contributes.tours.0.chapters.0.captions.0");
    }
  });

  it("rejects non-positive and over-long chapter durations", () => {
    for (const duration of [0, -1, TOUR_CONTRIBUTION_LIMITS.chapterDurationSeconds + 1]) {
      expectOnlyAt(
        parse([tour({ chapters: [chapter({ duration })] })]),
        "contributes.tours.0.chapters.0.duration"
      );
    }
  });

  it("rejects unknown keys at every level", () => {
    expectOnlyAt(parse([tour({ autoplay: true })]), "contributes.tours.0");
    expectOnlyAt(
      parse([tour({ chapters: [chapter({ voice: "x" })] })]),
      "contributes.tours.0.chapters.0"
    );
    expectOnlyAt(
      parse([tour({ chapters: [chapter({ captions: [{ start: 0, end: 1, text: "a", x: 1 }] })] })]),
      "contributes.tours.0.chapters.0.captions.0"
    );
  });

  it("rejects duplicate tour ids and duplicate chapter ids within a tour", () => {
    const dupTour = parse([tour(), tour({ title: "Again" })]);
    expect(errorCodes(dupTour)).toContain("duplicate_contribution_id");
    expectOnlyAt(dupTour, "contributes.tours.1.id");

    const dupChapter = parse([tour({ chapters: [chapter(), chapter()] })]);
    expect(errorCodes(dupChapter)).toContain("tour_chapter_duplicate_id");
    expectOnlyAt(dupChapter, "contributes.tours.0.chapters.1.id");

    // Chapter ids are scoped per tour.
    expect(parse([tour(), tour({ id: "other" })]).success).toBe(true);
  });

  it("enforces the tour, chapter, caption, cue and host caps", () => {
    const tours = (n: number) => Array.from({ length: n }, (_v, i) => tour({ id: `t${i}` }));
    expect(parse(tours(MANIFEST_CONTRIBUTION_CAPS.tours)).success).toBe(true);
    expectOnlyAt(parse(tours(MANIFEST_CONTRIBUTION_CAPS.tours + 1)), "contributes.tours");

    const chapters = (n: number) => Array.from({ length: n }, (_v, i) => chapter({ id: `c${i}` }));
    expectOnlyAt(parse([tour({ chapters: [] })]), "contributes.tours.0.chapters");
    expect(parse([tour({ chapters: chapters(TOUR_CONTRIBUTION_LIMITS.chapters) })]).success).toBe(
      true
    );
    expectOnlyAt(
      parse([tour({ chapters: chapters(TOUR_CONTRIBUTION_LIMITS.chapters + 1) })]),
      "contributes.tours.0.chapters"
    );

    const captions = Array.from(
      { length: TOUR_CONTRIBUTION_LIMITS.captionsPerChapter + 1 },
      () => ({ start: 0, end: 1, text: "a" })
    );
    expectOnlyAt(
      parse([tour({ chapters: [chapter({ captions })] })]),
      "contributes.tours.0.chapters.0.captions"
    );

    const cues = Object.fromEntries(
      Array.from({ length: TOUR_CONTRIBUTION_LIMITS.cuesPerChapter + 1 }, (_v, i) => [`c${i}`, 1])
    );
    expect(errorCodes(parse([tour({ chapters: [chapter({ cues })] })]))).toContain(
      "tour_cues_too_many"
    );

    const hosts = Array.from(
      { length: TOUR_CONTRIBUTION_LIMITS.audioHosts + 1 },
      (_v, i) => `cdn${i}.example.com`
    );
    expectOnlyAt(parse([tour({ audioHosts: hosts })]), "contributes.tours.0.audioHosts");
  });

  it("accepts tours from a built-in plugin", () => {
    const result = getPluginManifestSchema("builtin").safeParse({
      name: "daintree.tours-plugin",
      version: "1.0.0",
      contributes: { tours: [tour()] },
    });
    expect(result.success).toBe(true);
  });

  it("reports a malformed tour through safeParse rather than throwing", () => {
    for (const bad of [null, "tour", [null], [{}], { id: "x" }]) {
      expect(() => parse(bad)).not.toThrow();
      expect(parse(bad).success).toBe(false);
    }
  });
});

describe("parsePluginManifestForLoad tour isolation (#12768)", () => {
  const manifest = (tours: unknown[], contributes: Record<string, unknown> = {}) => ({
    name: "acme.tours-plugin",
    version: "1.0.0",
    contributes: { panels: [panel], tours, ...contributes },
  });

  it("drops only the malformed tours and keeps the rest of the plugin", () => {
    const { result, droppedTourIssues } = parsePluginManifestForLoad(
      "user",
      manifest([
        tour({ id: "good" }),
        tour({ id: "bad-panel", panelKind: "someone-elses-panel" }),
        tour({ id: "bad-audio", chapters: [chapter({ audioUrl: "https://x.example.com/a.mp3" })] }),
        tour({ id: "good" }),
      ])
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.contributes.tours.map((t) => t.id)).toEqual(["good"]);
    expect(result.data.contributes.panels).toHaveLength(1);
    // Paths name the author's original indices, even across drop rounds.
    expect([...new Set(droppedTourIssues.map((i) => i.path.slice(0, 3).join(".")))].sort()).toEqual(
      ["contributes.tours.1", "contributes.tours.2", "contributes.tours.3"]
    );
  });

  it("returns a clean manifest untouched", () => {
    const { result, droppedTourIssues } = parsePluginManifestForLoad("user", manifest([tour()]));
    expect(result.success).toBe(true);
    expect(droppedTourIssues).toEqual([]);
  });

  it("still refuses the manifest when any issue lies outside a single tour entry", () => {
    const otherIssue = parsePluginManifestForLoad(
      "user",
      manifest([tour({ panelKind: "nope" })], { skills: [{ id: "s" }] })
    );
    expect(otherIssue.result.success).toBe(false);
    expect(otherIssue.droppedTourIssues).toEqual([]);

    const overCap = parsePluginManifestForLoad(
      "user",
      manifest(Array.from({ length: MANIFEST_CONTRIBUTION_CAPS.tours + 1 }, () => ({})))
    );
    expect(overCap.result.success).toBe(false);

    const projectScope = parsePluginManifestForLoad("project", {
      ...manifest([tour()]),
      scope: "project",
    });
    expect(projectScope.result.success).toBe(false);
    if (!projectScope.result.success) {
      expect(errorCodes(projectScope.result)).toContain("tours_project_scope_forbidden");
    }
  });
});
