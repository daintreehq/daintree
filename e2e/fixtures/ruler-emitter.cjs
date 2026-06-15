// Width-keyed "ruler" emitter — a deterministic stand-in for a CLI agent that
// continuously redraws full-width content, used by the project-switch garble
// E2E (core-project-switch-redraw.spec.ts).
//
// Every interval AND on every SIGWINCH it prints a single line EXACTLY
// `process.stdout.columns` characters wide:
//
//   RULER:<cols>:###...###Z
//
// `<cols>` is the PTY's OWN view of its width (the tty ioctl size), so the
// rendered buffer carries the PTY's ground-truth width independently of xterm.
// The line is built to be exactly `<cols>` glyphs and end in `Z`, so the test
// can verify the grid wraps it at precisely the right column: if xterm's grid
// drifts from the PTY width after a project switch, this line wraps wrong (the
// visible "garbled line flow"), and the printed `<cols>` no longer matches the
// grid the test reads back.
function emit() {
  const cols = process.stdout.columns || 0;
  if (cols < 12) {
    process.stdout.write("RULER:" + cols + ":NARROW\r\n");
    return;
  }
  const tag = "RULER:" + cols + ":";
  const fill = "#".repeat(Math.max(0, cols - tag.length - 1));
  process.stdout.write(tag + fill + "Z\r\n");
}

process.stdout.on("resize", emit);
setInterval(emit, 300);
emit();
