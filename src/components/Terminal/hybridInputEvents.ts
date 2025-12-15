export function isEnterLikeLineBreakInputEvent(event: InputEvent): boolean {
  if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") return true;

  if (event.inputType === "insertText") {
    const data = event.data ?? "";
    return data.includes("\n") || data.includes("\r");
  }

  return false;
}
