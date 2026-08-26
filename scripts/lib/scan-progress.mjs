// The scan takes ~20 seconds over ~1,500 files. Without this the commands sit
// silent for that long and read as hung.
//
// Non-TTY (CI, piped output) gets one line rather than a carriage-return
// animation, which would otherwise fill a log with thousands of partial lines.
export function createProgressReporter(label) {
  if (!process.stderr.isTTY) {
    process.stderr.write(`${label}\n`);
    return undefined;
  }
  let last = 0;
  return (done, total) => {
    const now = Date.now();
    if (done !== total && now - last < 250) return;
    last = now;
    process.stderr.write(`\r${label} ${done}/${total}`);
    if (done === total) process.stderr.write("\n");
  };
}
