/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The command layer: every change to the model is a named command made by someone, with who may make it, what it did and the
// model on either side of it. The log is what undo, replay and a history scrubber read; because documents are immutable, a
// command's inverse is the document before it, so reverting needs no per-command undo code.

import type { Body3D } from '../types';
import type { Doc } from './doc';

/** Who a command is for. An `agent` command may be called by the agent; a `person` command is the person's own hand (a brush stroke) and is refused to the agent. */
export type Who = 'agent' | 'person';

export interface CommandRecord {
  /** Order in this log, from 1. */
  n: number;
  /** The tool's name, or `person_edit` for a change the person made in the window. */
  name: string;
  who: Who;
  ok: boolean;
  changed: boolean;
  /** The model's revision after the command. */
  revision: number;
  at: number;
  /** A short account of what it did, for the log and the agent. Never the whole arguments. */
  summary: string;
  /** The model before and after: its inverse and its effect. Kept in the engine, not sent anywhere. */
  before?: Doc;
  after?: Doc;
}

/** A record without the two documents: what is sent to the page and written to the event log. */
export type CommandEntry = Omit<CommandRecord, 'before' | 'after'>;

export const MAX_LOG = 200;

const MAX_SUMMARY = 160;
const clip = (s: string) => (s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY - 1)}…` : s);

/** Arguments that carry a file or a whole model: named nowhere in a summary. */
const BULKY = new Set(['data', 'text', 'doc']);

/** A short account of a call's arguments: which shapes and the few plain values, never a big blob (a mesh, a file). */
export function summarizeArgs(name: string, args: unknown): string {
  if (!args || typeof args !== 'object') return name;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === undefined || value === null || BULKY.has(key)) continue;
    if (typeof value === 'string') parts.push(`${key} ${value.length > 40 ? `${value.slice(0, 40)}…` : value}`);
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(`${key} ${value}`);
    else if (Array.isArray(value)) parts.push(`${key} ×${value.length}`);
    else parts.push(key);
    if (parts.length >= 5) break;
  }
  return clip(parts.length ? `${name} (${parts.join(', ')})` : name);
}

const meshOf = (b?: Body3D) => b?.mesh;

/** What the person did, in words, from the model before and after (the window sends whole models, not commands). */
export function describeEdit(before: Doc, after: Doc): string {
  const was = new Map(before.bodies.map((b) => [b.id, b]));
  const is = new Map(after.bodies.map((b) => [b.id, b]));
  const added = after.bodies.filter((b) => !was.has(b.id) && !b.repeatOf);
  const removed = before.bodies.filter((b) => !is.has(b.id) && !b.repeatOf);
  const changed = after.bodies.filter((b) => was.has(b.id) && was.get(b.id) !== b && !b.repeatOf);
  const sculpted = changed.filter((b) => meshOf(b) && meshOf(was.get(b.id)) !== meshOf(b) && meshOf(was.get(b.id))?.indices === meshOf(b)?.indices);
  const groomed = changed.filter((b) => !sculpted.includes(b) && (b.hair?.strokes?.length ?? 0) > (was.get(b.id)?.hair?.strokes?.length ?? 0));
  const rest = changed.filter((b) => !sculpted.includes(b) && !groomed.includes(b));
  const names = (list: Body3D[]) => list.slice(0, 3).map((b) => b.name).join(', ') + (list.length > 3 ? ` +${list.length - 3}` : '');
  const out: string[] = [];
  if (added.length) out.push(`added ${names(added)}`);
  if (removed.length) out.push(`removed ${names(removed)}`);
  if (sculpted.length) out.push(`sculpted ${names(sculpted)}`);
  if (groomed.length) out.push(`groomed the hair of ${names(groomed)}`);
  if (rest.length) out.push(`changed ${names(rest)}`);
  if (!out.length) out.push(before.groups !== after.groups || before.library !== after.library ? 'changed groups or the library' : before.look !== after.look ? 'changed the light' : 'changed the model');
  return clip(out.join('; '));
}
