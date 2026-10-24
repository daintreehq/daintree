// Tour contributions.

import { z } from "zod";
import { SAFE_ID_PATTERN, isPrivateOrLoopbackHostname } from "../pluginIdentifiers.js";
import { SetupStepCommandActionSchema, SetupStepSettingsActionSchema } from "./settings.js";
import { isSafePluginAssetPath, refinePluginHttpsUrl } from "./common.js";

/**
 * Upper bounds inside one `contributes.tours` entry. Like
 * {@link MANIFEST_CONTRIBUTION_CAPS} these reject pathological manifests rather
 * than shape authoring; a panel tour is expected to use a couple of chapters.
 * Exported so tests reference the values without magic numbers.
 */
export const TOUR_CONTRIBUTION_LIMITS = {
  chapters: 32,
  captionsPerChapter: 128,
  cuesPerChapter: 128,
  audioHosts: 8,
  chapterDurationSeconds: 600,
} as const;

/** Same shape the built-in tour's `narrationFingerprint` produces. */
const TOUR_NARRATION_HASH_PATTERN = /^[0-9a-f]{8}$/;

/** A string that opens with a URL scheme is remote audio; anything else is a bundled asset. */
const URL_SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A declared narration host is a bare, exact DNS hostname — the list is a
 * disclosure the user reads, so it must say precisely where audio comes from.
 * Round-tripping through `URL` rejects ports, paths, credentials and non-ASCII
 * spellings (their `host` differs from the input); IP literals and empty
 * labels (a leading, doubled or trailing dot) are rejected so matching stays a
 * plain case-insensitive string compare.
 * Every private/loopback literal is single-label or an IP, so those rules also
 * cover the SSRF check; `isPrivateOrLoopbackHostname` stays as a backstop.
 */
const TourAudioHostSchema = z
  .string()
  .min(1)
  .max(253)
  .superRefine((value, ctx) => {
    let host: string | null;
    try {
      host = new URL(`https://${value}/`).hostname;
    } catch {
      host = null;
    }
    const lower = value.toLowerCase();
    if (
      host !== lower ||
      value.includes("*") ||
      !value.includes(".") ||
      value.split(".").some((label) => label === "") ||
      value.startsWith("[") ||
      /^[\d.]+$/.test(value) ||
      isPrivateOrLoopbackHostname(lower)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `audioHosts entries must be bare public multi-label hostnames such as "cdn.example.com" (no scheme, port, path, wildcard or IP literal): "${value}"`,
        params: { errorCode: "tour_audio_host_invalid" },
      });
    }
  });

/**
 * A chapter's narration audio: a plugin-relative asset path, or an https URL
 * whose hostname the tour lists in `audioHosts` (checked on the tour, which
 * holds the list).
 */
const TourAudioUrlSchema = z
  .string()
  .min(1)
  .max(4096)
  .superRefine((value, ctx) => {
    // URL parsing strips leading/trailing C0 controls and spaces (<= U+0020),
    // so " //host/a.mp3" would resolve remotely past the host declaration and a
    // padded https URL would not be the string the declaration was checked on.
    if (value.charCodeAt(0) <= 0x20 || value.charCodeAt(value.length - 1) <= 0x20) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "audioUrl must not start or end with whitespace or control characters",
        params: { errorCode: "tour_audio_url_padded" },
      });
      return;
    }
    if (URL_SCHEME_PREFIX.test(value)) {
      refinePluginHttpsUrl(value, ctx, "tours[].chapters[].audioUrl");
      return;
    }
    if (!isSafePluginAssetPath(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "audioUrl must be an https URL or a relative plugin asset path (no leading /, backslash, NUL, or .. segments)",
        params: { errorCode: "tour_audio_path_unsafe" },
      });
    }
  });

/** One caption line, in seconds from the start of its chapter. */
export const TourCaptionSchema = z
  .object({
    start: z.number().min(0),
    end: z.number().positive(),
    text: z.string().min(1).max(500),
  })
  .strict();

/**
 * Timing for one tour chapter, mirroring the built-in tour's
 * `TourChapterTiming` plus its `narrationHash`. Cues are named scene triggers in
 * seconds; every cue and caption must fall inside the chapter's duration.
 */
