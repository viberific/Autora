# Review policy

Read by automated review (`claude-code-action` or managed Code Review) and by people. Findings never approve or block on
their own; branch protection and a code owner still decide. (`docs/REVIEW.md` is something else: known inefficiencies.)

## Passes
1. **Bugs**: wrong results, races, unawaited promises, state not cleared in `forgetSession`, events written around `emitEvent()`.
2. **Security**: the rules in CLAUDE.md (secrets via `redactDeep`, cross-site refusal, sandboxed agent HTML, host comparison by parsed hostname, bind address).
3. **Product rules**: Yolo stays default; creative tools give the agent no replace/insert (guide, don't write); Visible work is live, not a replay; a window UI change updates `server/handbook.ts` and its test.
4. **Release**: version bump, lockfile, and `releaseNotes` describing this change (or `[no release]` for a change with no user-facing effect).

## Important vs nit
- **Important**: a defect a person or the agent would hit, a security rule broken, a pin moved, a test skipped to get green.
- **Nit**: naming, comment wording, style ESLint does not flag. At most 3 nits per review; none if there is any Important finding.

## Skip
`spectra-editor/src/renderer/`, `opencut-editor/src/web*/`, `gdevelop-editor/work/` (fetched upstream), lockfiles beyond the version fields,
and anything `npm run check` already enforces (types, lint, unused code, tokens).

## Same mistake twice
Add the correction to CLAUDE.md.
