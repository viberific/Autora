/**
 * Unzipping something that came from outside, without trusting its own claim
 * about how big it is.
 *
 * A zip is a few kilobytes that can say "this entry is four gigabytes of
 * zeros". `unzipSync` believes it and inflates every entry it is not told to
 * skip, and the container has three gigabytes in all -- an uploaded document,
 * a skill or an extension was enough to have the whole app killed. The sizes
 * are read from the archive's index before anything is inflated, and the call
 * throws when they add up to more than `max`.
 */
import { unzipSync, type UnzipFileFilter } from "fflate";

/** More than any real document, skill or extension unpacks to, far below what a bomb claims. */
const UNZIP_MAX = 300 * 1024 * 1024;

export function unzipCapped(
  bytes: Uint8Array,
  opts: { max?: number; only?: (name: string) => boolean } = {},
): Record<string, Uint8Array> {
  const max = opts.max ?? UNZIP_MAX;
  let claimed = 0;
  const filter: UnzipFileFilter = (file) => {
    if (opts.only && !opts.only(file.name)) return false;
    claimed += file.originalSize;
    if (claimed > max) throw new Error("That archive is too large once unpacked.");
    return true;
  };
  return unzipSync(bytes, { filter });
}
