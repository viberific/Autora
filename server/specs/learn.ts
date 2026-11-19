/**
 * Teaching the person how to use a tool, by highlighting its controls one step at a time (Learn mode: docs/LEARN.md).
 */

import type { ToolSpec } from "../tools";
import { MAX_STEPS } from "../../src/lib/learn";

export const learnSPECS: ToolSpec[] = [
  {
    name: "learn_show",
    group: "person",
    description:
      "Teach the person how to do something in Autora by leading them through it: each step highlights the real control on " +
      "screen with a line saying what to do and why, and waits until the person has used it before moving to the next. They " +
      "do the work; you coach. Use it when Learn mode is on and they ask for something to be done in a tool window, or " +
      "whenever they ask to be shown how. Name each control the way it reads on screen: its label (the name on its button or " +
      "its tooltip, e.g. \"All tools\", \"Highlight\") or the words on it; use a selector only for a control with no words. A " +
      "step with no target is a thing to think about, moved on with Next. Keep the lesson short (the first steps of the task, " +
      `at most ${MAX_STEPS}), one action per step, and open the control that holds the next one before naming it. A second ` +
      "lesson replaces the first. After calling it, say one short line to start them and stop: do not do the steps for them.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "What the lesson teaches, a few words (\"Highlighting text in a PDF\")." },
        steps: {
          type: "array",
          description: "The steps, in order.",
          items: {
            type: "object",
            properties: {
              say: { type: "string", description: "What to do and why, one or two plain sentences, no jargon." },
              target: {
                type: "object",
                description: "The control to highlight. Give the label or the words it shows.",
                properties: {
                  label: { type: "string", description: "The control's name: its button label or tooltip." },
                  text: { type: "string", description: "Words shown on it." },
                  selector: { type: "string", description: "A CSS selector, only for a control with no words." },
                },
              },
            },
            required: ["say"],
          },
        },
      },
      required: ["title", "steps"],
    },
  },
];
