#!/usr/bin/env node
// Hermetic agent-shaped workload. Runs through a real PTY, with no network or model.
if (process.argv.includes("--version")) {
  console.log("claude code v9.9.9");
  process.exit(0);
}
const mode = process.env.FOREGROUND_MODE;
const out = process.stdout;
const esc = "\x1b[";
let tick = 0;
let typed = "";
let drawnRows = 4;
process.stdin.setRawMode(true);
process.stdin.resume();
out.write(esc + "?25l");
for (let i = 0; i < 2000; i++) {
  out.write(
    `\x1b[38;5;${110 + (i % 8)}m${String(i).padStart(4, "0")}  Inspecting source: const result = await buildProject(input); // foreground fixture\x1b[0m\r\n`
  );
}
out.write("FOREGROUND_READY\r\n\r\n\r\n\r\n");
function draw() {
  const spinner = ["|", "/", "-", "\\"][tick % 4];
  out.write(
    esc +
      `${drawnRows}A` +
      "\r" +
      esc +
      "0J" +
      `\x1b[36m${mode === "redundant" ? "-" : spinner} Working on a basic task\x1b[0m\r\n` +
      "FOREGROUND_READY Reading source and preparing a small change.\r\n" +
      `INPUT:${typed}\r\n` +
      "Ask the agent anything > "
  );
  out.write("\r\n");
  drawnRows = 3 + Math.ceil(("INPUT:".length + typed.length) / (out.columns || 80));
}
draw();
const working = mode !== "idle" && mode !== "typing";
const heartbeat = working ? setInterval(() => out.write("\x1b]9;4;1;0\x07"), 1000) : null;
out.write("\x1b]9;4;1;0\x07");
if (!working) setTimeout(() => out.write("\x1b]9;4;0;0\x07"), 2000);
const timer =
  mode === "idle" || mode === "typing"
    ? null
    : setInterval(
        () => {
          tick++;
          if (mode === "stream") {
            out.write(
              `\r${esc}0KOUTPUT:${tick} A small, deterministic response chunk with syntax and ordinary terminal text.\r\n`
            );
          } else {
            draw();
          }
        },
        mode === "stream" ? 50 : 100
      );
process.stdin.on("data", (data) => {
  for (const ch of data.toString()) {
    if (ch === "\x04") {
      if (timer) clearInterval(timer);
      if (heartbeat) clearInterval(heartbeat);
      out.write(`\r\nFOREGROUND_DONE:${tick}:${typed}\r\n${esc}?25h`);
      out.write("\x1b]9;4;0;0\x07");
    }
    if (/^[a-z]$/.test(ch)) {
      typed += ch;
      draw();
    }
  }
});
