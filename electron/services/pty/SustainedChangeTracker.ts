export const AGENT_WORKING_RECOVERY_WINDOW_MS = 2500;
export const AGENT_WORKING_RECOVERY_MIN_SUSTAIN_MS = 2000;
export const AGENT_WORKING_RECOVERY_MIN_CHANGED_FRAMES = 4;
export const AGENT_WORKING_RECOVERY_MAX_QUIET_MS = 3000;
export const AGENT_WORKING_RECOVERY_MIN_HEAT = 4;
export const AGENT_WORKING_RECOVERY_LARGE_CHANGE_WINDOW_MS = 1000;
export const AGENT_WORKING_RECOVERY_LARGE_CHANGE_MIN_FRAMES = 3;
export const AGENT_WORKING_RECOVERY_LARGE_CHANGE_MIN_HEAT = 12;
export interface SustainedChangeTrackerOptions {
  windowMs: number;
  minChangedFrames: number;
  maxQuietMs: number;
  minSustainMs?: number;
  minHeat?: number;
  largeChangeWindowMs?: number;
  largeChangeMinFrames?: number;
  largeChangeMinHeat?: number;
}

export interface ChangeObservation {
  changedChars: number;
}

export interface VisibleContentSnapshot {
  text: string;
  units: readonly string[];
  hash: number;
  length: number;
}

export interface VisibleContentDelta {
  changed: boolean;
  changedChars: number;
}

interface ChangeSample {
  at: number;
  heat: number;
}

interface NormalizedVisibleUnit {
  key: string;
  collapsible: boolean;
}

export interface VisibleContentCell {
  chars: string;
  code: number;
  width: number;
  fgColorMode: number;
  fgColor: number;
  attributes: number;
}

export class SustainedChangeTracker {
  private lastChangedAt: number | undefined;
  private readonly minHeat: number;
  private readonly minSustainMs: number;
  private readonly largeChangeWindowMs: number;
  private readonly largeChangeMinFrames: number;
  private readonly largeChangeMinHeat: number;
  private samples: ChangeSample[] = [];

  constructor(private readonly options: SustainedChangeTrackerOptions) {
    this.minHeat = options.minHeat ?? AGENT_WORKING_RECOVERY_MIN_HEAT;
    this.minSustainMs = options.minSustainMs ?? AGENT_WORKING_RECOVERY_MIN_SUSTAIN_MS;
    this.largeChangeWindowMs =
      options.largeChangeWindowMs ?? AGENT_WORKING_RECOVERY_LARGE_CHANGE_WINDOW_MS;
    this.largeChangeMinFrames =
      options.largeChangeMinFrames ?? AGENT_WORKING_RECOVERY_LARGE_CHANGE_MIN_FRAMES;
    this.largeChangeMinHeat =
      options.largeChangeMinHeat ?? AGENT_WORKING_RECOVERY_LARGE_CHANGE_MIN_HEAT;
  }

  observe(now: number, observation: ChangeObservation): boolean {
    const changedChars = Number.isFinite(observation.changedChars)
      ? Math.max(0, observation.changedChars)
      : 0;
    if (changedChars <= 0) {
      this.resetIfQuiet(now);
      return false;
    }

    if (this.lastChangedAt !== undefined && now - this.lastChangedAt > this.options.maxQuietMs) {
      this.reset();
    }

    this.lastChangedAt = now;
    this.samples.push({ at: now, heat: heatForChangedChars(changedChars) });
    this.prune(now, this.options.windowMs);

    return this.hasSustainedHeat(now) || this.hasLargeChangeHeat(now);
  }

  reset(): void {
    this.lastChangedAt = undefined;
    this.samples.length = 0;
  }

  private resetIfQuiet(now: number): void {
    if (this.lastChangedAt !== undefined && now - this.lastChangedAt > this.options.maxQuietMs) {
      this.reset();
    }
  }

  private prune(now: number, windowMs: number): void {
    const earliest = now - windowMs;
    while (this.samples.length > 0 && this.samples[0]!.at < earliest) {
      this.samples.shift();
    }
  }

  private hasSustainedHeat(now: number): boolean {
    if (this.samples.length < this.options.minChangedFrames) {
      return false;
    }

    const firstAt = this.samples[0]!.at;
    if (now - firstAt < this.minSustainMs) {
      return false;
    }

    return sumHeat(this.samples) >= this.minHeat;
  }

  private hasLargeChangeHeat(now: number): boolean {
    const earliest = now - this.largeChangeWindowMs;
    const recent = this.samples.filter((sample) => sample.at >= earliest);
    if (recent.length < this.largeChangeMinFrames) {
      return false;
    }

    const firstAt = recent[0]!.at;
    if (now - firstAt < this.largeChangeWindowMs) {
      return false;
    }

    return sumHeat(recent) >= this.largeChangeMinHeat;
  }
}

const HASH_UNIT_SEPARATOR = 10; // LF byte — delimiter between string units in the FNV-1a hash stream

