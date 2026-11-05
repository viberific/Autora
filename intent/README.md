# Intent

One file per idea or incident that should become work: `YYYY-MM-DD-short-title.md`. It states what is wanted, why, and the
constraints, so a planning session starts from the same text each time.

```
# Title
Problem:
Outcome wanted:
Who / what it touches:
Constraints (check CLAUDE.md's product decisions):
Open questions:
```

Flow: intent -> plan mode (files that change, order, risks, tests that prove it) -> build -> `verifier` agent -> PR.
Findings agents record while using Autora go to `docs/improvements/`; promote one here when it is worth building.
Fixed incidents should gain an eval in `evals/tasks.ts`.
