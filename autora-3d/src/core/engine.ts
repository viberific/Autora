/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AgentHost, ExecuteOptions, ToolResponse, execute } from './agent';
import { CommandEntry, CommandRecord, MAX_LOG, Who, describeEdit, summarizeArgs } from './commands';
import { Doc, IdGen, counterIds, emptyDoc, settle } from './doc';
import { TOOL_SPECS, ToolSpec } from './tools';

/**
 * The whole modeller without a screen: a model, undo history and every tool an agent can call.
 * Runs in Node (scheduled jobs, hooks, servers) or in a browser tab.
 *
 *   const model = new Engine();
 *   const r = await model.execute('shape_add', { kind: 'box', width: 80, depth: 40, height: 30 });
 *   await model.execute('edge_bevel', { id: r.shapes![0].id, group: 'top', size: 4, style: 'round' });
 *   const stl = await model.execute('export', { format: 'stl' });
 */
export class Engine implements AgentHost {
  private doc: Doc;
  private past: Doc[] = [];
  private future: Doc[] = [];
  private rev = 0;
  private ids: IdGen;
  private listeners = new Set<(doc: Doc, revision: number) => void>();
  private log: CommandRecord[] = [];
  private count = 0;
  private watchers = new Set<(entry: CommandEntry) => void>();

  constructor(doc: Doc = emptyDoc()) {
    this.doc = settle(doc);
    this.ids = counterIds(this.doc);
  }

  /** The tools an agent may call, as JSON-Schema specs (for MCP, or an LLM's tool list). */
  static readonly tools: ToolSpec[] = TOOL_SPECS.filter((t) => !t.uiOnly && t.authority !== 'person');

  get tools(): ToolSpec[] {
    return Engine.tools;
  }

  getDoc = () => this.doc;
  revision = () => this.rev;
  newIds = () => this.ids;

  /** Commits a model. With `who` the change is also logged as a command of that name (the window sends whole models, so it is described from the difference). */
  setDoc = (doc: Doc, who?: Who) => {
    if (doc === this.doc) return;
    const before = this.doc;
    this.past.push(this.doc);
    if (this.past.length > 200) this.past.shift();
    this.future = [];
    this.doc = settle(doc);
    this.ids = counterIds(this.doc, this.rev + 1);
    this.rev++;
    if (who) this.record({ name: who === 'person' ? 'person_edit' : 'agent_edit', who, ok: true, changed: true, summary: describeEdit(before, this.doc), before, after: this.doc });
    this.listeners.forEach((fn) => fn(this.doc, this.rev));
  };

  undo = () => {
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push(this.doc);
    this.doc = prev;
    this.rev++;
    this.listeners.forEach((fn) => fn(this.doc, this.rev));
    return true;
  };

  redo = () => {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.doc);
    this.doc = next;
    this.rev++;
    this.listeners.forEach((fn) => fn(this.doc, this.rev));
    return true;
  };

  /** Runs a tool. Never throws: errors come back as { ok: false, error, hint }. */
  async execute(name: string, args: unknown = {}, options?: ExecuteOptions): Promise<ToolResponse> {
    const before = this.doc;
    const res = await execute(this, name, args, options);
    // Reading is not a command; history_undo and history_redo are recorded too, so the log says how the model got where it is.
    const readOnly = Engine.tools.find((t) => t.name === name)?.readOnly || TOOL_SPECS.find((t) => t.name === name)?.readOnly;
    if (!readOnly) {
      this.record({
        name,
        who: options?.who ?? 'agent',
        ok: res.ok,
        changed: res.changed || this.doc !== before,
        summary: res.ok ? summarizeArgs(name, args) : `${summarizeArgs(name, args)}: ${res.error ?? 'failed'}`.slice(0, 160),
        ...(this.doc !== before ? { before, after: this.doc } : {}),
      });
    }
    return res;
  }

  /** The commands made so far, oldest first, without the models they carry. */
  commandLog = (): CommandEntry[] => this.log.map(({ before: _b, after: _a, ...entry }) => entry);

  /** Be told of every command as it is logged. Returns the way to stop. */
  onCommand = (fn: (entry: CommandEntry) => void): (() => void) => {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  };

  /**
   * Puts the model back as it was before command `n` (a new change on top, so it can itself be undone; the log keeps the whole
   * story). False when that command did not change anything or is no longer kept.
   */
  revertTo = (n: number, who: Who = 'person'): boolean => {
    const rec = this.log.find((r) => r.n === n);
    if (!rec?.before) return false;
    const before = this.doc;
    this.setDoc(rec.before);
    if (this.doc !== before) this.record({ name: 'history_revert', who, ok: true, changed: true, summary: `back to before command ${n} (${rec.name})`, before, after: this.doc });
    return true;
  };

  private record(r: Omit<CommandRecord, 'n' | 'revision' | 'at'>) {
    const rec: CommandRecord = { ...r, n: ++this.count, revision: this.rev, at: Date.now() };
    this.log.push(rec);
    if (this.log.length > MAX_LOG) this.log.shift();
    const { before: _b, after: _a, ...entry } = rec;
    this.watchers.forEach((fn) => fn(entry));
  }

  /** Be told whenever the model changes. Returns the way to stop. */
  subscribe(fn: (doc: Doc, revision: number) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  toJSON() {
    return { bodies: this.doc.bodies, groups: this.doc.groups, repeats: this.doc.repeats, library: this.doc.library, ...(this.doc.look ? { look: this.doc.look } : {}) };
  }
}