export function hashStrings(values: readonly string[]): number {
  let hash = 0x811c9dc5;
  for (const value of values) {
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= HASH_UNIT_SEPARATOR;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function normalizeVisibleContent(values: string | readonly string[]): string {
  const text = typeof values === "string" ? values : values.join("");
  return normalizeTextUnits(text).join("");
}

export function createVisibleContentSnapshot(
  values: string | readonly string[]
): VisibleContentSnapshot {
  return createSnapshotFromUnits(
    normalizeTextUnits(typeof values === "string" ? values : values.join(""))
  );
}

export function createVisibleCellContentSnapshot(
  rows: readonly (readonly VisibleContentCell[])[]
): VisibleContentSnapshot {
  return createSnapshotFromUnits(normalizeCellUnits(rows));
}

export function measureVisibleContentDelta(
  previous: VisibleContentSnapshot | undefined,
  current: VisibleContentSnapshot
): VisibleContentDelta {
  if (
    !previous ||
    (previous.hash === current.hash &&
      previous.length === current.length &&
      previous.text === current.text)
  ) {
    return { changed: false, changedChars: 0 };
  }

  const previousChars = previous.units ?? Array.from(previous.text);
  const currentChars = current.units ?? Array.from(current.text);
  if (isSuffixOf(previousChars, currentChars) || isSuffixOf(currentChars, previousChars)) {
    return { changed: false, changedChars: 0 };
  }

  let prefix = 0;
  while (
    prefix < previousChars.length &&
    prefix < currentChars.length &&
    previousChars[prefix] === currentChars[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < previousChars.length - prefix &&
    suffix < currentChars.length - prefix &&
    previousChars[previousChars.length - 1 - suffix] ===
      currentChars[currentChars.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const previousChanged = previousChars.length - prefix - suffix;
  const currentChanged = currentChars.length - prefix - suffix;
  const changedChars = Math.max(previousChanged, currentChanged);
  return { changed: changedChars > 0, changedChars };
}

function isSuffixOf(needle: readonly string[], haystack: readonly string[]): boolean {
  if (needle.length > haystack.length) {
    return false;
  }
  const offset = haystack.length - needle.length;
  for (let index = 0; index < needle.length; index += 1) {
    if (needle[index] !== haystack[offset + index]) {
      return false;
    }
  }
  return true;
}

function normalizeTextUnits(text: string): string[] {
  const units: NormalizedVisibleUnit[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code === 32 || (code >= 9 && code <= 13)) continue;
    if (code > 127 && /\s/u.test(char)) continue;
    units.push({ key: char, collapsible: isCollapsibleFillText(char) });
  }
  return collapseRepeatedUnits(units);
}

function normalizeCellUnits(rows: readonly (readonly VisibleContentCell[])[]): string[] {
  const units: NormalizedVisibleUnit[] = [];
  for (const row of rows) {
    for (const cell of row) {
      const unit = visibleCellUnit(cell);
      if (unit !== null) {
        units.push(unit);
      }
    }
  }
  return collapseRepeatedUnits(units);
}

function visibleCellUnit(cell: VisibleContentCell): NormalizedVisibleUnit | null {
  if (cell.width === 0) {
    return null;
  }

  const chars = cell.chars;
  if (chars.length === 0 || chars === " " || /^\s*$/u.test(chars)) {
    return null;
  }

  return {
    key: `${chars}|${cell.code}|${cell.width}|${cell.fgColorMode}|${cell.fgColor}|${foregroundContentAttributes(cell.attributes)}`,
    collapsible: isCollapsibleFillText(chars),
  };
}

const INVERSE_ATTRIBUTE = 1 << 5;

function foregroundContentAttributes(attributes: number): number {
  return attributes & ~INVERSE_ATTRIBUTE;
}

function collapseRepeatedUnits(units: readonly NormalizedVisibleUnit[]): string[] {
  const collapsed: string[] = [];
  let lastUnit: NormalizedVisibleUnit | undefined;
  for (const unit of units) {
    if (lastUnit && unit.collapsible && lastUnit.key === unit.key) {
      continue;
    }
    collapsed.push(unit.key);
    lastUnit = unit;
  }
  return collapsed;
}

const COLLAPSIBLE_FILL_CHARS = new Set([
  "-",
  "_",
  "=",
  ".",
  "·",
  "•",
  "∙",
  "●",
  "─",
  "━",
  "═",
  "╌",
  "╍",
  "⎯",
  "▁",
  "▔",
]);

export function isCollapsibleFillText(text: string): boolean {
  if (COLLAPSIBLE_FILL_CHARS.has(text)) {
    return true;
  }
  const chars = Array.from(text);
  return chars.length > 0 && chars.every((char) => COLLAPSIBLE_FILL_CHARS.has(char));
}

function createSnapshotFromUnits(units: string[]): VisibleContentSnapshot {
  const text = units.join("");
  return {
    text,
    units,
    hash: hashStrings(units),
    length: units.length,
  };
}

function heatForChangedChars(changedChars: number): number {
  if (changedChars <= 0) return 0;
  if (changedChars === 1) return 1;
  if (changedChars <= 16) return 2;
  if (changedChars <= 64) return 4;
  return 6;
}

function sumHeat(samples: readonly ChangeSample[]): number {
  return samples.reduce((total, sample) => total + sample.heat, 0);
}
