# Contributing

Install the global [Vite+ CLI](https://viteplus.dev/guide/), then run all JavaScript tooling through `vp`. `.node-version` pins Node.js 24.22.0; `package.json` pins pnpm 10.33.0 and Vite+ 1.3.0. `vp install --frozen-lockfile` installs the workspace without changing its lockfile. No global Node manager change is needed. When another Node manager controls your PATH, use `vp env exec --node 24.22.0 vp <command>` to explicitly select the pinned runtime.

## Workspace

- `packages/zorsh`: the existing public package and its tests, snapshots, API documentation and changelog.
- `packages/effect`: a private placeholder with no implementation. Read the current [official Effect documentation](https://effect.website/docs/) before designing or reviewing its future runtime.
- `rust/borsh_test`: independent Rust fixture generators, Cargo lockfile and committed Borsh vectors.
- `scripts/check-package.mjs`: checks the actual npm tarball after installing it into an isolated consumer workspace under ignored `.artifacts`.

The root and Effect package are private. Changesets uses independent package versions (`fixed` and `linked` are empty). Keep package-specific runtime dependencies with their package and shared development tools at the root.

## Checks

```sh
vp check
vp test run
vp -C packages/zorsh pack
vp -C packages/zorsh pm pack -- --pack-destination ../../.artifacts
vp run check-package
vp exec changeset status
```

`vp check` checks formatting, lint and types without writing files. Use `vp check --fix` to apply fixes. The shared configuration enables both type-aware linting and TypeScript checks. `vp test run` includes V8 coverage and produces `coverage/lcov.info` for CI.

`vp pack` builds the library with declarations; `vp pm pack` creates the real npm tarball. The consumer check requires that tarball, verifies its allowlisted contents and legacy entry paths, then exercises CommonJS, ESM named imports, deep imports, NodeNext and bundler type inference, and known Borsh bytes. Pass another tarball path to the script with `vp exec node scripts/check-package.mjs <path>`.

Zorsh remains CommonJS with `dist/src/index.js` and `dist/src/index.d.ts`, and retains the `dist/src/*` deep entry paths. Do not add an `exports` map that restricts those paths or change the emitted module format as part of tooling work.

## Commit hooks

Run `vp hooks enable` once in your clone. The tracked `.vite-hooks/pre-commit` runs `vp staged`, which applies `vp check --fix` to staged files. `vp hooks status` reports the local dispatcher. Generated dispatcher files are ignored.

## Rust compatibility

Regenerate all fixtures, including the generators marked `#[ignore]`, from the repository root:

```sh
cargo test --locked -j 1 --manifest-path rust/borsh_test/Cargo.toml -- --include-ignored
git diff --exit-code -- rust/borsh_test/test_data
vp test run
```

On this development Mac, Cargo must resolve to the installed Mr Boxington shim. Check `command -v cargo` before the first build and use `mbx` if needed. Keep `-j 1`. CI uses the runner's Cargo. Default `cargo test` alone does not execute the ignored fixture generators. Review fixture changes intentionally; CI rejects unexpected drift.

## Releases

Use `vp exec changeset` to record a public package change. The release workflow can create Changesets version PRs while publishing is disabled. Its explicit version command is `vp run version-packages`.

Npm publication is default-off: the workflow supplies a publish command only when the repository variable `NPM_PUBLISH_ENABLED` is exactly the string `true`. This guard applies to both main-branch pushes and manual workflow dispatch. The variable is currently `false`; changing it is a separate release decision. Never enable it as part of this workspace migration. Publishing uses the existing npm trusted publisher (OIDC).

Branch names use `feat/`, `fix/`, `docs/` or `chore/`. Every PR must receive an adversarial Sonnet 5.5 review before merge, in addition to its ordinary checks and review.
