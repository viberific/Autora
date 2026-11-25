/**
 * The phone window's tools: a real Android phone beside the chat.
 *
 * The window is server/phone.ts; these are how the agent reads and acts on the same phone. They are deliberately few and
 * named for what the person would do with a finger, because the model's job is to look, say what it is doing, and act --
 * not to hold a shell. The screen comes back as text with references (@e12) a tap can name, which is what makes a tap
 * reliable without pixel guessing.
 */
import type { ToolSpec } from "../tools";

export const PHONE_TOOLS: ToolSpec[] = [
  {
    name: "phone_screen",
    group: "files",
    description:
      "Open the phone window and read what is on the phone's screen: the app in front and its elements, each with a reference " +
      "(@e12) that phone_tap can name. Read before you tap, and again after: the screen moves under you. The person sees the " +
      "same screen and can tap it too.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "phone_look",
    group: "files",
    description:
      "A picture of the phone's screen, for what text does not show: a layout, a picture, an icon, something drawn. The text " +
      "from phone_screen is what you act on; this is for looking.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "phone_tap",
    group: "files",
    description:
      "Tap something on the phone: a reference from phone_screen (@e12), a point as x,y, or the words on the control. " +
      "One thing at a time, reading the screen afterwards.",
    parameters: {
      type: "object",
      properties: { target: { type: "string", description: "A reference (@e12), x,y, or the text of the control." } },
      required: ["target"],
    },
  },
  {
    name: "phone_type",
    group: "files",
    description:
      "Type into the phone. With `into` (a reference from phone_screen) the field's text is replaced; without it, into whatever " +
      "already has focus. Secrets typed this way can end up in the chat, so say so if it matters.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to type." },
        into: { type: "string", description: "A field's reference (@e7). Optional." },
      },
      required: ["text"],
    },
  },
  {
    name: "phone_scroll",
    group: "files",
    description: "Scroll the screen up or down, or until some text shows: `until` is the text to stop at.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        until: { type: "string", description: "Text to scroll until. Optional." },
      },
      required: ["direction"],
    },
  },
  {
    name: "phone_press",
    group: "files",
    description: "Press a phone button: home, back, recents, notifications, lock, enter, hide-keyboard, volume-up, volume-down.",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
];
