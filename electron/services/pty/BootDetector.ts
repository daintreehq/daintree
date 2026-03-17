export const BOOT_COMPLETE_PATTERNS = [
  /claude\s+code\s+v?\d/i,
  /openai[-\s]+codex/i,
  /codex\s+v/i,
  /type\s+your\s+message/i,
];

export function isBootComplete(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export class BootDetector {
  hasExitedBootState = false;
  pollingStartTime = 0;
  private readonly patterns: RegExp[];

  constructor(patterns?: RegExp[]) {
    this.patterns = patterns && patterns.length > 0 ? patterns : BOOT_COMPLETE_PATTERNS;
  }

  check(
    strippedText: string,
    isPrompt: boolean,
    timeSinceBoot: number,
    maxBootMs: number
  ): boolean {
    if (this.hasExitedBootState) {
      return true;
    }

    if (isPrompt || isBootComplete(strippedText, this.patterns) || timeSinceBoot >= maxBootMs) {
      this.hasExitedBootState = true;
      return true;
    }

    return false;
  }

  markExited(): void {
    this.hasExitedBootState = true;
  }

  reset(): void {
    this.hasExitedBootState = false;
    this.pollingStartTime = 0;
  }
}
