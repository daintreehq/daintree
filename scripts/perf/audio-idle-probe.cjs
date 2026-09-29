// Idle cost of a silent AudioContext, measured in real Chromium.
//
//   MODE=running IDLE_S=60 npx electron scripts/perf/audio-idle-probe.cjs
//   MODE=suspend IDLE_S=60 npx electron scripts/perf/audio-idle-probe.cjs
//   MODE=none    IDLE_S=60 npx electron scripts/perf/audio-idle-probe.cjs
//
// Plays one short near-silent buffer in a hidden window, then (suspend) calls
// ctx.suspend() or (running) leaves the context as WebAudioService used to.
// Prints per-process idle wakeups/s (app.getAppMetrics) averaged over the idle
// window, CPU seconds spent in it, and, for suspend, resume() latency.
const { app, BrowserWindow } = require("electron");
const MODE = process.env.MODE || "running"; // running | suspend | none
const IDLE_S = Number(process.env.IDLE_S || 60);
const page = `<!doctype html><script>
window.run = async (mode) => {
  if (mode === "none") return { state: "none" };
  const ctx = new AudioContext();
  const buf = ctx.createBuffer(1, ctx.sampleRate * 0.1, ctx.sampleRate);
  const d = buf.getChannelData(0); for (let i=0;i<d.length;i++) d[i] = Math.sin(i/10)*0.0001;
  const s = ctx.createBufferSource(); s.buffer = buf; s.connect(ctx.destination);
  await new Promise(r => { s.onended = r; s.start(0); });
  window.ctx = ctx;
  if (mode === "suspend") await ctx.suspend();
  return { state: ctx.state };
};
window.resumeLatency = async () => { const t = performance.now(); await ctx.resume(); const dt = performance.now() - t; const st = ctx.state; await ctx.suspend(); return { dt, st }; };
</script>`;
function snap() {
  const m = {};
  for (const p of app.getAppMetrics())
    m[p.pid] = {
      type: p.type,
      name: p.name || p.serviceName || "",
      wake: p.cpu.idleWakeupsPerSecond,
      cpu: p.cpu.percentCPUUsage,
      cum: p.cpu.cumulativeCPUUsage,
    };
  return m;
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL("data:text/html," + encodeURIComponent(page));
  const r = await win.webContents.executeJavaScript(`run(${JSON.stringify(MODE)})`);
  await new Promise((r) => setTimeout(r, 5000)); // settle
  snap(); // prime per-interval counters
  const a = snap();
  const samples = [];
  for (let i = 0; i < IDLE_S / 5; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    samples.push(snap());
  }
  const b = samples[samples.length - 1];
  const rows = {};
  for (const pid of Object.keys(b)) {
    // Only intervals the process was alive for; keyed by pid so two processes
    // sharing a type and name cannot overwrite each other.
    const wakes = samples.filter((s) => s[pid]).map((s) => s[pid].wake);
    rows[`${b[pid].type}:${b[pid].name}:${pid}`] = {
      samples: wakes.length,
      avgWakeupsPerSec: +(wakes.reduce((x, y) => x + y, 0) / wakes.length).toFixed(1),
      cpuSeconds: a[pid] ? +(b[pid].cum - a[pid].cum).toFixed(3) : null,
    };
  }
  let lat = null;
  if (MODE === "suspend") {
    lat = [];
    for (let i = 0; i < 5; i++) {
      lat.push(await win.webContents.executeJavaScript("resumeLatency()"));
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log(
    JSON.stringify({ MODE, ctxState: r.state, idleSeconds: IDLE_S, rows, resumeLatency: lat })
  );
  app.quit();
});
