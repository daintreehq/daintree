import { describe, expect, it } from "vitest";
import { scrubSecrets } from "../../../../shared/utils/secretScrubber.js";
import { CloneOutputLog } from "../cloneOutputLog.js";

describe("CloneOutputLog", () => {
  it("redraws git's carriage-return progress line in place", () => {
    const log = new CloneOutputLog();
    log.append("Cloning into 'repo'...\n");
    log.append("Receiving objects:  10% (1/10)\r");
    log.append("Receiving objects:  50% (5/10)\r");
    log.append("Receiving objects: 100% (10/10), done.\n");
    expect(log.snapshot()).toEqual([
      "Cloning into 'repo'...",
      "Receiving objects: 100% (10/10), done.",
    ]);
  });

  it("joins a CRLF split across chunks into one line break", () => {
    const log = new CloneOutputLog();
    log.append("remote: Counting objects: 3\r");
    log.append("\nremote: Total 3\n");
    expect(log.snapshot()).toEqual(["remote: Counting objects: 3", "remote: Total 3"]);
  });

  it("shows the line still being drawn", () => {
    const log = new CloneOutputLog();
    log.append("Resolving deltas:  42% (42/100)\r");
    expect(log.snapshot()).toEqual(["Resolving deltas:  42% (42/100)"]);
  });

  it("scrubs credentials from every line it keeps", () => {
    const log = new CloneOutputLog();
    log.append(
      "fatal: unable to access 'https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r.git/'\n"
    );
    const [line] = log.snapshot();
    expect(line).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(line).toContain("github.com/o/r.git");
  });

  it("keeps only the most recent lines", () => {
    const log = new CloneOutputLog();
    for (let i = 0; i < 250; i++) log.append(`line ${i}\n`);
    const lines = log.snapshot();
    expect(lines.length).toBeLessThan(250);
    expect(lines[lines.length - 1]).toBe("line 249");
    expect(lines).not.toContain("line 0");
  });

  it("starts a new line for a provider's stage and redraws within it", () => {
    const log = new CloneOutputLog();
    log.appendLine("Receiving objects: 10%");
    log.redrawLine("Receiving objects: 60%");
    log.appendLine("Resolving deltas: 5%");
    expect(log.snapshot()).toEqual(["Receiving objects: 60%", "Resolving deltas: 5%"]);
  });
});

describe("CloneOutputLog credentials across boundaries", () => {
  const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

  it("never shows a URL's credentials while the line is still arriving", () => {
    const log = new CloneOutputLog();
    log.append(`fatal: unable to access 'https://x-access-token:${TOKEN.slice(0, 20)}`);
    expect(log.snapshot().join("\n")).not.toContain(TOKEN.slice(0, 20));

    log.append(`${TOKEN.slice(20)}@github.com/o/r.git/'\n`);
    const shown = log.snapshot().join("\n");
    expect(shown).not.toContain(TOKEN);
    expect(shown).toContain("github.com/o/r.git");
  });

  it("scrubs a long line before cutting it to length", () => {
    const log = new CloneOutputLog();
    const padding = "x".repeat(380);
    const raw = `${padding} https://user:${TOKEN}@example.com/repo.git`;
    log.append(`${raw}\n`);
    const [line] = log.snapshot();
    const scrubbed = scrubSecrets(raw);
    expect(line).toBe(scrubbed.length > 400 ? `${scrubbed.slice(0, 399)}…` : scrubbed);
    expect(line).not.toContain("ghp_");
  });

  it("shows nothing of a credential the raw line limit cut through", () => {
    const log = new CloneOutputLog();
    log.append(`remote: https://user:${"A".repeat(20_000)}`);
    log.append(`PRIVATE-SUFFIX@example.com/repo.git\nnext line\n`);
    const shown = log.snapshot();
    expect(shown.join("\n")).not.toContain("PRIVATE-SUFFIX");
    expect(shown.join("\n")).not.toContain("AAAA");
    expect(shown).toEqual(["remote: https://[redacted]", "next line"]);
  });
});
