/**
 * Keep whole images out of the prose, without giving up streaming.
 *
 * A model asked for a picture sometimes answers with one: a `data:` URL,
 * inline, in the middle of a sentence. Left alone that is two hundred
 * kilobytes of base64 across the conversation -- in the thread, in the event
 * log, and replayed to every tab that reconnects for the rest of the session.
 *
 * It cannot be cleaned up afterwards, because by then it has already been
 * streamed. So it is caught on the way past: text flows through untouched
 * until a `data:image/` appears, everything from there is held back until the
 * address ends, and what comes out the other side is the image itself, lifted
 * into a card of its own where it was written. The sentence closes over the
 * gap and the picture appears in it.
 *
 * The holdback is the length of the marker, so a `data:image/` split across
 * two deltas -- which is the normal case, not the edge one -- is still seen.
 */
const MARKER = "data:image/";
/** What ends a URL in prose. Base64 uses none of these. */
const URL_END = /[\s<>"'`)\]}\\]/;

export class DataUrlSieve {
  private buffer = "";
  private inside = false;

  /** Text safe to say, and any whole images found in what was held back. */
  feed(piece: string): { text: string; images: string[] } {
    this.buffer += piece;
    return this.drain(false);
  }

  /** The stream is over: whatever is still held back is decided now. */
  flush(): { text: string; images: string[] } {
    return this.drain(true);
  }

  private drain(final: boolean): { text: string; images: string[] } {
    let text = "";
    const images: string[] = [];

    for (;;) {
      if (this.inside) {
        const end = URL_END.exec(this.buffer);
        if (!end) {
          if (!final) return { text, images };
          images.push(this.buffer);
          this.buffer = "";
          this.inside = false;
          return { text, images };
        }
        images.push(this.buffer.slice(0, end.index));
        this.buffer = this.buffer.slice(end.index);
        this.inside = false;
        continue;
      }

      const at = this.buffer.indexOf(MARKER);
      if (at >= 0) {
        text += this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at);
        this.inside = true;
        continue;
      }

      if (final) {
        text += this.buffer;
        this.buffer = "";
        return { text, images };
      }
      // Hold back just enough that a marker split across two deltas is still
      // recognised when the rest of it lands.
      const keep = Math.min(this.buffer.length, MARKER.length - 1);
      text += this.buffer.slice(0, this.buffer.length - keep);
      this.buffer = this.buffer.slice(this.buffer.length - keep);
      return { text, images };
    }
  }
}
