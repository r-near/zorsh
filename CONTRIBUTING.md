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

`test-effect-differential` builds the Rust oracle and Effect package before comparing them. `test-package` builds both packages, packs the public tarball, and checks its consumers. Bare `vp test run` requires those artifacts and includes source coverage. Regenerating the legacy Rust fixtures must leave `rust/borsh_test/test_data` unchanged unless the fixture change is intentional.

`vp check` runs formatting, type-aware lint and TypeScript checks; `vp check --fix` applies fixes. The install lifecycle patches Oxlint with the official Go-based [Effect language service](https://effect.website/docs/v4/getting-started/devtools/#vite-plus); the root config enables its recommended preset. Keep the pinned tool versions compatible and do not skip install scripts.

On this Mac, check `command -v cargo` before building. Use the Mr Boxington Cargo shim or `mbx` explicitly. Keep `-j 1` and build targets inside the worktree. CI uses its installed Cargo. The oracle pins Rust 1.98.0; root commands select it explicitly because Rustup does not discover toolchains through `--manifest-path`.

The required CI jobs remain `lint-and-typecheck` and `tests`. Codecov requires 100% for `packages/zorsh/src`, 95% for `packages/effect/src`, and 95% for changed code, with zero tolerance. Do not suppress coverage to reach those targets.

## Packages

- `packages/zorsh`: public `@zorsh/zorsh`, including the existing API and Rust fixture tests.
- `packages/effect`: private native Effect 4 codecs. Read the pinned Effect source and [v4 docs](https://effect.website/docs/v4/) before changing schema behavior.
- `rust/borsh-oracle`: independent borsh-rs differential oracle. Add concrete Rust types, not a dynamic wire interpreter.

Keep Zorsh's CommonJS format, `dist/src` declarations and legacy deep entry paths compatible. The Effect package stays private at 0.0.0. Generated differential tests use native fast-check shrinking and replay; see their [instructions](packages/effect/test/differential/README.md). Coverage-guided testing remains separate work.

## Hooks and releases

Run `vp hooks enable` once to enable the tracked pre-commit hook. It runs `vp staged`, applying `vp check --fix` to staged files.

Use semantic branch prefixes: `feat/`, `fix/`, `docs/` or `chore/`. Every PR requires an adversarial Sonnet 5.5 review before merge, in addition to ordinary checks and review.

Public package changes use `vp exec changeset`. Packages have independent versions; private Effect implementation changes need no release changeset. Future release tags use `<package-name>@<version>`; historical `vX.Y.Z` tags remain unchanged.

Npm publication stays disabled. The release workflow supplies a publish command only when `NPM_PUBLISH_ENABLED` is exactly `true`, and runs only on `main`. The variable is currently `false`; do not enable it during this migration. An authorized release requires reviewed package versions and an intentional workflow trigger, followed by restoring the variable to `false`. Publishing uses npm's existing trusted publisher.
