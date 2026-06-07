/**
 * Redact an asciinema `.cast` recording in place (or to a new file) so a field
 * capture is safe to commit as a replay fixture. Applies `scrubReportText`
 * (user paths, git remotes, tilde/temp paths, ~40 secret sigils) to the header
 * title and to every event's data payload. Idempotent — running twice yields
 * identical output.
 *
 * Malformed event lines are a hard error, not a skip: a redactor that drops or
 * passes through lines it can't parse either loses fixture content or leaks
 * unredacted output. Fix the cast, then re-run.
 *
 * Usage:
 *   npm run pattern-discovery:redact-cast -- --in capture.cast [--out clean.cast]
 *
 * Without --out the input is rewritten in place after a `.bak` copy is written
 * alongside it (the backup keeps the raw capture local — never commit it).
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { scrubReportText } from "../../shared/utils/reportScrubbers.js";

export function redactCastText(raw: string): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  let headerSeen = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Keep blank lines and `#` comments (the replay harness skips them, and
    // comments are useful for trimming notes) — but scrub comment text too: a
    // note like `# captured on alice's repo` must not escape redaction.
    if (line.length === 0 || line.startsWith("#")) {
      out.push(scrubReportText(line));
      continue;
    }

    if (!headerSeen) {
      headerSeen = true;
      let header: Record<string, unknown>;
      try {
        header = JSON.parse(line) as Record<string, unknown>;
      } catch (error) {
        throw new Error(`Cast header is not valid JSON (line ${i + 1})`, { cause: error });
      }
      // Scrub free-text header fields (title, command, cwd) and string values
      // one level deep in object fields (`env` carries PWD and exported keys),
      // while leaving structural fields (version, width, height) untouched.
      for (const [key, value] of Object.entries(header)) {
        if (typeof value === "string") {
          header[key] = scrubReportText(value);
        } else if (value && typeof value === "object" && !Array.isArray(value)) {
          const nested = value as Record<string, unknown>;
          for (const [innerKey, innerValue] of Object.entries(nested)) {
            if (typeof innerValue === "string") {
              nested[innerKey] = scrubReportText(innerValue);
            }
          }
        }
      }
      out.push(JSON.stringify(header));
      continue;
    }

    let row: unknown;
    try {
      row = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`Malformed event row at line ${i + 1} — fix the cast and re-run`, {
        cause: error,
      });
    }
    if (!Array.isArray(row) || row.length < 3) {
      throw new Error(`Event row must be a 3-tuple at line ${i + 1}`);
    }
    if (typeof row[2] !== "string") {
      // Coercing would both destroy the payload ("[object Object]") and skip
      // any leakage inside it — hard-error like the other malformed shapes.
      throw new Error(`Event data must be a string at line ${i + 1}`);
    }
    // Scrub the data field for every event kind — output ("o"), input ("i"),
    // markers ("m"); resize ("r") payloads are dimension strings the scrub
    // passes through unchanged.
    const scrubbed = [row[0], row[1], scrubReportText(row[2]), ...row.slice(3)];
    out.push(JSON.stringify(scrubbed));
  }

  return out.join("\n");
}

interface CliOptions {
  inPath: string;
  outPath?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.replace(/^--/, "");
    const value = argv[i + 1];
    if (value && !value.startsWith("--")) {
      args.set(key, value);
      i++;
    }
  }

  const inPath = args.get("in");
  if (!inPath) {
    throw new Error("Usage: redact-cast --in <capture.cast> [--out <clean.cast>]");
  }
  return { inPath, outPath: args.get("out") };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const raw = fs.readFileSync(options.inPath, "utf8");
  const redacted = redactCastText(raw);

  if (options.outPath) {
    fs.writeFileSync(options.outPath, redacted, "utf8");
    console.log(`[redact-cast] Wrote ${options.outPath}`);
  } else {
    const bakPath = `${options.inPath}.bak`;
    fs.writeFileSync(bakPath, raw, "utf8");
    fs.writeFileSync(options.inPath, redacted, "utf8");
    console.log(`[redact-cast] Rewrote ${options.inPath} in place (raw backup: ${bakPath})`);
    console.log(`[redact-cast] The .bak file is unredacted — keep it out of git.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