export const TourChapterSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    duration: z.number().positive().max(TOUR_CONTRIBUTION_LIMITS.chapterDurationSeconds),
    cues: z.record(z.string().min(1).max(64).regex(SAFE_ID_PATTERN), z.number().min(0)).default({}),
    captions: z
      .array(TourCaptionSchema)
      .max(TOUR_CONTRIBUTION_LIMITS.captionsPerChapter)
      .default([]),
    audioUrl: TourAudioUrlSchema.nullable(),
    narrationHash: z.string().regex(TOUR_NARRATION_HASH_PATTERN, {
      message: "narrationHash must be the 8-character lowercase hex narration fingerprint",
    }),
  })
  .strict()
  .superRefine((chapter, ctx) => {
    const cues = Object.entries(chapter.cues);
    if (cues.length > TOUR_CONTRIBUTION_LIMITS.cuesPerChapter) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cues"],
        message: `A chapter may declare at most ${TOUR_CONTRIBUTION_LIMITS.cuesPerChapter} cues.`,
        params: { errorCode: "tour_cues_too_many" },
      });
    }
    for (const [name, at] of cues) {
      if (at > chapter.duration) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cues", name],
          message: `Cue "${name}" at ${at}s falls after the chapter's ${chapter.duration}s duration.`,
          params: { errorCode: "tour_cue_out_of_range" },
        });
      }
    }
    chapter.captions.forEach((caption, index) => {
      if (caption.end <= caption.start || caption.end > chapter.duration) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["captions", index],
          message: `Caption ${index} must end after it starts and within the chapter's ${chapter.duration}s duration.`,
          params: { errorCode: "tour_caption_out_of_range" },
        });
      }
    });
  });

/**
 * What a tour's Finish does beyond closing (#14098): open this plugin's
 * settings, optionally at one setting, or run one of its own commands. The
 * same two targets a setup step offers, checked by the same manifest-level
 * rules, and dispatched as the user's click.
 */
export const TourFinishSchema = z
  .object({
    /** The line on the last end card that says what Finish will do. */
    hint: z.string().trim().min(1).max(120),
    action: z.discriminatedUnion("kind", [
      SetupStepSettingsActionSchema,
      SetupStepCommandActionSchema,
    ]),
  })
  .strict();

/**
 * One `contributes.tours` entry (#12768): a welcome tour that plays in the same
 * dialog as the Daintree tour. Without `panelKind` it is a plugin tour offered
 * from Help and the command palette; with one it is a panel tour opened from
 * that panel's menu, and the manifest-level `superRefine` requires the kind to
 * be one of this plugin's own `contributes.panels`. `componentPath` is the
 * module exporting the chapter scenes, validated like a view's.
 */
export const TourContributionSchema = z
  .object({
    id: z.string().min(1).max(64).regex(SAFE_ID_PATTERN),
    title: z.string().min(1).max(120),
    componentPath: z.string().min(1).refine(isSafePluginAssetPath, {
      message:
        "componentPath must be a relative plugin asset path (no leading /, backslash, URL scheme, NUL, or .. segments)",
    }),
    panelKind: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    audioHosts: z.array(TourAudioHostSchema).max(TOUR_CONTRIBUTION_LIMITS.audioHosts).default([]),
    chapters: z.array(TourChapterSchema).min(1).max(TOUR_CONTRIBUTION_LIMITS.chapters),
    /**
     * The tour's content version. Saved progress resumes by chapter id only
     * while it matches; bump it when the content changes enough that a
     * half-watched run should start over.
     */
    version: z.string().min(1).max(64).regex(SAFE_ID_PATTERN).optional(),
    finish: TourFinishSchema.optional(),
  })
  .strict()
  .superRefine((tour, ctx) => {
    const hosts = new Set<string>();
    tour.audioHosts.forEach((host, index) => {
      const lower = host.toLowerCase();
      if (hosts.has(lower)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["audioHosts", index],
          message: `Duplicate audio host "${host}".`,
          params: { errorCode: "tour_audio_host_duplicate" },
        });
      }
      hosts.add(lower);
    });

    const chapterIds = new Set<string>();
    tour.chapters.forEach((chapter, index) => {
      if (chapterIds.has(chapter.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["chapters", index, "id"],
          message: `Duplicate chapter id "${chapter.id}" in tour "${tour.id}".`,
          params: { errorCode: "tour_chapter_duplicate_id" },
        });
      }
      chapterIds.add(chapter.id);

      // Remote narration may only come from a host the tour declared, so the
      // list the user sees is the whole story. Malformed URLs were already
      // reported on the field itself.
      if (chapter.audioUrl === null || !URL_SCHEME_PREFIX.test(chapter.audioUrl)) return;
      let hostname: string;
      try {
        hostname = new URL(chapter.audioUrl).hostname;
      } catch {
        return;
      }
      if (!hosts.has(hostname)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["chapters", index, "audioUrl"],
          message: `audioUrl host "${hostname}" is not declared in this tour's audioHosts.`,
          params: { errorCode: "tour_audio_host_undeclared" },
        });
      }
    });
  });
