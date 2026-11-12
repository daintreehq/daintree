import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { load } from "js-yaml";

// The bot that proposes catalog entries runs unattended on a schedule (#16780).
// What keeps it safe is structural: only its own step sees the token that can
// open pull requests, the workflow token can't write, it runs only on develop
// in this repository, and nothing in it merges or approves.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = ".github/workflows/propose-plugin-catalog-updates.yml";
const text = readFileSync(path.join(repoRoot, workflowPath), "utf8");
const workflow = load(text);
const jobs = Object.values(workflow.jobs);
const steps = jobs.flatMap((job) => job.steps);
const BOT_SECRET = "secrets.PLUGIN_CATALOG_BOT_TOKEN";

describe(workflowPath, () => {
  it("runs on a schedule and by hand, never on a pull request or push", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(workflow.on.schedule.length).toBeGreaterThan(0);
  });

  it("gives the workflow token no write access", () => {
    const grants = [workflow.permissions, ...jobs.map((job) => job.permissions)].filter(Boolean);
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      expect(grant).not.toBe("write-all");
      expect(Object.values(grant)).not.toContain("write");
    }
  });

  it("runs only on develop in this repository, and checks out develop without credentials", () => {
    for (const job of jobs) {
      expect(job.if).toContain("github.repository == 'daintreehq/daintree'");
      expect(job.if).toContain("github.ref == 'refs/heads/develop'");
    }
    const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0].with.ref).toBe("develop");
    expect(checkouts[0].with["persist-credentials"]).toBe(false);
  });

  it("hands the bot token to the one step that runs the script, and to nothing else", () => {
    const withSecret = steps.filter((step) => JSON.stringify(step).includes(BOT_SECRET));
    expect(withSecret).toHaveLength(1);
    const [propose] = withSecret;
    expect(propose.env.PLUGIN_CATALOG_BOT_TOKEN).toBe(`\${{ ${BOT_SECRET} }}`);
    expect(text.split(BOT_SECRET)).toHaveLength(2);

    // The token, not a flag, decides whether it opens anything.
    const script = /npx tsx (\S+)/.exec(propose.run)?.[1];
    expect(script && existsSync(path.join(repoRoot, script))).toBe(true);
    expect(propose.run).not.toContain("--dry-run");
  });

  it("never merges or approves a pull request", () => {
    for (const step of steps) {
      expect(step.run ?? "").not.toMatch(/\bmerge\b|--approve|\bapprove\b|--auto\b/);
    }
  });
});
