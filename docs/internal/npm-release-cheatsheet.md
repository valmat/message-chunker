# npm release cheat sheet for `message-chunker`

Internal notes for future releases.

## What to remember

- npm packages are immutable by version.
- If `0.1.0` is already published, you cannot publish `0.1.0` again.
- Any change to code / README / package metadata requires a new version.

## Typical release flow

### 1. Make changes

Update code / tests / README / package metadata as needed.

### 2. Run local checks

```bash
npm test
npm run pack:check
```

Optional:

```bash
npm run coverage
```

### 3. Bump version in `package.json`

Choose the next version manually.

Examples:
- patch release: `0.1.0` -> `0.1.1`
- minor release: `0.1.1` -> `0.2.0`
- major release: `0.2.0` -> `1.0.0`

Current practical rule of thumb:
- patch = docs fixes / small fixes / non-breaking tweaks
- minor = new features / noticeable improvements
- major = breaking API or contract changes

### 4. Commit and push

Suggested order:
1. commit release changes
2. push branch
3. make sure GitHub CI is green on `master`

### 5. Confirm npm auth

```bash
npm whoami
```

Expected result: your npm username.

If needed:

```bash
npm login
```

### 6. Publish

From repository root:

```bash
npm publish
```

Because `publishConfig.access` is already set to `public`, the package should publish as a public package.

## Recommended release checklist

Before `npm publish`:
- [ ] `package.json` version updated
- [ ] tests pass
- [ ] `npm run pack:check` passes
- [ ] README is in good shape
- [ ] changes committed
- [ ] changes pushed
- [ ] CI green
- [ ] `npm whoami` works

## After publish

Check:
- npm package page exists
- README renders correctly on npm
- install works in a clean test project
- GitHub release/tag exists if you want a neat release trail

## Tagging / GitHub release

Typical manual flow:

```bash
git tag v0.1.1
git push origin v0.1.1
```

Then create a GitHub Release for that tag if desired.

## Updating README / description on npm

Important:
- npm does not auto-refresh from GitHub.
- npm shows the README and metadata from the published package tarball.
- To update npm package page content, publish a new version.

Examples:
- README changed -> publish `0.1.1`
- description changed -> publish `0.1.1`
- keywords changed -> publish `0.1.1`

## If you published a bad version

Important limits:
- you cannot overwrite an existing version
- for public packages, fix-forward is usually the right approach

Typical recovery:
1. fix the issue
2. bump version
3. publish the next version

Examples:
- bad `0.1.1` -> fix and publish `0.1.2`

If the broken version should warn users, you can later use `npm deprecate`, but that is an exceptional step, not the normal workflow.

## Minimal commands reminder

### Normal release

```bash
npm test
npm run pack:check
npm whoami
npm publish
```

### After changing version

```bash
git add .
git commit -m "release: v0.1.1"
git push
npm publish
git tag v0.1.1
git push origin v0.1.1
```

## Useful mental model

Think of npm release as:

1. prepare repo state
2. choose a new version
3. publish that exact snapshot forever

That is the main rule worth remembering.
