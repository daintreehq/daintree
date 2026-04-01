import { describe, expect, it, vi } from "vitest";
import { normalizeNextjsDevCommand } from "../DevPreviewSessionService.js";

const mockReadFile = vi.fn<(path: string, encoding: string) => Promise<string>>();

vi.mock("node:fs/promises", () => ({
  default: { readFile: (...args: unknown[]) => mockReadFile(...(args as [string, string])) },
  readFile: (...args: unknown[]) => mockReadFile(...(args as [string, string])),
}));

import { beforeEach } from "vitest";

beforeEach(() => {
  mockReadFile.mockReset();
});

function mockPkg(scripts: Record<string, string>): void {
  mockReadFile.mockResolvedValue(JSON.stringify({ scripts }));
}

function mockNoPkg(): void {
  mockReadFile.mockRejectedValue(new Error("ENOENT"));
}

describe("normalizeNextjsDevCommand", () => {
  const CWD = "/project";

  describe("direct next dev commands", () => {
    it("appends --turbopack to 'next dev'", async () => {
      expect(await normalizeNextjsDevCommand("next dev", CWD)).toBe("next dev --turbopack");
    });

    it("appends --turbopack to 'npx next dev'", async () => {
      expect(await normalizeNextjsDevCommand("npx next dev", CWD)).toBe("npx next dev --turbopack");
    });

    it("appends --turbopack to 'next dev -p 3001'", async () => {
      expect(await normalizeNextjsDevCommand("next dev -p 3001", CWD)).toBe(
        "next dev -p 3001 --turbopack"
      );
    });

    it("does NOT double-add if --turbopack already present", async () => {
      expect(await normalizeNextjsDevCommand("next dev --turbopack", CWD)).toBe(
        "next dev --turbopack"
      );
    });

    it("does NOT double-add if --turbo already present", async () => {
      expect(await normalizeNextjsDevCommand("next dev --turbo", CWD)).toBe("next dev --turbo");
    });
  });

  describe("package manager script commands", () => {
    it("appends -- --turbopack for npm run dev when script is next dev", async () => {
      mockPkg({ dev: "next dev" });
      expect(await normalizeNextjsDevCommand("npm run dev", CWD)).toBe(
        "npm run dev -- --turbopack"
      );
    });

    it("appends -- --turbopack for pnpm dev", async () => {
      mockPkg({ dev: "next dev" });
      expect(await normalizeNextjsDevCommand("pnpm dev", CWD)).toBe("pnpm dev -- --turbopack");
    });

    it("appends -- --turbopack for pnpm run dev", async () => {
      mockPkg({ dev: "next dev" });
      expect(await normalizeNextjsDevCommand("pnpm run dev", CWD)).toBe(
        "pnpm run dev -- --turbopack"
      );
    });

    it("appends -- --turbopack for yarn dev", async () => {
      mockPkg({ dev: "next dev" });
      expect(await normalizeNextjsDevCommand("yarn dev", CWD)).toBe("yarn dev -- --turbopack");
    });

    it("appends -- --turbopack for yarn run dev", async () => {
      mockPkg({ dev: "next dev" });
      expect(await normalizeNextjsDevCommand("yarn run dev", CWD)).toBe(
        "yarn run dev -- --turbopack"
      );
    });

    it("appends --turbopack (no separator) for bun run dev", async () => {
      mockPkg({ dev: "next dev" });
      expect(await normalizeNextjsDevCommand("bun run dev", CWD)).toBe("bun run dev --turbopack");
    });

    it("appends --turbopack (no separator) for bun dev", async () => {
      mockPkg({ dev: "next dev" });
      expect(await normalizeNextjsDevCommand("bun dev", CWD)).toBe("bun dev --turbopack");
    });

    it("handles scripts with extra args like 'next dev -p 3000'", async () => {
      mockPkg({ dev: "next dev -p 3000" });
      expect(await normalizeNextjsDevCommand("npm run dev", CWD)).toBe(
        "npm run dev -- --turbopack"
      );
    });

    it("does NOT modify when script already has --turbopack", async () => {
      mockPkg({ dev: "next dev --turbopack" });
      expect(await normalizeNextjsDevCommand("npm run dev", CWD)).toBe("npm run dev");
    });

    it("does NOT modify when script is not next dev", async () => {
      mockPkg({ dev: "vite" });
      expect(await normalizeNextjsDevCommand("npm run dev", CWD)).toBe("npm run dev");
    });

    it("does NOT modify when no package.json exists", async () => {
      mockNoPkg();
      expect(await normalizeNextjsDevCommand("npm run dev", CWD)).toBe("npm run dev");
    });

    it("does NOT modify when script name not found in package.json", async () => {
      mockPkg({ start: "next dev" });
      expect(await normalizeNextjsDevCommand("npm run dev", CWD)).toBe("npm run dev");
    });
  });

  describe("non-Next.js commands", () => {
    it("leaves vite commands unchanged", async () => {
      expect(await normalizeNextjsDevCommand("vite", CWD)).toBe("vite");
    });

    it("leaves arbitrary commands unchanged", async () => {
      expect(await normalizeNextjsDevCommand("python manage.py runserver", CWD)).toBe(
        "python manage.py runserver"
      );
    });
  });
});
