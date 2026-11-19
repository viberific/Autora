# New Web Browser Architecture

Problem:
The live browser is slow to use. Chromium runs on the server (`LiveBrowser`, `server/browser.ts`) and the person sees it
as a stream of JPEG pictures: `Page.startScreencast` (`format: "jpeg"`, quality `AUTORA_BROWSER_QUALITY` = 72, dropping
through `TIERS` under load) → `hooks.onFrame` → `sendEphemeral(... { type: "frame", source: "browser" })` in `server.ts` →
drawn as one `<img>` after another (`src/components/Frame.tsx`, `ScreencastCell.tsx`, `BrowserPanel.tsx`). On an Umbrel box
Chromium renders in software and encodes every frame, so scrolling, hovering and typing feel like a slideshow with input lag.

Two alternatives were weighed and set aside:
- **A proxied page rendered in the person's browser** (a rewriting service-worker proxy such as Scramjet). Fast, but it is
  a second browser, not the server's: no shared page state with the agent's browser, synthetic clicks only, broken logins
  (Google, banks, anti-bot pages). It would also run third-party script on an origin next to Autora's, which CLAUDE.md forbids.
- **A better pixel stream** (WebRTC or H.264 instead of JPEG). Smoother, but the box still renders and encodes every frame,
  so a small server stays slow.

Outcome wanted:
**The functionality of the server browser with the speed of local rendering.** One real Chromium stays on the server and
remains the only browser: the agent's control, logins, cookies, CAPTCHAs, devtools, extensions and Visible work all work
exactly as they do today. What changes is how the person *sees and touches* it. Instead of pictures, Autora sends the page
itself: a serialized DOM snapshot, then every change as it happens (DOM mutations, scroll positions, input values, styles).
The person's browser draws that copy natively, so scrolling, text and hover are local and smooth. Their clicks, keys and
scrolls are sent back to the real page, matched element by element. The picture stream stays as the fallback: for regions
the DOM cannot carry (canvas, WebGL, video, plugins) and for whole pages where mirroring fails.

## Status (2026-11-19)

Built behind the browser menu's **Live copy (preview)**; pictures stay the default (phase 5 waits on R7). How it works and
where: `docs/MODULES.md`, "The mirror view". Decisions taken in planning:
- **Serializer**: purpose-built, not rrweb. A recorder (`server/mirror-script.ts`) in a CDP isolated world plus a
  `MutationObserver`, so the page's own script cannot see or fingerprint it and no dependency is added.
- **Hover**: the copy's own `:hover` styles are local and need nothing; only a pointer that rests on a new element moves the real
  mouse (`POST /browser/hover`), for menus opened by script.
- **Fonts and images**: in memory per session (`ResourceCache`, 48 MB, oldest out first), fetched through the browser
  context's own request session.
- **The frame**: `sandbox="allow-same-origin"` without `allow-scripts`, plus a CSP meta in its first document, so Autora's
  code can build the copy and nothing the site wrote can run.
- **Input** uses the existing `/browser/*` POST routes (so `agentDriving`, Take control and `crosssite.ts` hold unchanged);
  mirror *output* is ephemeral socket traffic, redacted as text and never logged.

