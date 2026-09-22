/**
 * In-process recorder: subscribes to the active project view's compositor
 * frames in the main process and pipes BGRA bitmaps into ffmpeg at a constant
 * 30 fps (the latest frame is repeated when nothing repainted). No OS screen
 * recording permission is involved.
 *
 * The recording clock starts when the first frame is written, and startRecording
 * resolves with that wall-clock epoch so beats can be scheduled against it.
 */

import type { ElectronApplication } from "@playwright/test";

export interface RecordingStats {
  written: number;
  paints: number;
  lagFrames: number;
  maxToBitmapMs: number;
  switches: number;
  stalls: number;
}

export async function startRecording(
  app: ElectronApplication,
  outFile: string,
  opts: { fps?: number; bitrate?: string } = {}
): Promise<{ t0: number; width: number; height: number }> {
  return app.evaluate(
    async ({ BrowserWindow }, { outFile, fps, bitrate }) => {
      const cp = (process as any).getBuiltinModule("child_process");
      const g = globalThis as any;
      if (g.__rec) throw new Error("recording already active");
      const win = BrowserWindow.getAllWindows()[0]!;

      const activeView = () => {
        const views = (win.contentView.children as any[]).filter(
          (v) => v.webContents && !v.webContents.isDestroyed() && v.getVisible?.() !== false
        );
        return views.sort((a, b) => b.getBounds().width - a.getBounds().width)[0];
      };

      const st: any = {
        latest: null,
        paints: 0,
        written: 0,
        lagFrames: 0,
        maxToBitmapMs: 0,
        switches: 0,
        wc: null,
      };
      g.__rec = st;

      const subscribe = () => {
        const view = activeView();
        const wc = view?.webContents;
        if (!wc || wc === st.wc) return;
        try {
          st.wc?.endFrameSubscription();
        } catch {
          /* view already gone */
        }
        st.wc = wc;
        st.switches++;
        wc.setBackgroundThrottling(false);
        wc.beginFrameSubscription(false, (image: any) => {
          if (st.wc !== wc) return;
          st.latest = image;
          st.paints++;
        });
        wc.invalidate();
      };
      subscribe();
      // Project switches swap the visible WebContentsView; follow it.
      st.follow = setInterval(subscribe, 100);

      const deadline = Date.now() + 5000;
      while (!st.latest && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      if (!st.latest) throw new Error("no frames from the active view");
      const size = st.latest.getSize();
      const width = size.width - (size.width % 2);
      const height = Math.round(st.latest.toBitmap().length / 4 / size.width);

      const ff = cp.spawn(
        process.env.DAINTREE_FFMPEG ?? "ffmpeg",
        [
          "-y",
          "-loglevel",
          "warning",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "bgra",
          "-s",
          `${size.width}x${height}`,
          "-framerate",
          String(fps),
          "-i",
          "-",
          "-c:v",
          "hevc_videotoolbox",
          "-b:v",
          bitrate,
          "-tag:v",
          "hvc1",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          outFile,
        ],
        { stdio: ["pipe", "ignore", "inherit"] }
      );
      st.ff = ff;
      ff.stdin.on("error", () => {
        st.stopped = true;
      });
      ff.on("exit", (code: number | null, signal: string | null) => {
        if (!st.stopping)
          console.error(`[recorder] ffmpeg exited early code=${code} signal=${signal}`);
        st.stopped = true;
      });
      st.expected = `${size.width}x${height}`;

      const t0 = Date.now();
      st.t0 = t0;
      let busy = false;
      let busySince = 0;
      st.stalls = 0;
      st.tick = setInterval(() => {
        // A write the encoder never acknowledges would otherwise park the loop for the rest of
        // the take (scene E once kept 292 of 1,120 frames). Log it and carry on.
        if (busy && Date.now() - busySince > 3000) {
          st.stalls++;
          console.error(
            `[recorder] write stalled ${Date.now() - busySince}ms (buffered ${ff.stdin.writableLength} bytes); resuming`
          );
          busy = false;
        }
        if (st.stopped || busy || !st.latest || ff.stdin.writableEnded) return;
        const due = Math.floor(((Date.now() - t0) / 1000) * fps) + 1;
        if (st.written >= due) return;
        const img = st.latest;
        const s = img.getSize();
        if (`${s.width}x${Math.round(s.height)}` !== st.expected) return;
        busy = true;
        busySince = Date.now();
        const a = Date.now();
        const buf = img.toBitmap();
        st.maxToBitmapMs = Math.max(st.maxToBitmapMs, Date.now() - a);
        const n = due - st.written;
        st.lagFrames += n - 1;
        let pending = n;
        for (let i = 0; i < n; i++) {
          if (st.stopped || ff.stdin.writableEnded) {
            busy = false;
            break;
          }
          st.written++;
          ff.stdin.write(buf, () => {
            if (--pending === 0) busy = false;
          });
        }
      }, 4);
      return { t0, width, height };
    },
    { outFile, fps: opts.fps ?? 30, bitrate: opts.bitrate ?? "80M" }
  );
}

export async function stopRecording(app: ElectronApplication): Promise<RecordingStats> {
  return app.evaluate(async () => {
    const g = globalThis as any;
    const st = g.__rec;
    if (!st) throw new Error("no active recording");
    st.stopping = true;
    st.stopped = true;
    clearInterval(st.tick);
    clearInterval(st.follow);
    try {
      st.wc?.endFrameSubscription();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      if (st.ff.exitCode !== null) return resolve();
      st.ff.on("close", () => resolve());
      if (!st.ff.stdin.writableEnded) st.ff.stdin.end();
    });
    g.__rec = null;
    return {
      written: st.written,
      paints: st.paints,
      lagFrames: st.lagFrames,
      maxToBitmapMs: st.maxToBitmapMs,
      switches: st.switches,
      stalls: st.stalls ?? 0,
    };
  });
}
