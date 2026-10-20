import fs from "node:fs/promises";
import { BULK_CHUNK_BYTES } from "../link/frames.js";

type Handle = Awaited<ReturnType<typeof fs.open>>;

/** Creates a name that must not exist yet, never through a symlink. */
export const NEW_FILE_FLAGS =
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;

/** Copies the whole of `source` into `target` and syncs it; returns the bytes copied. */
export async function copyInto(source: Handle, target: Handle): Promise<number> {
  const buf = Buffer.allocUnsafe(BULK_CHUNK_BYTES);
  let position = 0;
  for (;;) {
    const { bytesRead } = await source.read(buf, 0, buf.byteLength, position);
    if (bytesRead === 0) break;
    for (let offset = 0; offset < bytesRead;) {
      const { bytesWritten } = await target.write(
        buf,
        offset,
        bytesRead - offset,
        position + offset
      );
      if (bytesWritten <= 0) throw new Error("The file could not be written");
      offset += bytesWritten;
    }
    position += bytesRead;
  }
  await target.sync();
  return position;
}
