import { z } from "zod";

export const REMOTE_APPEARANCE_VERSION = 1 as const;

export const RemoteAppearanceColorSchema = z
  .string()
  .regex(/^#[0-9a-f]{8}$/, "Expected a lowercase #rrggbbaa color");

const colorRecord = <const TKeys extends readonly [string, ...string[]]>(keys: TKeys) =>
  z.strictObject(
    Object.fromEntries(keys.map((key) => [key, RemoteAppearanceColorSchema])) as {
      [K in TKeys[number]]: typeof RemoteAppearanceColorSchema;
    }
  );

const lowEmphasisColorSchema = z.strictObject({
  foreground: RemoteAppearanceColorSchema,
  surface: RemoteAppearanceColorSchema,
});

export const RemoteAppearanceSnapshotSchema = z.strictObject({
  version: z.literal(REMOTE_APPEARANCE_VERSION),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  themeId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  displayName: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => !/[\p{C}]/u.test(value)),
  polarity: z.enum(["dark", "light"]),
  surfaces: colorRecord([
    "grid",
    "chrome",
    "canvas",
    "toolbar",
    "panel",
    "elevatedPanel",
    "input",
    "inset",
    "hover",
    "active",
  ]),
  text: colorRecord(["primary", "secondary", "muted", "placeholder", "inverse", "link"]),
  borders: colorRecord(["default", "subtle", "strong", "divider", "interactive"]),
  accent: colorRecord(["primary", "foreground", "soft", "muted", "focusRing"]),
  status: z.strictObject({
    success: lowEmphasisColorSchema,
    warning: lowEmphasisColorSchema,
    danger: lowEmphasisColorSchema,
    info: lowEmphasisColorSchema,
  }),
  activity: z.strictObject({
    active: lowEmphasisColorSchema,
    idle: lowEmphasisColorSchema,
    working: lowEmphasisColorSchema,
    waiting: lowEmphasisColorSchema,
    completed: lowEmphasisColorSchema,
  }),
  terminal: colorRecord([
    "background",
    "foreground",
    "muted",
    "cursor",
    "cursorAccent",
    "selection",
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
  ]),
  strategy: z.strictObject({
    radiusScale: z.number().finite().min(0.5).max(2),
  }),
});

export type RemoteAppearanceColor = z.infer<typeof RemoteAppearanceColorSchema>;
export type RemoteAppearanceSnapshot = z.infer<typeof RemoteAppearanceSnapshotSchema>;
