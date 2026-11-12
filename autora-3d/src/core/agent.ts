/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { glbBytes } from '../utils/glb';
import { objText, stlBytes, toBase64 } from '../utils/serialize';
import { initManifold } from '../utils/manifoldBoolean';
import { Doc, IdGen, emptyDoc, parseDoc, settle } from './doc';
import type { CommandEntry, Who } from './commands';
import { AgentError } from './errors';
import { ShapeSummary, summarize } from './inspect';
import { TOOL_SPECS, mentionedShapes, runDocTool, toolByName } from './tools';

/** What a tool call needs from whoever holds the model: the headless Engine, or the live app. */
export interface AgentHost {
  getDoc(): Doc;
  /** Commit a changed document. Must be visible to getDoc() straight away. */
  setDoc(doc: Doc): void;
  newIds(): IdGen;
  undo(): boolean;
  redo(): boolean;
  /** Increases on every change, so a caller can notice that someone else (a person at the screen) edited. */
  revision(): number;
  /** The commands made on the model so far, oldest first (the headless Engine keeps them). */
  commandLog?(): CommandEntry[];
  /** Things only a screen can do. Absent when headless. */
  ui?: (name: string, args: Record<string, any>) => unknown | Promise<unknown>;
}

export interface ToolResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
  hint?: string;
  /** The shapes the result mentions, as they are now. */
  shapes?: ShapeSummary[];
  /** Whether the model changed. */
  changed: boolean;
  revision: number;
}

export interface ExecuteOptions {
  /** Refuse unless the model is still at this revision (so a stale plan cannot overwrite a person's edit). */
  ifRevision?: number;
  /** Who is calling. The default is the agent, which is refused the person's own commands (a brush stroke). */
  who?: Who;
}

const personsOwn = (name: string) => toolByName(name)?.authority === 'person';
const refusal = (name: string) =>
  name.startsWith('hair_')
    ? new AgentError(`${name} is the person's own hand, not a tool for you: styling hair by hand is theirs to do.`, 'Suggest how to groom it and tell them where the brush is (Groom in the Hair card of the 3D window). hair_set changes how it grows.')
    : new AgentError(`${name} is the person's own hand, not a tool for you: shaping a form by hand is theirs to do.`, 'Suggest what to change and tell them where the tool is (the Sculpt tool in the 3D window).');

const READ_ONLY = new Set(TOOL_SPECS.filter((t) => t.readOnly).map((t) => t.name));

/** Runs one tool call (or a batch) against a host. Never throws: a bad request comes back as { ok: false, error, hint }. */
export async function execute(host: AgentHost, name: string, args: unknown = {}, options: ExecuteOptions = {}): Promise<ToolResponse> {
  const fail = (e: unknown): ToolResponse => {
    if (e instanceof AgentError) return { ok: false, error: e.message, hint: e.hint, changed: false, revision: host.revision() };
    return { ok: false, error: e instanceof Error ? `Internal error: ${e.message}` : String(e), changed: false, revision: host.revision() };
  };
  try {
    // The exact geometry engine starts once, on the first call (a no-op after that).
    await initManifold().catch(() => undefined);
    if (options.ifRevision !== undefined && options.ifRevision !== host.revision() && !READ_ONLY.has(name)) {
      throw new AgentError(`The model changed since you looked (revision ${host.revision()}, you had ${options.ifRevision}).`, 'Call scene_get again and redo your plan.');
    }
    const spec = toolByName(name);
    if (!spec) throw new AgentError(`Unknown tool "${name}".`, `Tools: ${TOOL_SPECS.map((t) => t.name).join(', ')}`);

    if (personsOwn(name) && options.who !== 'person') throw refusal(name);

    if (name === 'batch') return await runBatch(host, args as any, options.who);

    if (spec.uiOnly) {
      if (!host.ui) throw new AgentError(`"${name}" needs the live app (it needs a screen).`, 'The headless engine has no view.');
      const result = await host.ui(name, (args as Record<string, any>) ?? {});
      return { ok: true, result, changed: false, revision: host.revision() };
    }

    const { doc, result, changed, extra } = runOne(host, host.getDoc(), host.newIds(), name, args);
    if (changed) host.setDoc(doc);
    const shapes = extra ?? mentionedShapes(doc, result).map((b) => summarize(doc, b));
    return { ok: true, result, shapes: shapes.length ? shapes : undefined, changed, revision: host.revision() };
  } catch (e) {
    return fail(e);
  }
}

interface One {
  doc: Doc;
  result: unknown;
  changed: boolean;
  extra?: ShapeSummary[];
}

