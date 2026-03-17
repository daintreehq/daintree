import { stripAnsi } from "./AgentPatternDetector.js";

const STATUS_LINE_PATTERNS: RegExp[] = [
  /\b\d+\s*tokens?\b/i,
  /\$\d+\.\d+/,
  /\b\d+%\b/,
  /\[\d+\/\d+\]/,
  /⏱️?\s*\d+[smh]/,
  /[\u2800-\u28FF]/,
  /esc to interrupt/i,
  /[✽✻✦]\s/,
  /\b(?:working|thinking|deliberating|responding|running)\b.*[([]/i,
];

export function countLineRewrites(data: string): number {
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === "\r" && data[i + 1] !== "\n") {
      count++;
    }
  }
  // eslint-disable-next-line no-control-regex
  if (data.includes("\x1b[2K") || data.includes("\x1b[K") || /\u001b\[\d*A/.test(data)) {
    count++;
  }
  return count;
}

export function isStatusLineRewrite(data: string): boolean {
  let hasRewrite = false;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === "\r") {
      if (i + 1 < data.length && data[i + 1] !== "\n") {
        hasRewrite = true;
        break;
      }
      if (i + 1 === data.length) {
        return false;
      }
    }
  }
  if (
    !hasRewrite &&
    !data.includes("\x1b[2K") &&
    !data.includes("\x1b[K") &&
    // eslint-disable-next-line no-control-regex
    !/\u001b\[\d*A/.test(data)
  ) {
    return false;
  }

  const stripped = stripAnsi(data);
  return STATUS_LINE_PATTERNS.some((pattern) => pattern.test(stripped));
}

export interface LineRewriteConfig {
  enabled?: boolean;
  windowMs?: number;
  minRewrites?: number;
}

export class LineRewriteDetector {
  private readonly enabled: boolean;
  private readonly windowMs: number;
  private readonly minCount: number;
  private windowStart = 0;
  private count = 0;
  lastSpinnerDetectedAt = 0;

  constructor(config?: LineRewriteConfig) {
    const defaults = { enabled: true, windowMs: 500, minRewrites: 2 };
    const c = { ...defaults, ...config };
    this.enabled = c.enabled;
    this.windowMs = c.windowMs;
    this.minCount = c.minRewrites;
  }

  update(data: string, now: number): boolean {
    if (!this.enabled) {
      return false;
    }

    const rewriteHits = countLineRewrites(data);
    if (rewriteHits === 0) {
      return false;
    }

    if (this.windowStart === 0 || now - this.windowStart > this.windowMs) {
      this.windowStart = now;
      this.count = rewriteHits;
    } else {
      this.count += rewriteHits;
    }

    if (this.count >= this.minCount) {
      this.lastSpinnerDetectedAt = now;
      return true;
    }

    return false;
  }

  isSpinnerActive(now: number, spinnerActiveMs: number): boolean {
    return this.lastSpinnerDetectedAt > 0 && now - this.lastSpinnerDetectedAt <= spinnerActiveMs;
  }

  reset(): void {
    this.windowStart = 0;
    this.count = 0;
    this.lastSpinnerDetectedAt = 0;
  }
}