| Requirement | State |
| --- | --- |
| R1.1-R1.4, R1.6 | Done (`mirror.test.ts`, `ui-browser-mirror.test.ts`) |
| R1.5 viewport follows the pane | Not yet: the server keeps the agent's 1280x800 and the copy is scaled like the picture |
| R2.1-R2.3 | Done for click, double and context click, mouse drag, wheel, keys, text, IME composition and paste; file pickers go through the click as before |
| R3.1 | Done for canvas, video, iframe, embed, object and closed-shadow custom elements |
| R3.2 | Size, mutation rate, region share and a layout-length check fall back per page; Picture mode in the menu; CAPTCHAs: the copy shows them as the page draws them (a CAPTCHA frame is a picture region) |
| R3.3 | Done: built under the picture, kept until a newer picture after a fall-back |
| R4.1, R4.3 | Done: a view only |
| R4.2 | The real mouse's moves are drawn over the copy while the agent drives; no UI test of an agent click over the copy yet |
| R5.3 | Done (open shadow roots serialized; closed ones are picture regions) |
| R5.1, R5.2 | Not yet: every iframe is a picture region |
| R6 | Done (`mirror.test.ts` security cases, `__pwned` probe, no request from the viewer to the site) |
| R7 | Not measured: the readout (menu: Show the copy's readout) shows fps while scrolling, click-to-change latency, KB/s, changes/s and snapshot size; the phase 1 site list and an Umbrel-class box are still to do |
| R8.1, R8.3 | Desktop, board, phone full screen take input on the copy; a phone in the thread passes it through the stage as with pictures; manual updated |

## Requirements

### R1 Mirror view (the default view of the live browser)
1. On a page load, the server sends a full snapshot of the page's DOM. Every node gets a stable id, and computed values are
   included where needed: adopted stylesheets, `@font-face`, `<style>` contents, form values.
2. After that, only the changes are sent: DOM mutations, attribute and text changes, scroll offsets of the document and of
   scrollable elements, form input values, `:hover`/`:focus` where the page styles depend on them, and viewport resizes.
   Changes are batched per animation frame.
3. The client rebuilds the page in a **sandboxed iframe with no scripts** (`sandbox` without `allow-scripts`, plus a
   `Content-Security-Policy` that forbids script). No code from the site ever runs in the person's browser or on Autora's
   origin.
4. Sub-resources (images, fonts, CSS `url()`s) load **through Autora** from the server browser's own cache or network
   session, so they carry its cookies and need no direct access from the person's device. Links are rewritten to go nowhere
   on their own; navigation is always done by the real browser.
5. The mirror's viewport is the person's pane size. The server browser's viewport is set to match (device scale included),
   so layout, media queries and wrapping are identical in both.
6. Scrolling the mirror is local and immediate. The resulting scroll offset is sent to the real page (throttled). The real
   page's own scrolling (the agent's, or the page's script) moves the mirror.

### R2 Input goes to the real page
1. Clicks, double-clicks, context clicks, drags, wheel, keys, text input, IME composition, paste, and file-picker requests
   from the mirror are sent to the server and dispatched as **trusted input** through the existing path (`server/human.ts`,
   `LiveBrowser` mouse/keyboard methods). They target the element under the pointer by node id, falling back to page
   coordinates when the element moved.
2. Typing must feel local: characters appear in the mirror's field immediately (optimistic echo), and are reconciled when
   the real page's value comes back.
3. The person's input and the agent's input never fight. The existing ownership rules hold: the person typing pauses the
   agent's hand, and Take control works as today.

### R3 Fallback to pictures, per region and per page
1. Elements the DOM cannot carry (`<canvas>`, WebGL, `<video>`, cross-origin plugins, closed shadow roots it cannot read)
   are shown as a **cropped picture stream of just that region**, positioned in the mirror, at a frame rate the box can
   afford. A playing video may use a lower quality than a static canvas.
2. A whole page switches to today's full screencast when:
   - the mirror is unhealthy: snapshot too large (threshold to be set), mutation rate too high, or a layout mismatch
     detected by comparing element boxes;
   - the person picks **Picture mode** on the browser's bar;
   - the page is one the agent marks as needing it (CAPTCHAs already drive the picture stream).
3. Switching between mirror and picture is seamless, with no blank frame. It shares the existing `Frame.tsx` rule that the
   visible content only changes from one drawable state to the next.

### R4 Agent and Visible work unchanged
1. Every `browser_*` tool and the agent's CDP access are untouched. The mirror is a view, not a second browser.
2. The agent's Visible-work cursor (`state.agentCursor`) is drawn over the mirror at the element and position the server
   reports. Its clicks visibly land on the mirrored element.
3. The agent may read the mirror's state only through the server. Nothing the agent sees depends on what the client
   rendered.

### R5 Frames, iframes, shadow DOM
1. Same-origin iframes are mirrored inline.
2. Cross-origin iframes are mirrored through a CDP session per frame (`Target.setAutoAttach` with flatten), or fall back to a
   picture region (R3.1) when that fails.
3. Open shadow roots are serialized. Closed ones fall back to a picture region.

### R6 Security (CLAUDE.md's rules hold)
1. No site script runs in the person's browser: the mirror is a sandboxed, script-free frame (R1.3), and inline event
   handlers (`on*` attributes) and `javascript:` URLs are stripped during serialization.
2. Sub-resources are fetched by the server and served with `Content-Security-Policy: sandbox` and `nosniff`. A response is
   never served as HTML on Autora's own origin.
3. Saved credentials are only ever filled by the real browser (existing `signins.ts`/`cookies.ts` rules). The mirror never
   carries password field values back to the client: they are shown masked, with length only.
4. Every message goes over the session's websocket. There is no new unauthenticated route, and nothing in `crosssite.ts` is
   loosened. Event payloads pass `redactDeep` like everything else, and mirror traffic (ephemeral, like `frame`) is not
   written to `events.jsonl`.

### R7 Performance targets (measured on an Umbrel-class box and a mid-range phone)
- Local scroll and hover in the mirror: 60 fps on desktop, 30 fps or better on a phone.
- From the person's click to the mirror showing the page's response: median ≤ 150 ms on a LAN.
- Server CPU while the person reads and scrolls a static page: at least 50% lower than today's screencast at the same
  viewport size.
- Bandwidth for a typical article or dashboard after the first snapshot: an order of magnitude below the JPEG stream.
- A built-in readout (dev setting) shows fps, input latency, snapshot size and mutation rate. It is the measuring stick
  for these targets.

### R8 Phones and the board
1. Works in the browser window on the Panacea board, on desktop and phone, including Maximise and full screen. Touch
   gestures map to the R2 input path.
2. The window's controls follow CLAUDE.md's rule that controls appear when the work needs them: Picture mode is offered
   when a page falls back or on request, not as standing chrome.
3. Update the browser window's manual in `server/handbook.ts`, and its test, in the same change as any UI change (CLAUDE.md).

## Who / what it touches
- `server/browser.ts` (`LiveBrowser`): a DOM-mirror recorder next to the screencast, viewport sync, input by node id.
- A recorder script injected into the page and its frames. rrweb (MIT) or a smaller purpose-built serializer: decide in
  planning.
- `server.ts`: new ephemeral message types on the session socket, next to `type: "frame"`; a sub-resource route.
- Client: a mirror renderer in `BrowserPanel.tsx` / `ScreencastCell.tsx`, with `Frame.tsx` kept for picture regions and
  the fallback.
- `src/components/panacea/hand.ts` / the Visible-work cursor overlay.
- `server/handbook.ts` (browser manual), `docs/VISIBLE-WORK.md`, `docs/MODULES.md`, `docs/MAP.md`.

## Constraints (CLAUDE.md)
- The server browser remains the one browser. Visible work stays live, not a replay: the mirror shows the real page as it
  changes, and the agent's actions happen in the real page.
- Anything a web page produced is shown sandboxed, never inline on Autora's origin (R1.3, R6).
- Every event goes through `emitEvent()` / redaction. Ephemeral view traffic is not logged (as `frame` is not).
- A release bump with the change, per the release rules. `npm run check` passes. UI tests use the real built app.
- No new auth system, and no second exposed port on Umbrel.

## Phases (each usable on its own, each behind a setting until it meets R7)
1. **Read-only mirror prototype**: snapshot and mutations for one tab, shown beside the screencast with the R7 readout.
   Measure 10 representative sites: news article, docs, GitHub, Gmail, a dashboard, a shop, a SPA, YouTube, maps, a site
   behind a login.
2. **Input**: R2, including optimistic typing.
3. **Fallbacks**: R3 (picture regions, whole-page fallback, Picture mode).
4. **Frames and shadow DOM**: R5. Then the agent cursor over the mirror (R4.2).
5. **Default on**: mirror becomes the default view when R7 holds on the phase 1 site list. Manual and docs updated.

## Tests that prove it
- Unit: the serializer strips scripts, `on*` and `javascript:`; node-id round trips; mutation batching; password masking.
- e2e (`tests/e2e-harness.ts`): a local test site with a DOM, a canvas and a video: snapshot arrives; a mutation shows up;
  a click in the mirror reaches the real page (server-side event observed); a canvas region falls back to pictures; a page
  over the size threshold falls back whole; no request from the mirror frame reaches the site directly.
- UI (Playwright, built app): scrolling the mirror does not request server frames; the agent's Visible-work click lands on
  the mirrored element; phone layout and Maximise work.
- Security: a page whose DOM contains `<script>`, `onerror=` and `javascript:` executes nothing in the client
  (a `window.__pwned` probe stays undefined).

## Open questions
- rrweb (proven, ~100 kB, MIT) or a lean serializer built on CDP `DOMSnapshot.captureSnapshot` plus a `MutationObserver`?
- How to tell hover-dependent styles apart without sending every pointer move to the server?
- Fonts and large images: cache per session in memory, or on disk under `stateDir()` with an expiry?
- Should the person be able to keep a page in Picture mode (per site, remembered)?
- What CPU does the recorder add to heavy SPAs, and at what mutation rate should it give up?
