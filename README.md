# Dead-Code Ghost

A small, local, read-only tool that scans a JavaScript/TypeScript repo, finds
functions that are never called anywhere, and writes a Markdown report with a
plain-English note and a last-touched date for each one.

**Report only — this tool never deletes or modifies code.** It only reads the
scanned repo and writes the single report file you point it at.

## What it does

1. **Repo scan (read-only):** parses `.js`, `.jsx`, `.ts`, `.tsx` files and
   builds a name-based call graph. Functions never referenced anywhere are
   reported as dead.
2. **Plain-English notes via a small local model:** Gemma 3 1B via Ollama
   (local inference, no cloud, no paid API, no API key). When Ollama or the
   model is not reachable, the note says so plainly — no note is ever invented.
3. **Last-touched date:** from `git log` for each dead function's definition
   line. When the scanned folder is not a git repo, the date is reported as
   unavailable — never invented.
4. **Markdown report:** one readable file — function, location (file + line),
   plain-English note, last-touched date.

Exports and entry files get an honest confidence note: an exported function
that is never called inside the repo is listed separately as
"exported but never called internally" — outside code may use it, so it is a
review candidate, not confirmed dead code. Detection is best-effort and never
claimed perfect: the graph is name-based (not scope-resolved), and dynamic
calls (`obj[name]()`, `eval`, string-built calls) are not seen.

"Ghost" here means dead code only. There is no spirit, séance, or
Halloween-ritual framing anywhere in this tool, its output, or this README.

## Setup (owner's Windows PC)

1. Install Node.js (18+) and [Ollama](https://ollama.com).
2. Pull the small local model (about 1 GB — do this after any other large
   downloads finish, so the two do not compete for bandwidth):
   `ollama pull gemma3:1b`
3. No `npm install` needed — zero dependencies.

## Run

```
node ghost.js scan <repo-folder> --out dead-code-report.md
```

Options:

- `--model <name>` — Ollama model for notes (default `gemma3:1b`).
- `--no-model` — skip notes (useful for a first dry run).

Example on the bundled sample repo:

```
node ghost.js scan sample-repo --out report.md
```

## Example report excerpt (real scan of `sample-repo`, notes skipped in this run because no Ollama was available here — on a PC with Gemma 3 1B they are real sentences)

```
## Dead functions (4) — never referenced anywhere, not exported

- **oldHelper** — `src/utils.js:10`
  - What it appears to do: Gemma note skipped (--no-model).
  - Last touched: unavailable (unavailable — not a git repo or git log failed)
- **unusedCalc** — `src/utils.js:15`
- **idle** — `src/utils.js:30`
- **deadTsHelper** — `src/helpers.ts:7`

## Exported but never called internally (2) — review, not necessarily dead

- **formatDate** — `src/helpers.ts:2`
- **publicApi** — `src/utils.js:20`
```

In a git repo, last-touched dates resolve from `git log -L` on the
definition line (verified: 2026-10-28 on a test git repo).

## Tests

```
npm test
```

The test runs a real scan of `sample-repo`, asserts the exact dead set
(`deadTsHelper`, `idle`, `oldHelper`, `unusedCalc`) and exported-unused set
(`formatDate`, `publicApi`), and verifies the sample files are byte-identical
after the scan.

## Status

Local build, day 1 of the Oct 28–30 build window. Not yet published: the
public repo and the DEV post wait for the owner's own PC test and draft
approval, per the brief.
