import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconDownload, IconPlus, IconRotateCcw, IconSkill, IconTrash, IconUpload } from "../Icons";
import {
  SKILL_TEMPLATE, approveSkill, authorLabel, checkSkill, createSkill, deleteSkill, exportAllUrl, exportUrl, fetchSkill,
  fetchSkillFile, fetchSkills, importSkills, revertSkill, saveSkill, saveSkillFile, type Skill, type SkillInfo, type SkillVersion,
} from "../../lib/skills";
import { every } from "../../lib/poll";
import { sure } from "../../lib/sure";

const when = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * Skills: the library of ways of doing a kind of work, shared by Autora and every
 * agent. Each is a real skill in the open Agent Skills format -- a folder with a
 * SKILL.md and whatever scripts or references it uses -- so one made here works
 * anywhere that reads the format, and one made elsewhere imports as it is.
 * What an agent writes waits at the top as a draft for the person to approve.
 */
export function SkillsPage({ topSlot }: { topSlot?: HTMLElement | null }) {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The skill open in the editor: a name, or "" for a new one. */
  const [editing, setEditing] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    fetchSkills().then(setSkills).catch(() => setSkills([]));
  }, []);
  useEffect(() => {
    load();
    /* Agents write and improve skills while the page is open. */
    return every(load, 15_000);
  }, [load]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (skills ?? []).filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q));
  }, [skills, query]);
  const drafts = shown.filter((s) => s.status === "draft");
  const live = shown.filter((s) => s.status === "live");

  const importFile = (file: File | undefined) => {
    if (!file) return;
    void run(async () => {
      const r = await importSkills(file);
      setNotice(
        `${r.imported.length ? `Imported ${r.imported.map((s) => s.name).join(", ")}.` : "Nothing imported."}` +
        (r.skipped.length ? ` Skipped ${r.skipped.map((s) => `${s.where}: ${s.error}`).join("; ")}` : ""),
      );
    });
  };

  if (editing !== null) {
    return (
      <div className="page-scroll">
        <div className="page-inner">
          <SkillEditor
            name={editing || null}
            onClose={() => { setEditing(null); load(); }}
            onSaved={(name) => { setEditing(name); load(); }}
          />
        </div>
      </div>
    );
  }

  const newButton = (
    <button className={`btn primary${topSlot ? " top-action" : ""}`} onClick={() => setEditing("")}>
      <IconPlus size={topSlot ? 13 : 14} /> <span className={topSlot ? "top-action-word" : undefined}>New skill</span>
    </button>
  );

  return (
    <div className="page-scroll">
      <div className="page-inner">
        <div className="page-toolbar">
          <p className="jf-hint page-lede">
            Ways of doing a kind of work, shared by Autora and every agent. Each skill is a folder with a SKILL.md:
            a name, a description of when to use it, then the instructions, with any scripts beside it. The agents
            see every skill's description and load one when the work fits it.
          </p>
          <input
            className="page-search"
            placeholder="Search skills…"
            aria-label="Search skills"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <a
            className="btn ghost"
            href={skills && skills.length ? exportAllUrl() : undefined}
            download="autora-skills.zip"
            title="Download every skill, each in its own folder, as one .zip"
            aria-disabled={!skills || skills.length === 0}
          >
            <IconDownload size={14} /> Download all
          </a>
          <button className="btn ghost" onClick={() => picker.current?.click()} title="Import a .zip of one or more skill folders">
            <IconUpload size={14} /> Import
          </button>
          <input
            ref={picker} type="file" accept=".zip,application/zip" hidden
            onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = ""; }}
          />
          {!topSlot && newButton}
        </div>
        {topSlot && createPortal(newButton, topSlot)}
        {error && <p className="set-warn">{error}</p>}
        {notice && <p className="jf-hint">{notice}</p>}

        {drafts.length > 0 && (
          <section className="set-card skill-drafts">
            <h3>Written by agents, waiting for you <span className="web-count">{drafts.length}</span></h3>
            <p className="jf-hint">
              Agents already use these. Approve one you are happy with, or open it to change it; each goes live by
              itself once it has worked three times.
            </p>
            {drafts.map((s) => (
              <SkillRow key={s.name} skill={s} onOpen={() => setEditing(s.name)}>
                <button className="btn tiny" disabled={busy} onClick={() => void run(() => approveSkill(s.name))}>Approve</button>
              </SkillRow>
            ))}
          </section>
        )}

        {skills && skills.length === 0 && (
          <div className="empty page-empty">
            <span className="empty-ring"><IconSkill size={22} /></span>
            <h3>No skills yet</h3>
            <p>
              Write one, import a skill folder as a .zip, or let the agents write them: when one works out a method
              worth repeating, it saves it here as a draft.
            </p>
          </div>
        )}
        {skills && skills.length > 0 && shown.length === 0 && (
          <div className="empty page-empty">
            <span className="empty-ring"><IconSkill size={22} /></span>
            <h3>Nothing matches</h3>
            <p>Try another word.</p>
          </div>
        )}

        <div className="skill-list">
          {live.map((s) => (
            <SkillRow key={s.name} skill={s} onOpen={() => setEditing(s.name)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SkillRow({ skill: s, onOpen, children }: { skill: SkillInfo; onOpen: () => void; children?: React.ReactNode }) {
  const broken = s.description.startsWith("(not usable:");
  return (
    <section className={`set-card skill-row ${broken ? "is-broken" : ""}`}>
      <button type="button" className="skill-row-main" onClick={onOpen}>
        <span className="skill-row-title">
          <IconSkill size={14} />
          <code>{s.name}</code>
          {s.status === "draft" && <span className="mind-flag">draft</span>}
          {s.files.length > 0 && <span className="mind-flag">{s.files.length} file{s.files.length === 1 ? "" : "s"}</span>}
          {s.uses > 0 && <span className="mind-flag">used {s.uses}×{s.worked ? `, worked ${s.worked}×` : ""}</span>}
        </span>
        <span className="skill-row-desc">{s.description}</span>
        <span className="skill-row-meta">By {authorLabel(s.author)} · changed {when(s.updated)}</span>
      </button>
      {children && <div className="skill-row-actions">{children}</div>}
    </section>
  );
}

/** One skill's SKILL.md, edited as text and checked against the format as it is typed. */
function SkillEditor({ name, onClose, onSaved }: { name: string | null; onClose: () => void; onSaved: (name: string) => void }) {
  const [skill, setSkill] = useState<Skill | null>(null);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [text, setText] = useState(name ? "" : SKILL_TEMPLATE);
  const [verdict, setVerdict] = useState<{ ok: boolean; error?: string } | null>(null);
  const [file, setFile] = useState<{ path: string; text: string; saved: string } | null>(null);
  /** A new file's name, while it is being typed. */
  const [newFile, setNewFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!name) return;
    fetchSkill(name).then((d) => { setSkill(d.skill); setVersions(d.versions); setText(d.skill.text); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not open it."));
  }, [name]);
  useEffect(load, [load]);

  /* The format's own check, a moment after typing stops. */
  useEffect(() => {
    if (!text) return;
    let live = true;
    const t = setTimeout(() => {
      checkSkill(text).then((v) => { if (live) setVerdict(v.ok ? { ok: true } : { ok: false, error: v.error }); }).catch(() => undefined);
    }, 350);
    return () => { live = false; clearTimeout(t); };
  }, [text]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong"); } finally { setBusy(false); }
  };

  const save = () => act(async () => {
    const r = name ? await saveSkill(name, text) : await createSkill(text);
    if (r.info.name === name) load();
    onSaved(r.info.name);
  });

  const changed = skill ? text !== skill.text : true;

  /* A file beside SKILL.md: opened, saved and removed on its own, so a script is the person's to change. */
  const openFile = (path: string) => {
    if (!skill) return;
    setError(null);
    fetchSkillFile(skill.name, path)
      .then((t) => setFile({ path, text: t, saved: t }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not open that file."));
  };

  const took = (r: { skill: SkillInfo; versions: SkillVersion[] }) => {
    setSkill((s) => (s ? { ...s, ...r.skill } : s));
    setVersions(r.versions);
    load();
  };

  const saveFile = () => act(async () => {
    if (!skill || !file) return;
    const r = await saveSkillFile(skill.name, file.path, file.text);
    setFile({ ...file, saved: file.text });
    took(r);
  });

  const removeFile = () => act(async () => {
    if (!skill || !file) return;
    if (!(await sure(`Delete \u201c${file.path}\u201d from this skill? The one there now is kept as a version.`))) return;
    const r = await saveSkillFile(skill.name, file.path, null);
    setFile(null);
    took(r);
  });

  const addFile = (path: string) => act(async () => {
    if (!skill) return;
    const clean = path.trim().replace(/^\.?\//, "");
    if (!clean) return;
    if (skill.files.includes(clean)) { setError("There is already a file called that."); return; }
    const r = await saveSkillFile(skill.name, clean, "");
    setNewFile(null);
    setFile({ path: clean, text: "", saved: "" });
    took(r);
  });

  return (
    <section className="set-card skill-editor">
      <div className="skill-editor-head">
        <h3>{name ? <code>{name}</code> : "New skill"}</h3>
        {skill?.status === "draft" && <span className="mind-flag">draft by {authorLabel(skill.author)}</span>}
        <div className="spacer" />
        {name && (
          <a className="btn ghost" href={exportUrl(name)} download title="Download this skill's folder as a .zip">
            <IconDownload size={14} /> Export
          </a>
        )}
        {name && (
          <button
            className="btn icon ghost" title="Delete" aria-label="Delete"
            onClick={() => void (async () => {
              if (!(await sure(`Delete the skill “${name}”? No agent will be able to use it.`))) return;
              await act(async () => { await deleteSkill(name); onClose(); });
            })()}
          >
            <IconTrash size={14} />
          </button>
        )}
      </div>
      <p className="jf-hint">
        SKILL.md: between the <code>---</code> lines, <code>name</code> (lowercase words joined by hyphens) and{" "}
        <code>description</code> (what it does and when to use it: this is all an agent sees until it picks the skill),
        then the instructions in Markdown.
      </p>
      <label className="jf-row">
        <span>SKILL.md</span>
        <textarea
          className="jf-cron skill-md"
          rows={18}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {verdict && (
        <p className={verdict.ok ? "jf-hint skill-ok" : "set-warn"} role="status">
          {verdict.ok ? "A valid skill." : verdict.error}
        </p>
      )}
      {error && <p className="set-warn">{error}</p>}

      {skill && (
        <div className="skill-files">
          <span className="jf-hint">Files beside it: the scripts and references this skill uses, edited here and saved on their own</span>
          <div className="skill-file-row">
            {skill.files.map((f) => (
              <button
                key={f} type="button" className={`mind-rel ${file?.path === f ? "on" : ""}`}
                onClick={() => openFile(f)}
              >
                {f}
              </button>
            ))}
            <button type="button" className="btn tiny ghost" onClick={() => setNewFile(newFile === null ? "scripts/" : null)}>
              <IconPlus size={12} /> New file
            </button>
          </div>
          {newFile !== null && (
            <div className="skill-file-row">
              <input
                className="page-search" autoFocus placeholder="scripts/run.mjs" aria-label="New file's path"
                value={newFile} onChange={(e) => setNewFile(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void addFile(newFile);
                  if (e.key === "Escape") setNewFile(null);
                }}
              />
              <button className="btn tiny primary" disabled={busy || !newFile.trim()} onClick={() => void addFile(newFile)}>Add</button>
              <button className="btn tiny ghost" onClick={() => setNewFile(null)}>Cancel</button>
            </div>
          )}
          {file && (
            <>
              <label className="jf-row">
                <span>{file.path}</span>
                <textarea
                  className="jf-cron skill-md" rows={14} spellCheck={false}
                  value={file.text} onChange={(e) => setFile({ ...file, text: e.target.value })}
                />
              </label>
              <div className="jf-actions">
                <button className="btn ghost" disabled={busy} onClick={() => void removeFile()}>Delete file</button>
                <button className="btn primary" disabled={busy || file.text === file.saved} onClick={() => void saveFile()}>
                  Save file
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {versions.length > 0 && name && (
        <div className="skill-versions">
          <span className="jf-hint">Earlier versions</span>
          {versions.map((v, i) => (
            <div key={v.at} className="skill-version">
              <span>{when(v.at)}, replaced by {v.by}{v.files && Object.keys(v.files).length > 0 ? ` \u00b7 ${Object.keys(v.files).length} file${Object.keys(v.files).length === 1 ? "" : "s"}` : ""}</span>
              <button className="btn tiny ghost" disabled={busy} onClick={() => void act(async () => { await revertSkill(name, i); load(); })}>
                <IconRotateCcw size={12} /> Go back to this
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="jf-actions">
        <button className="btn ghost" onClick={onClose}>{changed && name ? "Discard changes" : "Back"}</button>
        {skill?.status === "draft" && !changed && (
          <button className="btn" disabled={busy} onClick={() => void act(async () => { await approveSkill(skill.name); load(); })}>Approve</button>
        )}
        <button className="btn primary" disabled={busy || !changed || verdict?.ok === false} onClick={() => void save()}>
          {name ? "Save" : "Create skill"}
        </button>
      </div>
    </section>
  );
}
