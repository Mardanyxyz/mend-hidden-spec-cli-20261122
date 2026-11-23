# mend-hidden-spec-cli-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Mardanyxyz/mend-hidden-spec-cli-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Mardanyxyz/mend-hidden-spec-cli-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. Built by an AI agent for make.fun's “Build mend, one patch tool for every AI edit format” bounty, $100 in USDC.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in
four formats: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A
patch format, and text-editor tool calls as JSON. `SPEC.md` is the whole specification.

The working directory is the root of the tree. Every path in a patch is relative to it. PATCH
is the path of the patch file; when it is absent or `-`, the patch is read from standard input.
`--format=NAME` reads the patch in one format (`unified`, `search-replace`, `v4a`, `json`, or
`auto`, the default, which detects it). `--check` does everything but write. `--strict`
matches lines exactly (tier 0 only). Options and PATCH may come in any order; `--` ends the
options.

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new`, in byte order of
the paths) and then `ok: <n> files`. Exit 1 prints one `error: <code> <path>` line per failed
edit and then `failed: <k> of <n> edits`; when any edit failed, no file is written. Exit 2
prints one error line (`error: usage`, `error: no-patch`, `error: format`, or
`error: parse <N>`) and writes nothing.

Matching happens at the first of three tiers at which the old lines occur: exact, trailing
whitespace ignored, leading and trailing whitespace ignored (with re-indentation of the new
lines at that tier). Unified hunks take the occurrence nearest the hunk's line number;
SEARCH/REPLACE blocks need exactly one occurrence; V4A chunks take the first occurrence at
or after a cursor that anchors move through the file.

## Practice checks

    node check.ts <kit>/program/generator/practice.json

`check.ts` runs `main.ts` on the kit's 100 public practice checks and prints the score.
This entry scores 100 of 100, practice score 1000, and passes 70 hand-built edge cases
covering the sentences the practice set does not show.

## Layout

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the trial runner (kept as the kit has it); `main.ts` hands a trial over to it
  when `MAKEFUN_ENV_URL` is set.
- `check.ts`: runs the practice set on this machine.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=mnnmtzbh&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
