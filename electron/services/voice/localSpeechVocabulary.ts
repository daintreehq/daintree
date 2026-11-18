/**
 * The on-device speech model's SentencePiece vocabulary (`vocab.txt`, one
 * piece per line, `▁` starting a word). On Auto-detect the model writes a
 * locale tag such as `<en-US>` after an utterance's closing punctuation; tags,
 * `<unk>` and the blank are never text.
 */

const WORD_MARKER = "▁";
const LOCALE_TAG = /^<[a-z]{2,3}-[A-Z]{2,3}>$/;

export class LocalSpeechVocabulary {
  private readonly text: string[];
  private readonly tag: boolean[];

  private constructor(pieces: string[]) {
    this.text = pieces.map((piece) =>
      LOCALE_TAG.test(piece) || piece === "<unk>" || piece === "<blank>"
        ? ""
        : piece.replaceAll(WORD_MARKER, " ")
    );
    this.tag = pieces.map((piece) => LOCALE_TAG.test(piece));
  }

  static parse(contents: string, expectedSize?: number): LocalSpeechVocabulary {
    const pieces = contents.split(/\r?\n/);
    if (pieces.length > 0 && pieces[pieces.length - 1] === "") pieces.pop();
    if (expectedSize !== undefined && pieces.length !== expectedSize) {
      throw new Error(`The vocabulary has ${pieces.length} entries, expected ${expectedSize}`);
    }
    return new LocalSpeechVocabulary(pieces);
  }

  get size(): number {
    return this.text.length;
  }

  /** A locale tag: the model's mark that an utterance ended, on Auto-detect. */
  isTag(id: number): boolean {
    return this.tag[id] === true;
  }

  /** The text of `ids` joined, word markers as spaces, tags and specials dropped. */
  decode(ids: readonly number[]): string {
    let out = "";
    for (const id of ids) out += this.text[id] ?? "";
    return out;
  }
}
