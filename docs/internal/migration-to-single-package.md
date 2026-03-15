# Migration plan: monorepo -> single-package `message-chunker`

This document captures the agreed target state and the step-by-step migration plan for turning the current repository into a self-contained public package repository for `message-chunker`.

## Goal

End state:
- the repository itself is the package repository;
- the root `README.md` is the single canonical README;
- the package can be published to GitHub and npm;
- other projects can install it naturally via `npm install message-chunker`;
- local development remains simple and reliable.

## Target repository shape

```text
message-chunker/
  src/
    index.js
    normalizer.js
    parser.js
    planner.js
    renderer-html.js
    renderer-plain.js
    replan.js
    splitter.js
    types.js
  test/
    *.test.js
  docs/
    known-limitations.md
    rfc.md
    refactoring-sourcerange.md
    internal/
      migration-to-single-package.md
  .github/workflows/
    ci.yml
    publish.yml            # optional later
  package.json
  package-lock.json
  README.md
  LICENSE
  .gitignore
```

Things to remove from the public-facing structure:
- `packages/message-chunker/`
- root workspace / monorepo config
- duplicate README setup
- stale references to `packages/message-chunker/...`

## Guiding principle

After migration there should be one obvious explanation:

> This repository is the source repository of the npm package `message-chunker`.

## Current strengths worth preserving

- solid code quality
- strong automated test coverage
- `npm pack --dry-run` already works for the package
- modern ESM package layout
- good package-level README content to reuse as the root README

## Phase plan

### Phase A — Flatten the structure

Objective: make the package live at repository root.

Tasks:
1. Move `packages/message-chunker/src` -> `./src`
2. Move `packages/message-chunker/test` -> `./test`
3. Replace the current root `package.json` with the package `package.json`
4. Replace the current root `README.md` with the package README
5. Remove workspace / monorepo-specific config from root
6. Remove `packages/` once everything is migrated
7. Recreate `package-lock.json` for the single-package layout

Done when:
- running from repo root feels like running from the package root
- no essential code remains under `packages/message-chunker/`

### Phase B — Make `package.json` publishable

Objective: convert package metadata from local/private to public/publishable.

Required changes:
- remove `"private": true`
- keep or confirm `name: "message-chunker"` if available on npm
- decide first public version (`0.1.0` vs `1.0.0`)
- add strong `description`
- keep `type: "module"`
- keep `main` / `exports` aligned with root package layout
- ensure `files` includes only what should be published
- add `repository`
- add `homepage`
- add `bugs`
- expand/refine `keywords`
- consider `sideEffects: false`
- add `publishConfig` if useful

Recommended scripts:
- `test`: `node --test`
- `coverage`: `node --experimental-test-coverage --test`
- `pack:check`: `npm pack --dry-run`
- `prepublishOnly`: `npm test && npm run pack:check`

Note:
- prefer removing `.npmignore` unless it serves a clear purpose after migration
- rely on `files` in `package.json` where possible

### Phase C — Make the root README canonical

Objective: have one complete public README at repository root.

Recommended README sections:
1. What the library does
2. Why it exists / what problem it solves
3. Installation
4. Quick start
5. API overview
6. Strategy ladder / rendering modes
7. Replanning after reject
8. Limitations
9. Development
10. License

Important clarifications to include:
- package is ESM-only, if that remains the choice
- minimum Node.js version
- supported vs unsupported Markdown features
- `diagnostics.hadDegradation` semantics
- `rejectReason` contract
- transport-level errors are not part of the package contract

### Phase D — Clean the public face of the repository

Objective: keep root clean and professional for GitHub/npm users.

Keep in root only what is publicly useful:
- `README.md`
- `LICENSE`
- `package.json`
- `package-lock.json`
- `src/`
- `test/`
- `docs/`
- `.github/`
- `.gitignore`

Review current extra files such as:
- `issues.md`
- `missing-tests.md`
- `rfc_violations.md`
- `todo.md`
- backup files like `*~`, `*.bak`
- `commit_date.txt`

Possible actions:
- delete temporary artifacts
- move maintainer-only notes into `docs/internal/`
- keep only polished, intentionally public documentation in `docs/`

### Phase E — Sync documentation and internal links

Objective: remove references to old monorepo paths and concepts.

Tasks:
- replace `packages/message-chunker/src/...` with `src/...`
- replace `packages/message-chunker/test/...` with `test/...`
- remove mentions of `monorepo`, `workspace`, `workspaces` where no longer true
- verify README, docs, and notes stay coherent after the move

### Phase F — Add `LICENSE`

Objective: make licensing explicit for GitHub and npm.

Required:
- add a real `LICENSE` file matching the package metadata (`MIT`)

### Phase G — Add GitHub CI

Objective: make package quality visible and protect against regressions.

Minimum CI workflow:
- run on push and pull request
- test on Node.js 18 / 20 / 22
- run `npm ci`
- run `npm test`
- run `npm run pack:check`

Optional later:
- coverage reporting
- publish workflow

### Phase H — Release discipline

Objective: keep the first public release simple and reliable.

Good initial process:
- update version manually
- tag releases in git
- publish with `npm publish`

Optional later:
- `CHANGELOG.md`
- GitHub Releases
- automated publishing
- Changesets / release-please

## Important product decisions to make

### 1. ESM-only?

Recommended default: yes.

Reasoning:
- simpler package structure
- fewer compatibility branches
- aligned with current codebase
- suitable for modern Node.js consumers

If yes, state it clearly in README.

### 2. Publish from `src/` or `dist/`?

Recommended default: publish directly from `src/`.

Reasoning:
- no build step required today
- less release complexity
- easier debugging
- fewer moving parts

### 3. First public version?

Choices:
- `0.1.0` if API may still evolve noticeably
- `1.0.0` if contract is considered stable and semver-ready

Pragmatic recommendation:
- use `0.1.0` unless you are ready to make stronger compatibility promises

### 4. npm package name availability

Critical check before publication:
- confirm whether `message-chunker` is available on npm

Fallback if not available:
- scoped package, for example `@your-scope/message-chunker`

## Practical execution order

1. Flatten structure
2. Rewrite root `package.json`
3. Add `LICENSE`
4. Clean root and remove temporary artifacts
5. Sync docs and path references
6. Add GitHub Actions CI
7. Re-run validation from root
8. Check npm package-name availability
9. Publish repository to GitHub
10. Publish first npm release

## Validation checklist

Run successfully from repository root:
- `npm ci`
- `npm test`
- `npm run coverage`
- `npm pack --dry-run`

## Definition of done

- [ ] repository looks like a normal single-package repo
- [ ] one canonical root `README.md`
- [ ] no workspace / monorepo remnants in `package.json`
- [ ] package is not private
- [ ] `LICENSE` exists
- [ ] tests pass from root
- [ ] `npm pack --dry-run` passes from root
- [ ] README matches real installation workflow
- [ ] package metadata points to the GitHub repository
- [ ] package can be installed naturally in another project

## Recommended implementation style

Keep the migration conservative:
- do not add a build step unless necessary
- do not introduce TypeScript just for the migration
- do not add complex release automation yet
- do not add CommonJS support unless there is a real consumer need

Focus first on:
- clean structure
- correct package metadata
- strong README
- CI
- publishability

## Suggested way of working

Use this document as the master checklist and move phase by phase.
A good incremental approach is:
- complete one phase,
- validate,
- commit,
- continue to the next phase.

This keeps the migration understandable and reversible.
