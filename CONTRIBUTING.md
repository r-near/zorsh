# Contributing

Use [Vite+](https://viteplus.dev/guide/) for JavaScript tooling. `.node-version`, `package.json` and the workspace lockfile pin the tools. Run commands below from the repository root.

## Checks

```sh
vp install --frozen-lockfile
vp check
cargo +1.98.0 fmt --manifest-path rust/borsh-oracle/Cargo.toml --check
cargo +1.98.0 clippy --locked -j 1 --manifest-path rust/borsh-oracle/Cargo.toml --all-targets -- -D warnings
cargo +1.98.0 test --locked -j 1 --manifest-path rust/borsh-oracle/Cargo.toml
cargo test --locked -j 1 --manifest-path rust/borsh_test/Cargo.toml -- --include-ignored
vp run test-effect-differential
vp run test-package
vp test run
```

`test-effect-differential` builds the Rust oracle and Effect package before comparing them. `test-package` builds both packages, packs both public tarballs, and checks their consumers. Bare `vp test run` requires those artifacts and includes source coverage. Regenerating the legacy Rust fixtures must leave `rust/borsh_test/test_data` unchanged unless the fixture change is intentional.

`vp check` runs formatting, type-aware lint and TypeScript checks; `vp check --fix` applies fixes. The install lifecycle patches Oxlint with the official Go-based [Effect language service](https://effect.website/docs/v4/getting-started/devtools/#vite-plus); the root config enables its recommended preset. Keep the pinned tool versions compatible and do not skip install scripts.

On this Mac, check `command -v cargo` before building. Use the Mr Boxington Cargo shim or `mbx` explicitly. Keep `-j 1` and build targets inside the worktree. CI uses its installed Cargo. The oracle pins Rust 1.98.0; root commands select it explicitly because Rustup does not discover toolchains through `--manifest-path`.

The required CI jobs remain `lint-and-typecheck` and `tests`. Codecov requires 100% for `packages/zorsh/src`, 95% for `packages/effect/src`, and 95% for changed code, with zero tolerance. Do not suppress coverage to reach those targets.

## Style

`vp check` enforces the code style, configured in the root `vite.config.ts`. Formatting uses 2 spaces, double quotes, no semicolons and 100 columns. Imports are sorted with packages before relative paths. Every `if`, `else` and loop body takes braces. Lint also rejects nested ternaries, `else` after `return`, a lone `if` inside `else`, parameter reassignment, the comma operator and `==` other than `== null`. Beyond the rules, prefer guard clauses to nesting, name long conditions, and comment why, not what.

## Packages

- `packages/zorsh`: public `@zorsh/zorsh`, including the existing API and Rust fixture tests.
- `packages/effect`: public `@zorsh/effect`, Borsh codecs derived from native Effect 4 schemas. Read the pinned Effect source and [v4 docs](https://effect.website/docs/v4/) before changing schema behavior.
- `rust/borsh-oracle`: independent borsh-rs differential oracle. Add concrete Rust types, not a dynamic wire interpreter.

Keep Zorsh's CommonJS format, `dist/src` declarations and legacy deep entry paths compatible. Keep the Effect package ESM-only, with only its `.` and `./Borsh` entry points. Generated differential tests use native fast-check shrinking and replay; see their [instructions](packages/effect/test/differential/README.md). Coverage-guided testing remains separate work.

## Hooks and releases

Run `vp hooks enable` once to enable the tracked pre-commit hook. It runs `vp staged`, applying `vp check --fix` to staged files.

Use semantic branch prefixes: `feat/`, `fix/`, `docs/` or `chore/`. Every PR requires an adversarial Sonnet 5.5 review before merge, in addition to ordinary checks and review.

Changes to either public package, `@zorsh/zorsh` or `@zorsh/effect`, need a changeset from `vp exec changeset`. Packages have independent versions. Future release tags use `<package-name>@<version>`; historical `vX.Y.Z` tags remain unchanged.

Npm publication stays disabled. The release workflow supplies a publish command only when `NPM_PUBLISH_ENABLED` is exactly `true`, and runs only on `main`. With the variable `false`, merging changesets to `main` only opens or updates a "Version Packages" pull request, and merging that pull request publishes nothing. An authorized release requires reviewed package versions and an intentional workflow trigger, followed by restoring the variable to `false`. The workflow publishes through npm trusted publishing (OIDC) with no token.

npm only accepts a trusted publisher for a package that already exists, so `@zorsh/zorsh` has one and `@zorsh/effect` does not until a maintainer publishes it once by hand. Until `@zorsh/effect` has a trusted publisher, keep `NPM_PUBLISH_ENABLED` at `false` whenever one of its versions is unpublished: the workflow cannot authenticate for it, and `changeset publish` could release other packages and then fail partway. First publish of `@zorsh/effect`:

1. Merge the "Version Packages" pull request that sets `packages/effect/package.json` to `0.1.0`, with the variable still `false`. Check it bumps no other package unintentionally. CI runs for a pull request opened or updated by the workflow's token wait for approval: select **Approve workflows to run** in its merge box, or close and reopen it, and let the required checks pass before merging.
2. Wait for CI to pass on that `main` commit. From a clean checkout of it, run `vp install --frozen-lockfile` and `vp run test-package`.
3. As an npm owner of the `@zorsh` scope, with two-factor authentication, publish only this package from `packages/effect`: `npm publish --access public --dry-run`, check the file list, then `npm publish --access public`. Its `prepublishOnly` script rebuilds `dist`. Do not use `vp run release` or `changeset publish`, which publish every unpublished package version.
4. Check `npm view @zorsh/effect@0.1.0`, then tag the published commit: `git tag @zorsh/effect@0.1.0 && git push origin @zorsh/effect@0.1.0`. Optionally create its GitHub release from `packages/effect`: `gh release create @zorsh/effect@0.1.0 --verify-tag --latest=false --notes-file CHANGELOG.md`.
5. Confirm `gh variable get NPM_PUBLISH_ENABLED` prints `false`, and restore it if not.
6. Configure the trusted publisher when the next `@zorsh/effect` release is ready, no more than 2 days before enabling the gate for it: npm expires a new configuration that has not completed a publish within 2 days. On npmjs.com, open the `@zorsh/effect` settings and add a GitHub Actions trusted publisher: owner `r-near`, repository `zorsh`, workflow `release.yml`, no environment. Under allowed actions, also allow `npm publish`; new configurations allow only `npm stage publish` by default, and the workflow publishes directly. Optionally require two-factor authentication and disallow tokens. Then release through the ordinary gated workflow and restore the variable to `false`. If the configuration expires unused, delete and recreate it.
