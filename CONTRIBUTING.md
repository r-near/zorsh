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

Changes to either public package, `@zorsh/zorsh` or `@zorsh/effect`, need a changeset from `vp exec changeset`. Packages have independent versions. Historical `vX.Y.Z` tags remain unchanged.

The release workflow runs on `main` for pushes that touch `.changeset/**` or the workflow, and on manual dispatch. Merging changesets opens or updates a "Version Packages" pull request; merging that pull request publishes the bumped packages to npm, pushes their `<package-name>@<version>` tags and creates their GitHub releases. CI runs for a pull request opened or updated by the workflow's token wait for approval: select **Approve workflows to run** in its merge box, or close and reopen it, and let the required checks pass before merging.

The workflow publishes through npm trusted publishing (OIDC) with no token. Both `@zorsh/zorsh` and `@zorsh/effect` trust `release.yml` in `r-near/zorsh`. To pause publishing, set the repository variable `NPM_PUBLISH_ENABLED` to anything other than `true`; the workflow then only manages the "Version Packages" pull request. Re-enabling it triggers nothing: run Release manually on `main` to publish versions merged while paused.

npm only accepts a trusted publisher for a package that already exists, so a new public package needs one manual publish. Pause publishing first, and merge its "Version Packages" pull request. As an npm owner of the `@zorsh` scope, from the package directory, run `npm publish --access public --dry-run`, check the file list, then `npm publish --access public`. Do not use `vp run release` or `changeset publish`, which publish every unpublished version. Tag the commit with `git tag <package-name>@<version> && git push origin <package-name>@<version>`, since a later workflow run does not tag it. Then add the trusted publisher with `npm trust github <package-name> --repo r-near/zorsh --file release.yml --allow-publish` and re-enable publishing. npm expires a trust configuration that has not completed a publish within 48 hours of creation; if a release fails to authenticate, check `npm trust list <package-name>` and recreate an expired configuration.
