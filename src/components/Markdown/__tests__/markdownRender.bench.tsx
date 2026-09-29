// @vitest-environment jsdom
// Run: npx vitest bench --run src/components/Markdown/__tests__/markdownRender.bench.tsx
import { afterAll, beforeAll, bench, describe, vi } from "vitest";
import { act, cleanup, render, type RenderResult } from "@testing-library/react";
import { refractor } from "refractor/core";

const counters = vi.hoisted(() => ({ gfm: 0 }));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

// react-markdown builds a fresh processor, and so calls every remark plugin's
// attacher, once per parse — counting remark-gfm attaches counts parses.
vi.mock("remark-gfm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remark-gfm")>();
  return {
    default: function countedRemarkGfm(this: unknown, ...args: unknown[]) {
      counters.gfm += 1;
      return (actual.default as (...a: unknown[]) => unknown).apply(this, args);
    },
  };
});

import { MarkdownDocument } from "../MarkdownDocument";
import * as policy from "../markdownRenderPolicy";
import { ensureLanguage } from "@/components/Worktree/diffRefractor";

const PROPS = { filePath: "/repo/docs/spec.md", rootPath: "/repo" };

function buildDoc(targetLines: number): string {
  const lines: string[] = [];
  let section = 0;
  while (lines.length < targetLines) {
    section += 1;
    lines.push(
      `## Section ${section}`,
      "",
      `Paragraph with **bold**, _emphasis_, \`inline code\`, a [link](./other-${section}.md) and https://example.com/${section}.`,
      "",
      `- [x] done item ${section}`,
      `- [ ] open item ${section}`,
      "- nested",
      "  - child",
      "",
      "| Col A | Col B | Col C |",
      "| ----- | ----- | ----- |",
      `| a${section} | b${section} | c${section} |`,
      `| d${section} | e${section} | f${section} |`,
      "",
      `![diagram ${section}](./img/arch-${section}.png)`,
      "",
      "```ts",
      `export function fn${section}(value: number): string {`,
      `  return String(value * ${section});`,
      "}",
      "```",
      ""
    );
  }
  return lines.join("\n");
}

function buildTs(targetLines: number): string {
  const lines: string[] = [];
  let i = 0;
  while (lines.length < targetLines) {
    i += 1;
    lines.push(
      `interface Shape${i} { id: number; name: string; tags: readonly string[] }`,
      `export async function handle${i}(input: Shape${i}): Promise<string> {`,
      `  const total = input.tags.reduce((acc, tag) => acc + tag.length, ${i});`,
      `  // comment ${i}`,
      "  return `${input.name}:${total}`;",
      "}"
    );
  }
  return lines.join("\n");
}

const DOC = buildDoc(3000);
const TS_FENCE = buildTs(5000);
const REPORT: string[] = [];

beforeAll(async () => {
  await ensureLanguage("typescript");
});

afterAll(() => {
  process.stdout.write(`\n${REPORT.join("\n")}\n`);
});

describe("MarkdownDocument: cacheBust-only rerender (3k-line doc)", () => {
  let view: RenderResult | null = null;
  let tick = 0;

  bench(
    "rerender with only cacheBust changing",
    () => {
      tick += 1;
      act(() => {
        view!.rerender(<MarkdownDocument {...PROPS} content={DOC} cacheBust={String(tick)} />);
      });
    },
    {
      time: 3000,
      warmupIterations: 3,
      setup: () => {
        view?.unmount();
        view = render(<MarkdownDocument {...PROPS} content={DOC} cacheBust="0" />);
        // One mount, then 20 token-only rerenders: how many times is the whole
        // document parsed?
        counters.gfm = 0;
        for (let i = 1; i <= 20; i++) {
          act(() => {
            view!.rerender(<MarkdownDocument {...PROPS} content={DOC} cacheBust={`probe-${i}`} />);
          });
        }
        const imgs = view.container.querySelectorAll("img");
        const src = imgs[0]?.getAttribute("src") ?? "";
        REPORT.push(
          `[markdown] parses over 20 cacheBust-only rerenders: ${counters.gfm}; ` +
            `first img v=${new URL(src).searchParams.get("v")} (${imgs.length} imgs)`
        );
      },
      teardown: () => {
        view?.unmount();
        view = null;
      },
    }
  );
});

describe("HighlightedCode: 5k-line TS fence mount", () => {
  let highlightCalls = 0;
  const clearCache = () =>
    (policy as { _clearHighlightCacheForTests?: () => void })._clearHighlightCacheForTests?.();

  const mountOnce = () => {
    render(<policy.HighlightedCode language="ts" code={TS_FENCE} />);
    // Unmounts and detaches the container, so samples don't accumulate fixtures.
    cleanup();
  };

  bench(
    "cold mount (empty highlight cache)",
    () => {
      clearCache();
      mountOnce();
    },
    { time: 3000, warmupIterations: 2 }
  );

  bench(
    "remount of the same fence",
    () => {
      mountOnce();
    },
    {
      time: 3000,
      warmupIterations: 2,
      setup: () => {
        clearCache();
        const spy = vi.spyOn(refractor, "highlight");
        for (let i = 0; i < 5; i++) mountOnce();
        highlightCalls = spy.mock.calls.length;
        spy.mockRestore();
        REPORT.push(`[highlight] refractor.highlight calls over 5 remounts: ${highlightCalls}`);
        clearCache();
        mountOnce();
      },
    }
  );
});
