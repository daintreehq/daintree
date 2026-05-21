import { describe, expect, it, vi } from "vitest";
import { extractPort, normalizeNextjsDevCommand } from "../DevPreviewCommandNormalizer.js";

const mockReadFile = vi.fn<(path: string, encoding: string) => Promise<string>>();

vi.mock("node:fs/promises", () => ({
  default: { readFile: (...args: unknown[]) => mockReadFile(...(args as [string, string])) },
  readFile: (...args: unknown[]) => mockReadFile(...(args as [string, string])),
}));

const mockResolveNextMajorVersion = vi.fn<() => Promise<number | null>>();

vi.mock("../../utils/resolveNextVersion.js", () => ({
  resolveNextMajorVersion: (...args: unknown[]) => mockResolveNextMajorVersion(...(args as [])),
}));

import { beforeEach } from "vitest";

beforeEach(() => {
  mockReadFile.mockReset();
  mockResolveNextMajorVersion.mockResolvedValue(15);
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

    it("leaves compound && command unchanged — cannot safely append", async () => {
      expect(await normalizeNextjsDevCommand("next dev && echo done", CWD)).toBe(
        "next dev && echo done"
      );
    });

    it("leaves sequenced ; command unchanged", async () => {
      expect(await normalizeNextjsDevCommand("next dev; echo ready", CWD)).toBe(
        "next dev; echo ready"
      );
    });

    it("leaves commented command unchanged", async () => {
      expect(await normalizeNextjsDevCommand("next dev # default", CWD)).toBe("next dev # default");
    });

    it("leaves piped command unchanged", async () => {
      expect(await normalizeNextjsDevCommand("next dev | tee log", CWD)).toBe("next dev | tee log");
    });

    it("leaves backtick-substituted command unchanged", async () => {
      expect(await normalizeNextjsDevCommand("next dev `whoami`", CWD)).toBe("next dev `whoami`");
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

  describe("version gating", () => {
    it("skips injection when Next.js major is 14", async () => {
      mockResolveNextMajorVersion.mockResolvedValue(14);
      mockPkg({ dev: "next dev" });
      expect(await normalizeNextjsDevCommand("npm run dev", CWD)).toBe("npm run dev");
    });

    it("skips injection when version is null", async () => {
      mockResolveNextMajorVersion.mockResolvedValue(null);
      expect(await normalizeNextjsDevCommand("next dev", CWD)).toBe("next dev");
    });

    it("injects when Next.js major is 15", async () => {
      mockResolveNextMajorVersion.mockResolvedValue(15);
      expect(await normalizeNextjsDevCommand("next dev", CWD)).toBe("next dev --turbopack");
    });

    it("skips injection when turbopackEnabled is false", async () => {
      mockResolveNextMajorVersion.mockResolvedValue(15);
      expect(await normalizeNextjsDevCommand("next dev", CWD, false)).toBe("next dev");
    });
  });

  describe("adversarial: renderer pre-injection for old Next.js versions (Bug 3)", () => {
    // The renderer (findDevServerCandidate) has no version awareness and injects
    // --turbopack for any Next.js project when turbopackEnabled=true. If that
    // pre-injected command reaches normalizeNextjsDevCommand on a v14 project,
    // the main process must strip the flag — not silently pass it through.

    it("strips pre-injected --turbopack from 'next dev --turbopack' when version is 14", async () => {
      mockResolveNextMajorVersion.mockResolvedValue(14);
      expect(await normalizeNextjsDevCommand("next dev --turbopack", CWD)).toBe("next dev");
    });

    it("strips pre-injected -- --turbopack from pkg manager command when version is 14", async () => {
      mockResolveNextMajorVersion.mockResolvedValue(14);
      expect(await normalizeNextjsDevCommand("npm run dev -- --turbopack", CWD)).toBe(
        "npm run dev"
      );
    });

    it("strips pre-injected --turbopack from bun command when version is 14", async () => {
      mockResolveNextMajorVersion.mockResolvedValue(14);
      expect(await normalizeNextjsDevCommand("bun run dev --turbopack", CWD)).toBe("bun run dev");
    });

    it("strips --turbopack when version is null (unknown = safe default)", async () => {
      mockResolveNextMajorVersion.mockResolvedValue(null);
      expect(await normalizeNextjsDevCommand("next dev --turbopack", CWD)).toBe("next dev");
    });

    it("strips --turbopack when turbopackEnabled is false, regardless of version", async () => {
      mockResolveNextMajorVersion.mockResolvedValue(15);
      expect(await normalizeNextjsDevCommand("next dev --turbopack", CWD, false)).toBe("next dev");
    });

    it("strips -- --turbopack when turbopackEnabled is false", async () => {
      mockResolveNextMajorVersion.mockResolvedValue(15);
      expect(await normalizeNextjsDevCommand("npm run dev -- --turbopack", CWD, false)).toBe(
        "npm run dev"
      );
    });
  });
});

describe("extractPort", () => {
  const CWD = "/project";

  it("extracts --port flag with space", async () => {
    expect(await extractPort("next dev --port 3001", CWD)).toBe(3001);
  });

  it("extracts --port flag with equals", async () => {
    expect(await extractPort("next dev --port=3002", CWD)).toBe(3002);
  });

  it("extracts -p flag", async () => {
    expect(await extractPort("vite -p 5174", CWD)).toBe(5174);
  });

  it("extracts PORT= env var", async () => {
    expect(await extractPort("PORT=8080 node server.js", CWD)).toBe(8080);
  });

  it("extracts port from ${PORT:-N} shell variable form", async () => {
    expect(await extractPort('next dev --port "${PORT:-4321}"', CWD)).toBe(4321);
  });

  it("extracts port from single-quoted ${PORT:-N}", async () => {
    expect(await extractPort("next dev --port '${PORT:-3000}'", CWD)).toBe(3000);
  });

  it("returns null for shell control character &&", async () => {
    expect(await extractPort("next dev && echo done", CWD)).toBeNull();
  });

  it("returns null for shell control character ;", async () => {
    expect(await extractPort("next dev; echo ready", CWD)).toBeNull();
  });

  it("returns null for shell comment #", async () => {
    expect(await extractPort("next dev # with port 3000", CWD)).toBeNull();
  });

  it("returns null for pipe |", async () => {
    expect(await extractPort("next dev | tee log", CWD)).toBeNull();
  });

  it("returns Next.js default port 3000", async () => {
    expect(await extractPort("next dev", CWD)).toBe(3000);
  });

  it("returns Vite default port 5173", async () => {
    expect(await extractPort("vite", CWD)).toBe(5173);
  });

  it("returns SvelteKit default port 5173", async () => {
    expect(await extractPort("svelte-kit dev", CWD)).toBe(5173);
  });

  it("returns Astro default port 4321", async () => {
    expect(await extractPort("astro dev", CWD)).toBe(4321);
  });

  it("returns Rails default port 3000", async () => {
    expect(await extractPort("rails server", CWD)).toBe(3000);
  });

  it("returns Django default port 8000", async () => {
    expect(await extractPort("python manage.py runserver", CWD)).toBe(8000);
  });

  it("returns Phoenix default port 4000", async () => {
    expect(await extractPort("mix phx.server", CWD)).toBe(4000);
  });

  it("returns Laravel default port 8000", async () => {
    expect(await extractPort("php artisan serve", CWD)).toBe(8000);
  });

  it("resolves pkg manager command through package.json for port extraction", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ scripts: { dev: "next dev -p 3001" } }));
    expect(await extractPort("npm run dev", CWD)).toBe(3001);
  });

  it("bails out when resolved pkg script has shell control", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ scripts: { dev: "next dev && echo done" } }));
    expect(await extractPort("npm run dev", CWD)).toBeNull();
  });

  it("returns framework default when pkg script has no explicit port", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ scripts: { dev: "astro dev" } }));
    expect(await extractPort("npm run dev", CWD)).toBe(4321);
  });

  it("returns null when no match and no framework default", async () => {
    expect(await extractPort("echo hello", CWD)).toBeNull();
  });

  it("returns null when no package.json exists for pkg manager command", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    expect(await extractPort("npm run dev", CWD)).toBeNull();
  });

  it("returns null for port 0 (invalid)", async () => {
    expect(await extractPort("next dev --port 0", CWD)).toBeNull();
  });

  it("returns null for port 65536 (invalid)", async () => {
    expect(await extractPort("next dev --port 65536", CWD)).toBeNull();
  });

  it("returns Remix default port 3000", async () => {
    expect(await extractPort("remix dev", CWD)).toBe(3000);
  });

  it("returns null when Remix command is not a dev invocation", async () => {
    expect(await extractPort("remix routes", CWD)).toBeNull();
  });

  it("returns null for SUPPORT=8080 (PORT= substring in longer env var)", async () => {
    expect(await extractPort("SUPPORT=8080 node server.js", CWD)).toBeNull();
  });

  it("returns null for --port 3000abc (partial digit extraction)", async () => {
    expect(await extractPort("next dev --port 3000abc", CWD)).toBeNull();
  });

  it("returns null for --port 3000.5 (partial float extraction)", async () => {
    expect(await extractPort("next dev --port 3000.5", CWD)).toBeNull();
  });

  it("returns null for --port with non-numeric value", async () => {
    expect(await extractPort("next dev --port abc", CWD)).toBeNull();
  });
});
