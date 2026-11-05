import { clipboard, ClipboardItem, nativeImage, type NativeImage } from "electron";

export async function readClipboardImage(): Promise<NativeImage> {
  const items = await clipboard.read();
  for (const item of items) {
    const type = item.types.find((candidate) => candidate.startsWith("image/"));
    if (!type) continue;
    const data = await item.getType(type);
    if (!(data instanceof Blob)) continue;
    const image = nativeImage.createFromBuffer(Buffer.from(await data.arrayBuffer()));
    if (!image.isEmpty()) return image;
  }
  return nativeImage.createEmpty();
}

export async function writeClipboardImage(image: NativeImage): Promise<void> {
  const png = new Uint8Array(image.toPNG());
  await clipboard.write([
    new ClipboardItem({ "image/png": new Blob([png], { type: "image/png" }) }),
  ]);
}

export async function writeClipboardFileFormat(
  format: "NSFilenamesPboardType" | "text/uri-list",
  data: Buffer
): Promise<void> {
  const type =
    format === "NSFilenamesPboardType"
      ? 'electron application/osclipboard;format="NSFilenamesPboardType"'
      : format;
  await clipboard.write([new ClipboardItem({ [type]: new Blob([new Uint8Array(data)]) })]);
}
