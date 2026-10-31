import { normalizeCanvas, type Canvas } from "./canvas";

/** HTTP success is not a canvas: validate the native document independently of engine metadata. */
export async function readCanvasResponse(response: Pick<Response, "ok" | "status" | "json">): Promise<{ doc: Canvas; rev: number }> {
  let body: unknown;
  try { body = await response.json(); }
  catch {
    throw new Error(response.ok ? "The workspace returned invalid JSON, not a native canvas document."
      : `The workspace request failed (HTTP ${response.status}).`);
  }
  const envelope = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown> : null;
  if (!response.ok) throw new Error(typeof envelope?.error === "string" ? envelope.error : `The workspace request failed (HTTP ${response.status}).`);
  const doc = normalizeCanvas(envelope?.doc);
  if (!doc) throw new Error("The workspace response does not contain a valid native canvas document (panels and surfaces arrays are required).");
  const rev = envelope?.rev;
  if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 0) throw new Error("The workspace response has an invalid canvas revision.");
  return { doc, rev };
}
