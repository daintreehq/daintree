import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeViteDevCommand } from "../DevPreviewCommandNormalizer.js";

const mockReadFile = vi.fn<(path: string, encoding: string) => Promise<string>>();

vi.mock("node:fs/promises", () => ({
  default: { readFile: (...args: unknown[]) => mockReadFile(...(args as [string, string])) },
  readFile: (...args: unknown[]) => mockReadFile(...(args as [string, string])),
}));

beforeEach(() => {
  mockReadFile.mockReset();
});

function mockPkg(scripts: Record<string, string>): void {
  mockReadFile.mockResolvedValue(JSON.stringify({ scripts }));
}

function mockNoPkg(): void {
  mockReadFile.mockRejectedValue(new Error("ENOENT"));
}

const CWD = "/project";
const PORT = 43210;

describe("normalizeViteDevCommand", () => {
  describe("direct Vite commands", () => {
    it("appends --port and --strictPort to bare 'vite'", async () => {
      expect(await normalizeViteDevCommand("vite", CWD, PORT)).toBe(
        `vite --port ${PORT} --strictPort`
      );
    });

    it("appends --port and --strictPort to 'vite dev'", async () => {
      expect(await normalizeViteDevCommand("vite dev", CWD, PORT)).toBe(
        `vite dev --port ${PORT} --strictPort`
      );
    });

    it("appends --port and --strictPort to 'npx vite'", async () => {
      expect(await normalizeViteDevCommand("npx vite", CWD, PORT)).toBe(
        `npx vite --port ${PORT} --strictPort`
      );
    });

    it("preserves existing flags before appending", async () => {
      expect(await normalizeViteDevCommand("vite dev --host 0.0.0.0", CWD, PORT)).toBe(
        `vite dev --host 0.0.0.0 --port ${PORT} --strictPort`
      );
    });
  });

  describe("SvelteKit commands", () => {
    it("appends --port and --strictPort to 'svelte-kit dev'", async () => {
      expect(await normalizeViteDevCommand("svelte-kit dev", CWD, PORT)).toBe(
        `svelte-kit dev --port ${PORT} --strictPort`
      );
    });
  });

  describe("Astro commands (no --strictPort)", () => {
    it("appends --port only to 'astro dev'", async () => {
      expect(await normalizeViteDevCommand("astro dev", CWD, PORT)).toBe(
        `astro dev --port ${PORT}`
      );
    });

    it("does NOT append --strictPort for Astro via pkg manager", async () => {
      mockPkg({ dev: "astro dev" });
      expect(await normalizeViteDevCommand("npm run dev", CWD, PORT)).toBe(
        `npm run dev -- --port ${PORT}`
      );
    });
  });

  describe("Nuxt commands (no --strictPort)", () => {
    it("appends --port only to 'nuxt dev'", async () => {
      expect(await normalizeViteDevCommand("nuxt dev", CWD, PORT)).toBe(
        `nuxt dev --port ${PORT}`
      );
    });
  });

  describe("package manager script commands", () => {
    it("appends ` -- --port N --strictPort` for npm run dev resolving to vite", async () => {
      mockPkg({ dev: "vite" });
      expect(await normalizeViteDevCommand("npm run dev", CWD, PORT)).toBe(
        `npm run dev -- --port ${PORT} --strictPort`
      );
    });

    it("appends ` -- --port N --strictPort` for pnpm dev", async () => {
      mockPkg({ dev: "vite" });
      expect(await normalizeViteDevCommand("pnpm dev", CWD, PORT)).toBe(
        `pnpm dev -- --port ${PORT} --strictPort`
      );
    });

    it("appends ` -- --port N --strictPort` for pnpm run dev", async () => {
      mockPkg({ dev: "vite" });
      expect(await normalizeViteDevCommand("pnpm run dev", CWD, PORT)).toBe(
        `pnpm run dev -- --port ${PORT} --strictPort`
      );
    });

    it("appends ` -- --port N --strictPort` for yarn dev", async () => {
      mockPkg({ dev: "vite" });
      expect(await normalizeViteDevCommand("yarn dev", CWD, PORT)).toBe(
        `yarn dev -- --port ${PORT} --strictPort`
      );
    });

    it("appends ` --port N --strictPort` (no -- separator) for bun run dev", async () => {
      mockPkg({ dev: "vite" });
      expect(await normalizeViteDevCommand("bun run dev", CWD, PORT)).toBe(
        `bun run dev --port ${PORT} --strictPort`
      );
    });

    it("appends ` --port N --strictPort` for bun dev", async () => {
      mockPkg({ dev: "vite" });
      expect(await normalizeViteDevCommand("bun dev", CWD, PORT)).toBe(
        `bun dev --port ${PORT} --strictPort`
      );
    });

    it("resolves pkg script body for SvelteKit (vite dev under the hood)", async () => {
      mockPkg({ dev: "vite dev" });
      expect(await normalizeViteDevCommand("npm run dev", CWD, PORT)).toBe(
        `npm run dev -- --port ${PORT} --strictPort`
      );
    });

    it("resolves pkg script body for Astro and omits --strictPort", async () => {
      mockPkg({ start: "astro dev" });
      expect(await normalizeViteDevCommand("npm run start", CWD, PORT)).toBe(
        `npm run start -- --port ${PORT}`
      );
    });

    it("resolves pkg script body for Nuxt and omits --strictPort", async () => {
      mockPkg({ dev: "nuxt dev" });
      expect(await normalizeViteDevCommand("npm run dev", CWD, PORT)).toBe(
        `npm run dev -- --port ${PORT}`
      );
    });
  });

  describe("skip conditions", () => {
    it("does NOT modify when command already has --port flag", async () => {
      expect(await normalizeViteDevCommand("vite --port 5173", CWD, PORT)).toBe(
        "vite --port 5173"
      );
    });

    it("does NOT modify when command has --port=N form", async () => {
      expect(await normalizeViteDevCommand("vite --port=5173", CWD, PORT)).toBe(
        "vite --port=5173"
      );
    });

    it("does NOT modify when command has -p flag", async () => {
      expect(await normalizeViteDevCommand("vite -p 5173", CWD, PORT)).toBe("vite -p 5173");
    });

    it("does NOT modify when command has PORT= env prefix", async () => {
      expect(await normalizeViteDevCommand("PORT=5173 vite", CWD, PORT)).toBe("PORT=5173 vite");
    });

    it("does NOT modify when resolved pkg script already specifies --port", async () => {
      mockPkg({ dev: "vite --port 5173" });
      expect(await normalizeViteDevCommand("npm run dev", CWD, PORT)).toBe("npm run dev");
    });

    it("leaves compound && command unchanged", async () => {
      expect(await normalizeViteDevCommand("vite && echo done", CWD, PORT)).toBe(
        "vite && echo done"
      );
    });

    it("leaves piped command unchanged", async () => {
      expect(await normalizeViteDevCommand("vite | tee log", CWD, PORT)).toBe("vite | tee log");
    });

    it("leaves commented command unchanged", async () => {
      expect(await normalizeViteDevCommand("vite # default", CWD, PORT)).toBe("vite # default");
    });

    it("leaves backtick-substituted command unchanged", async () => {
      expect(await normalizeViteDevCommand("vite `whoami`", CWD, PORT)).toBe("vite `whoami`");
    });

    it("does NOT modify when pkg script body has shell control", async () => {
      mockPkg({ dev: "vite && echo done" });
      expect(await normalizeViteDevCommand("npm run dev", CWD, PORT)).toBe("npm run dev");
    });

    it("does NOT modify when no package.json exists", async () => {
      mockNoPkg();
      expect(await normalizeViteDevCommand("npm run dev", CWD, PORT)).toBe("npm run dev");
    });

    it("does NOT modify when script name not found in package.json", async () => {
      mockPkg({ start: "vite" });
      expect(await normalizeViteDevCommand("npm run dev", CWD, PORT)).toBe("npm run dev");
    });

    it("does NOT modify Next.js commands", async () => {
      expect(await normalizeViteDevCommand("next dev", CWD, PORT)).toBe("next dev");
    });

    it("does NOT modify Remix commands (no CLI --port flag)", async () => {
      expect(await normalizeViteDevCommand("remix dev", CWD, PORT)).toBe("remix dev");
    });

    it("does NOT modify arbitrary commands", async () => {
      expect(await normalizeViteDevCommand("python manage.py runserver", CWD, PORT)).toBe(
        "python manage.py runserver"
      );
    });

    it("does NOT modify pkg manager scripts that resolve to non-Vite commands", async () => {
      mockPkg({ dev: "next dev" });
      expect(await normalizeViteDevCommand("npm run dev", CWD, PORT)).toBe("npm run dev");
    });
  });

  describe("idempotency", () => {
    it("calling twice does not double-append (PORT_FLAG_PRESENT_RE skip)", async () => {
      const once = await normalizeViteDevCommand("vite", CWD, PORT);
      const twice = await normalizeViteDevCommand(once, CWD, PORT);
      expect(twice).toBe(once);
    });
  });
});
