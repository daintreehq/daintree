import { describe, it, expect, vi } from "vitest";
import type { Terminal, IBufferLine } from "@xterm/xterm";
import { ImageLinksAddon } from "../ImageLinksAddon";

describe("ImageLinksAddon", () => {
  const createMockTerminal = () => {
    return {
      buffer: {
        active: {
          getLine: vi.fn(),
        },
      },
    } as unknown as Terminal;
  };

  const createMockLine = (text: string): IBufferLine => {
    return {
      translateToString: () => text,
    } as IBufferLine;
  };

  const mouseEvent = (mods: Partial<MouseEvent> = {}): MouseEvent =>
    ({ metaKey: false, ctrlKey: false, ...mods }) as unknown as MouseEvent;

  const setup = (lineText: string, figureNumbers: number[]) => {
    const terminal = createMockTerminal();
    const onActivate = vi.fn();
    const addon = new ImageLinksAddon(terminal, () => figureNumbers, onActivate);
    vi.mocked(terminal.buffer.active.getLine).mockReturnValue(createMockLine(lineText));
    return { terminal, addon, onActivate };
  };

  describe("matching", () => {
    it("matches a bracketed reference when the figure exists", () => {
      return new Promise<void>((resolve) => {
        const { addon } = setup("See [image #2] for details", [1, 2, 3]);
        addon.provideLinks(1, (links) => {
          expect(links).toHaveLength(1);
          expect(links![0]!.text).toBe("[image #2]");
          resolve();
        });
      });
    });

    it("matches a bare reference when the figure exists", () => {
      return new Promise<void>((resolve) => {
        const { addon } = setup("Compare with image #3 above", [3]);
        addon.provideLinks(1, (links) => {
          expect(links).toHaveLength(1);
          expect(links![0]!.text).toBe("image #3");
          resolve();
        });
      });
    });

    it("matches case-insensitively", () => {
      return new Promise<void>((resolve) => {
        const { addon } = setup("See [IMAGE #2]", [2]);
        addon.provideLinks(1, (links) => {
          expect(links).toHaveLength(1);
          expect(links![0]!.text).toBe("[IMAGE #2]");
          resolve();
        });
      });
    });

    it("matches multiple references on one line", () => {
      return new Promise<void>((resolve) => {
        const { addon } = setup("[image #1] and [image #2]", [1, 2]);
        addon.provideLinks(1, (links) => {
          expect(links).toHaveLength(2);
          expect(links![0]!.text).toBe("[image #1]");
          expect(links![1]!.text).toBe("[image #2]");
          resolve();
        });
      });
    });

    it("computes a 1-based inclusive range", () => {
      return new Promise<void>((resolve) => {
        const { addon } = setup("ab [image #5]", [5]);
        addon.provideLinks(7, (links) => {
          expect(links).toHaveLength(1);
          const range = links![0]!.range;
          // "[image #5]" starts at index 3 (1-based x = 4), length 10.
          expect(range.start.x).toBe(4);
          expect(range.end.x).toBe(13);
          expect(range.start.y).toBe(7);
          expect(range.end.y).toBe(7);
          resolve();
        });
      });
    });
  });

  describe("inert cases", () => {
    it("returns undefined for an unknown figure number", () => {
      return new Promise<void>((resolve) => {
        const { addon } = setup("See [image #9]", [1, 2]);
        addon.provideLinks(1, (links) => {
          expect(links).toBeUndefined();
          resolve();
        });
      });
    });

    it("returns undefined when no figures exist", () => {
      return new Promise<void>((resolve) => {
        const { addon } = setup("See [image #1]", []);
        addon.provideLinks(1, (links) => {
          expect(links).toBeUndefined();
          resolve();
        });
      });
    });

    it("links only the known figures on a mixed line", () => {
      return new Promise<void>((resolve) => {
        const { addon } = setup("[image #1] then [image #9]", [1]);
        addon.provideLinks(1, (links) => {
          expect(links).toHaveLength(1);
          expect(links![0]!.text).toBe("[image #1]");
          resolve();
        });
      });
    });

    it("does not match when preceded by a word character", () => {
      return new Promise<void>((resolve) => {
        const { addon } = setup("reimage #2 done", [2]);
        addon.provideLinks(1, (links) => {
          expect(links).toBeUndefined();
          resolve();
        });
      });
    });

    it("does not match when followed by a word character", () => {
      return new Promise<void>((resolve) => {
        const { addon } = setup("image #2abc", [2]);
        addon.provideLinks(1, (links) => {
          expect(links).toBeUndefined();
          resolve();
        });
      });
    });

    it("stays inert for figure #0 when 0 is not a known figure", () => {
      return new Promise<void>((resolve) => {
        const { addon } = setup("[image #0]", [1, 2]);
        addon.provideLinks(1, (links) => {
          expect(links).toBeUndefined();
          resolve();
        });
      });
    });

    it("stays inert for an out-of-range figure number", () => {
      return new Promise<void>((resolve) => {
        const { addon } = setup("[image #9007199254740993]", [1, 2]);
        addon.provideLinks(1, (links) => {
          expect(links).toBeUndefined();
          resolve();
        });
      });
    });

    it("does not match a missing figure number", () => {
      return new Promise<void>((resolve) => {
        const { addon } = setup("see [image #] here", [1, 2]);
        addon.provideLinks(1, (links) => {
          expect(links).toBeUndefined();
          resolve();
        });
      });
    });

    it("returns undefined for line numbers below 1", () => {
      return new Promise<void>((resolve) => {
        const { addon } = setup("[image #1]", [1]);
        addon.provideLinks(0, (links) => {
          expect(links).toBeUndefined();
          resolve();
        });
      });
    });

    it("returns undefined when the buffer line is missing", () => {
      return new Promise<void>((resolve) => {
        const terminal = createMockTerminal();
        const addon = new ImageLinksAddon(terminal, () => [1], vi.fn());
        vi.mocked(terminal.buffer.active.getLine).mockReturnValue(undefined);
        addon.provideLinks(1, (links) => {
          expect(links).toBeUndefined();
          resolve();
        });
      });
    });
  });

  describe("activation", () => {
    it("activates with openLightbox=false on a plain click", () => {
      return new Promise<void>((resolve) => {
        const { addon, onActivate } = setup("[image #2]", [2]);
        addon.provideLinks(1, (links) => {
          links![0]!.activate(mouseEvent(), links![0]!.text);
          expect(onActivate).toHaveBeenCalledWith(2, false);
          resolve();
        });
      });
    });

    it("activates with openLightbox=true on a meta click", () => {
      return new Promise<void>((resolve) => {
        const { addon, onActivate } = setup("[image #2]", [2]);
        addon.provideLinks(1, (links) => {
          links![0]!.activate(mouseEvent({ metaKey: true }), links![0]!.text);
          expect(onActivate).toHaveBeenCalledWith(2, true);
          resolve();
        });
      });
    });

    it("activates with openLightbox=true on a ctrl click", () => {
      return new Promise<void>((resolve) => {
        const { addon, onActivate } = setup("[image #2]", [2]);
        addon.provideLinks(1, (links) => {
          links![0]!.activate(mouseEvent({ ctrlKey: true }), links![0]!.text);
          expect(onActivate).toHaveBeenCalledWith(2, true);
          resolve();
        });
      });
    });
  });

  describe("live figure state", () => {
    it("reflects figure changes without re-registration", () => {
      return new Promise<void>((resolve) => {
        const terminal = createMockTerminal();
        let figures: number[] = [];
        const addon = new ImageLinksAddon(terminal, () => figures, vi.fn());
        vi.mocked(terminal.buffer.active.getLine).mockReturnValue(createMockLine("[image #4]"));

        addon.provideLinks(1, (before) => {
          expect(before).toBeUndefined();
          figures = [4];
          addon.provideLinks(1, (after) => {
            expect(after).toHaveLength(1);
            expect(after![0]!.text).toBe("[image #4]");
            resolve();
          });
        });
      });
    });
  });
});
