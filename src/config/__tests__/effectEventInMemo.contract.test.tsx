// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { memo, useEffect, useEffectEvent } from "react";
import { render } from "@testing-library/react";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(TEST_DIR, "../..");

// On React 19.2 a `useEffectEvent` declared inside a `memo` or `forwardRef`
// render keeps its first render's closure (facebook/react#34818, fixed in
// 19.3). It fails silently: the toolbar forge stats read `stats === null` on
// every poll, so its count pulse and activity chips never fired, and a grid
// tab group never restored focus on tab switch. Until the fix ships, a
// component that needs both reads the latest values from its effect instead.

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "__preview__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("useEffectEvent inside memo / forwardRef", () => {
  it("is not combined in any component file", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => {
        const source = fs.readFileSync(file, "utf-8");
        return /\buseEffectEvent\s*\(/.test(source) && /\b(memo|forwardRef)\s*\(/.test(source);
      })
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  // Canary for the guard above. When this starts failing, React has fixed the
  // bug for the installed version and the guard can be retired.
  it("still reproduces the stale closure on the installed React", () => {
    const seen: number[] = [];
    const Probe = memo(function Probe({ value }: { value: number }) {
      const read = useEffectEvent(() => value);
      useEffect(() => {
        seen.push(read());
      }, [value]);
      return null;
    });
    const { rerender } = render(<Probe value={1} />);
    rerender(<Probe value={2} />);
    expect(seen.at(-1)).toBe(1);
  });
});
