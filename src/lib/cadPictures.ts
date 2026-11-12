/**
 * Pictures on Autora 3D surfaces travel once. A picture (up to a few MB, inside the model as a data URL) the server already
 * holds is sent by its key instead of its bytes when the window saves the person's edits, and the server puts it back
 * before it reads the model. Pure: shared by the window (CadWindow.tsx) and the server (server/caddesk.ts).
 */

interface Picture { data: string }
interface Bodyish { surface?: { image?: Picture; reliefImage?: Picture; roughnessImage?: Picture } }
/** A surface's picture slots (Autora 3D's PICTURE_SLOTS): its colour, relief and roughness. */
const SLOTS = ["image", "reliefImage", "roughnessImage"] as const;
interface Docish { bodies?: Bodyish[]; library?: Array<{ bodies?: Bodyish[] }> }

const KEY = /^pic:\d+:[0-9a-z]+:[0-9a-z]+$/;
const known = new Map<string, string>();

/** A picture's key: its length and two hashes of all of it. Remembered, so the same picture is hashed once. */
export function pictureKey(data: string): string {
  const hit = known.get(data);
  if (hit) return hit;
  let a = 0x811c9dc5;
  let b = 5381;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = (Math.imul(b, 33) + c) | 0;
  }
  const key = `pic:${data.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
  known.set(data, key);
  if (known.size > 64) known.delete(known.keys().next().value as string);
  return key;
}

export const isPictureKey = (data: unknown): data is string => typeof data === "string" && KEY.test(data);

/** Every body of a model, the library's too, with a change made to each picture. Bodies without one are kept as they are. */
function mapPictures<T extends Docish>(doc: T, f: (data: string) => string): T {
  const bodies = (list: Bodyish[] | undefined) =>
    list?.map((b) => {
      let surface = b.surface;
      for (const slot of SLOTS) {
        const img = surface?.[slot];
        if (!img || typeof img.data !== "string") continue;
        const data = f(img.data);
        if (data !== img.data) surface = { ...surface, [slot]: { ...img, data } };
      }
      return surface === b.surface ? b : { ...b, surface };
    });
  return {
    ...doc,
    ...(doc.bodies ? { bodies: bodies(doc.bodies) } : {}),
    ...(doc.library ? { library: doc.library.map((i) => (i.bodies ? { ...i, bodies: bodies(i.bodies) } : i)) } : {}),
  };
}

/** The pictures in a model, by key. */
export function picturesOf(doc: Docish | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!doc) return out;
  mapPictures(doc, (data) => {
    if (!isPictureKey(data)) out.set(pictureKey(data), data);
    return data;
  });
  return out;
}

/** The model with every picture `has` holds sent as its key; and the keys of those sent whole. */
export function byReference<T extends Docish>(doc: T, has: ReadonlySet<string>): { doc: T; sent: string[] } {
  const sent: string[] = [];
  const slim = mapPictures(doc, (data) => {
    if (isPictureKey(data)) return data;
    const key = pictureKey(data);
    if (has.has(key)) return key;
    sent.push(key);
    return data;
  });
  return { doc: slim, sent };
}

/** The model with every key put back from `store`; and the keys it did not know (the sender must send those whole). */
export function restorePictures<T extends Docish>(doc: T, store: ReadonlyMap<string, string>): { doc: T; missing: string[] } {
  const missing: string[] = [];
  const full = mapPictures(doc, (data) => {
    if (!isPictureKey(data)) return data;
    const got = store.get(data);
    if (got === undefined) missing.push(data);
    return got ?? data;
  });
  return { doc: full, missing };
}