/** One non-UI tool against `doc`, without committing anything. */
function runOne(host: AgentHost, doc: Doc, ids: IdGen, name: string, args: unknown): One {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, any>;
  switch (name) {
    case 'doc_get':
      return { doc, result: { bodies: doc.bodies, groups: doc.groups, repeats: doc.repeats, library: doc.library }, changed: false };
    case 'doc_set': {
      const next = parseDoc(a.doc);
      if (!next) throw new AgentError('doc must be a document from doc_get: { bodies: [...], groups: [...], repeats: [...], library: [...] }.');
      return { doc: next, result: { shapes: next.bodies.filter((b) => !b.repeatOf).length }, changed: true };
    }
    case 'doc_clear':
      return { doc: emptyDoc(), result: { cleared: doc.bodies.length }, changed: true };
    case 'history_log': {
      const log = host.commandLog?.() ?? [];
      const last = Math.max(1, Math.min(100, Math.round(Number(a.last ?? 20)) || 20));
      const since = a.since_revision === undefined ? -1 : Number(a.since_revision);
      const entries = log.filter((r) => r.revision > since).slice(-last);
      return { doc, result: { commands: entries, total: log.length }, changed: false };
    }
    case 'history_undo': {
      const ok = host.undo();
      if (!ok) throw new AgentError('Nothing to undo.');
      return { doc: host.getDoc(), result: { undone: true }, changed: false };
    }
    case 'history_redo': {
      const ok = host.redo();
      if (!ok) throw new AgentError('Nothing to redo.');
      return { doc: host.getDoc(), result: { redone: true }, changed: false };
    }
    case 'export': {
      const bodies = doc.bodies;
      if (a.format === 'json') return { doc, result: { format: 'json', filename: 'craft3d.json', text: JSON.stringify({ bodies: doc.bodies, groups: doc.groups, repeats: doc.repeats, library: doc.library }) }, changed: false };
      if (a.format === 'obj') {
        const text = objText(bodies);
        if (!text) throw new AgentError('Nothing visible to export.');
        return { doc, result: { format: 'obj', filename: 'craft3d.obj', text }, changed: false };
      }
      if (a.format === 'stl') {
        const bytes = stlBytes(bodies);
        if (!bytes) throw new AgentError('Nothing visible to export.');
        return { doc, result: { format: 'stl', filename: 'craft3d.stl', encoding: 'base64', bytes: bytes.length, data: toBase64(bytes) }, changed: false };
      }
      if (a.format === 'glb') {
        const bytes = glbBytes(bodies, { scale: a.scale, pivot: a.pivot, groups: doc.groups });
        if (!bytes) throw new AgentError('Nothing visible to export.');
        return { doc, result: { format: 'glb', filename: 'craft3d.glb', encoding: 'base64', bytes: bytes.length, data: toBase64(bytes) }, changed: false };
      }
      throw new AgentError('format must be "stl", "glb", "obj" or "json".');
    }
    default: {
      const out = runDocTool({ doc, ids }, name, args);
      return { doc: settle(out.doc), result: out.result, changed: out.doc !== doc };
    }
  }
}

async function runBatch(host: AgentHost, a: { commands?: { tool: string; args?: unknown }[]; atomic?: boolean }, who?: Who): Promise<ToolResponse> {
  const commands = a.commands;
  if (!Array.isArray(commands) || !commands.length) throw new AgentError('commands must be a non-empty list of { tool, args }.');
  const atomic = a.atomic !== false;
  const ids = host.newIds();
  let doc = host.getDoc();
  const results: unknown[] = [];
  const touched = new Set<string>();
  let changed = false;
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i];
    const spec = toolByName(c.tool);
    if (spec && personsOwn(c.tool) && who !== 'person') {
      if (atomic) throw new AgentError(`Command ${i} (${c.tool}): ${refusal(c.tool).message} Nothing was changed.`);
      results.push({ ok: false, error: refusal(c.tool).message });
      continue;
    }
    if (!spec || c.tool === 'batch' || spec.uiOnly || c.tool === 'history_undo' || c.tool === 'history_redo') {
      const why = c.tool === 'batch' ? 'batches cannot be nested' : spec?.uiOnly ? 'screen commands cannot be batched' : c.tool.startsWith('history') ? 'undo and redo cannot be batched' : `unknown tool "${c.tool}"`;
      if (atomic) throw new AgentError(`Command ${i} (${c.tool}): ${why}. Nothing was changed.`);
      results.push({ ok: false, error: why });
      continue;
    }
    try {
      // Each command sees the model as the commands before it left it (ids returned earlier are valid here).
      const shim: AgentHost = { ...host, getDoc: () => doc };
      const one = runOne(shim, doc, ids, c.tool, c.args);
      doc = one.doc;
      changed = changed || one.changed;
      results.push({ ok: true, result: one.result });
      mentionedShapes(doc, one.result).forEach((b) => touched.add(b.id));
    } catch (e) {
      const msg = e instanceof AgentError ? e.message : e instanceof Error ? e.message : String(e);
      if (atomic) {
        throw new AgentError(`Command ${i} (${c.tool}) failed: ${msg} Nothing was changed.`, e instanceof AgentError ? e.hint : undefined);
      }
      results.push({ ok: false, error: msg });
    }
  }
  if (changed) host.setDoc(doc);
  const shapes = [...touched].map((id) => doc.bodies.find((b) => b.id === id)).filter((b): b is NonNullable<typeof b> => !!b).slice(0, 20).map((b) => summarize(doc, b));
  return { ok: true, result: { results }, shapes: shapes.length ? shapes : undefined, changed, revision: host.revision() };
}
