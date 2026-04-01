import { describe, expect, it } from "vitest";
import { findDevServerCandidate } from "../devServerDetection";
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
});
