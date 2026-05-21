import { describe, expect, it } from "vitest";
import { findDevServerCandidate, findAllDevServerCandidates } from "../devServerDetection";
import type { RunCommand } from "@shared/types";

function runner(name: string, command: string, description?: string): RunCommand {
  return { id: `npm-${name}`, name, command, icon: "npm", description };
}

describe("findDevServerCandidate", () => {
  it("returns undefined for empty/undefined input", () => {
    expect(findDevServerCandidate(undefined)).toBeUndefined();
    expect(findDevServerCandidate([])).toBeUndefined();
  });

  it("picks 'dev' over 'start' and 'serve'", () => {
    const runners = [
      runner("serve", "npm run serve", "vite preview"),
      runner("start", "npm run start", "node server.js"),
      runner("dev", "npm run dev", "vite"),
    ];
    expect(findDevServerCandidate(runners)?.name).toBe("dev");
  });

  it("falls back to 'start' when no 'dev'", () => {
    const runners = [runner("start", "npm run start", "node server.js")];
    expect(findDevServerCandidate(runners)?.name).toBe("start");
  });

  describe("Next.js turbopack enhancement", () => {
    it("appends -- --turbopack when script is 'next dev'", () => {
      const runners = [runner("dev", "npm run dev", "next dev")];
      const candidate = findDevServerCandidate(runners);
      expect(candidate?.command).toBe("npm run dev -- --turbopack");
    });

    it("appends -- --turbopack when script is 'next dev -p 3000'", () => {
      const runners = [runner("dev", "pnpm dev", "next dev -p 3000")];
      const candidate = findDevServerCandidate(runners);
      expect(candidate?.command).toBe("pnpm dev -- --turbopack");
    });

    it("does NOT append when script already has --turbopack", () => {
      const runners = [runner("dev", "npm run dev", "next dev --turbopack")];
      const candidate = findDevServerCandidate(runners);
      expect(candidate?.command).toBe("npm run dev");
    });

    it("does NOT append when script already has --turbo", () => {
      const runners = [runner("dev", "npm run dev", "next dev --turbo")];
      const candidate = findDevServerCandidate(runners);
      expect(candidate?.command).toBe("npm run dev");
    });

    it("appends --turbopack (no separator) for bun run dev", () => {
      const runners = [runner("dev", "bun run dev", "next dev")];
      const candidate = findDevServerCandidate(runners);
      expect(candidate?.command).toBe("bun run dev --turbopack");
    });

    it("appends --turbopack (no separator) for bun dev", () => {
      const runners = [runner("dev", "bun dev", "next dev")];
      const candidate = findDevServerCandidate(runners);
      expect(candidate?.command).toBe("bun dev --turbopack");
    });

    it("does NOT modify non-Next.js scripts", () => {
      const runners = [runner("dev", "npm run dev", "vite")];
      const candidate = findDevServerCandidate(runners);
      expect(candidate?.command).toBe("npm run dev");
    });

    it("does NOT modify when description is missing", () => {
      const runners = [runner("dev", "npm run dev")];
      const candidate = findDevServerCandidate(runners);
      expect(candidate?.command).toBe("npm run dev");
    });
  });

  describe("turbopackEnabled toggle gating", () => {
    it("injects by default (turbopackEnabled defaults to true)", () => {
      const runners = [runner("dev", "npm run dev", "next dev")];
      expect(findDevServerCandidate(runners)?.command).toBe("npm run dev -- --turbopack");
    });

    it("does NOT inject when turbopackEnabled is false", () => {
      const runners = [runner("dev", "npm run dev", "next dev")];
      expect(findDevServerCandidate(runners, false)?.command).toBe("npm run dev");
    });

    it("does NOT inject when turbopackEnabled is false for bun runner", () => {
      const runners = [runner("dev", "bun run dev", "next dev")];
      expect(findDevServerCandidate(runners, false)?.command).toBe("bun run dev");
    });
  });

  describe("compound/shell commands", () => {
    it("does NOT inject for scripts with &&", () => {
      const runners = [runner("dev", "npm run dev", "next dev && echo done")];
      expect(findDevServerCandidate(runners)?.command).toBe("npm run dev");
    });

    it("does NOT inject for scripts with ;", () => {
      const runners = [runner("dev", "npm run dev", "next dev; echo ready")];
      expect(findDevServerCandidate(runners)?.command).toBe("npm run dev");
    });

    it("does NOT inject for scripts with #", () => {
      const runners = [runner("dev", "npm run dev", "next dev # note")];
      expect(findDevServerCandidate(runners)?.command).toBe("npm run dev");
    });

    it("does NOT inject for scripts with |", () => {
      const runners = [runner("dev", "npm run dev", "next dev | tee log")];
      expect(findDevServerCandidate(runners)?.command).toBe("npm run dev");
    });
  });
});

describe("findAllDevServerCandidates", () => {
  it("returns empty array for undefined/empty input", () => {
    expect(findAllDevServerCandidates(undefined)).toEqual([]);
    expect(findAllDevServerCandidates([])).toEqual([]);
  });

  it("returns all priority matches in order", () => {
    const runners = [
      runner("serve", "npm run serve", "vite preview"),
      runner("start", "npm run start", "node server.js"),
      runner("dev", "npm run dev", "vite"),
    ];
    const result = findAllDevServerCandidates(runners);
    expect(result.map((r) => r.name)).toEqual(["dev", "start", "serve"]);
  });

  it("includes non-priority runners after priority matches", () => {
    const runners = [
      runner("build", "npm run build"),
      runner("dev", "npm run dev", "vite"),
      runner("lint", "npm run lint"),
      runner("start", "npm run start"),
    ];
    const result = findAllDevServerCandidates(runners);
    expect(result.map((r) => r.name)).toEqual(["dev", "start", "build", "lint"]);
  });

  it("deduplicates runners by id", () => {
    const devRunner = runner("dev", "npm run dev");
    const runners = [devRunner, devRunner];
    const result = findAllDevServerCandidates(runners);
    expect(result).toHaveLength(1);
  });

  it("promotes devcontainer-poststart to first when no priority match", () => {
    const runners = [
      runner("build", "npm run build"),
      { id: "devcontainer-poststart", name: "postStart", command: "npm start", icon: "docker" },
    ];
    const result = findAllDevServerCandidates(runners);
    expect(result.map((r) => r.id)).toEqual(["devcontainer-poststart", "npm-build"]);
  });

  it("keeps devcontainer-poststart as a regular runner when priority matches exist", () => {
    const runners = [
      runner("dev", "npm run dev", "vite"),
      { id: "devcontainer-poststart", name: "postStart", command: "npm start", icon: "docker" },
    ];
    const result = findAllDevServerCandidates(runners);
    expect(result.map((r) => r.id)).toEqual(["npm-dev", "devcontainer-poststart"]);
  });

  it("applies turbopack to each Next.js candidate", () => {
    const runners = [
      runner("dev", "npm run dev", "next dev"),
      runner("start", "npm run start", "next start"),
    ];
    const result = findAllDevServerCandidates(runners);
    expect(result[0]?.command).toBe("npm run dev -- --turbopack");
    expect(result[1]?.command).toBe("npm run start");
  });

  it("findDevServerCandidate delegates to findAllDevServerCandidates", () => {
    const runners = [runner("serve", "npm run serve"), runner("dev", "npm run dev", "vite")];
    expect(findDevServerCandidate(runners)?.name).toBe("dev");
  });
});
