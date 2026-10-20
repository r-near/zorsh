# Contributing

Install the global [Vite+ CLI](https://viteplus.dev/guide/), then run all JavaScript tooling through `vp`. `.node-version` pins Node.js 24.22.0; `package.json` pins pnpm 10.33.0 and Vite+ 1.3.0. `vp install --frozen-lockfile` installs the workspace without changing its lockfile. CI's setup-vp action uses the pinned managed Node runtime. Local system-first configuration (`VP_NODE_MANAGER=no`/`system_first`) can retain a different system runtime even through `vp env exec --node`; report the actual `process.version` used for local evidence. No global Node manager change is needed.

## Workspace

- `packages/zorsh`: the existing public package and its tests, snapshots, API documentation and changelog.
- `packages/effect`: private native Effect 4 schemas and Borsh primitive codecs. Read the current [official Effect v4 documentation](https://effect.website/docs/v4/) and the pinned package source before designing or reviewing its runtime.
- `rust/borsh_test`: independent Rust fixture generators, Cargo lockfile and committed Borsh vectors.
- `scripts/check-package.mjs`: checks the actual npm tarball after installing it into an isolated consumer workspace under ignored `.artifacts`.

The root and Effect package are private. Changesets uses independent package versions (`fixed` and `linked` are empty). Keep package-specific runtime dependencies with their package and shared development tools at the root.

## Checks

```sh
vp check
vp run check-effect-lint
vp test run
vp -C packages/zorsh pack
vp -C packages/effect pack
vp -C packages/zorsh pm pack -- --pack-destination ../../.artifacts
vp -C packages/effect pm pack -- --pack-destination ../../.artifacts
vp run check-package
vp run check-effect-package
vp exec changeset status
```

`vp check` checks formatting, lint and types without writing files. Use `vp check --fix` to apply fixes. The shared configuration enables both type-aware linting and TypeScript checks. `vp test run` includes V8 coverage and produces `coverage/lcov.info` for CI.

Effect diagnostics use the official Go-based [Effect language service](https://github.com/Effect-TS/tsgo) (`@effect/tsgo` 0.55.0) and its recommended Oxlint preset. The install lifecycle patches Vite+'s bundled Oxlint 1.88.0 and oxlint-tsgolint 7.0.2004; an unsupported version or failed patch fails installation. TypeScript 7.0.2 remains unpatched, and `vp check` remains the single formatting, lint and type check. Keep these tooling versions compatible when updating them; do not skip install scripts. See the [official Vite+ integration guide](https://effect.website/docs/v4/getting-started/devtools/#vite-plus).

`vp run check-effect-lint` runs isolated fixtures under ignored `.artifacts` using the shared configuration. It verifies that valid Effect code passes, a floating Effect fails with its specific diagnostic, and an ordinary TypeScript type error still fails. CI runs this smoke check after a frozen install. The root's development-only `effect` 4.0.5 dependency supplies these fixtures; the Effect package also pins its development version and declares Effect 4 as a peer.

`vp pack` builds the library with declarations; `vp pm pack` creates the real npm tarball. The consumer check requires that tarball, verifies its allowlisted contents and legacy entry paths, then exercises CommonJS, ESM named imports, deep imports, NodeNext and bundler type inference, and known Borsh bytes. Pass another tarball path to the script with `vp exec node scripts/check-package.mjs <path>`.

`vp run build` builds both packages. `vp run check-effect-package` checks the separate private Effect tarball's ESM exports, native transformations, NodeNext/Bundler inference and standalone browser bundle. It installs the actual artifact into an isolated consumer under `.artifacts`, including the pinned Effect peer. This is a browser bundling smoke check, not a browser automation test. The shared test/coverage configuration includes both packages. Keep the Effect package private at 0.0.0 during these initial slices; no release changeset is required for its private implementation.

Zorsh remains CommonJS with `dist/src/index.js` and `dist/src/index.d.ts`, and retains the `dist/src/*` deep entry paths. Do not add an `exports` map that restricts those paths or change the emitted module format as part of tooling work.

## Coverage policy

[`codecov.yml`](codecov.yml) sets explicit, separate project targets: `packages/zorsh/src/` remains at **100%**, and `packages/effect/src/` requires **95%**. Changed-code patch coverage also requires **95%**. Each target has **zero tolerance** (`threshold: 0%`). The automatic aggregate project target is disabled so the existing package's 100% baseline does not implicitly set the new package's policy. The required `lint-and-typecheck` and `tests` CI jobs are unchanged.

Codecov's [coverage calculation](https://docs.codecov.com/docs/about-code-coverage) treats branch-partial lines as non-hits; Vitest's line percentage can therefore be higher. LCOV partial-line accounting remains enabled, with no coverage ignores or exclusions added by this policy. Targets use the official [status configuration](https://docs.codecov.com/docs/commit-status) and [path prefixes](https://docs.codecov.com/docs/path-regexp).

The Effect target accommodates defensive branches that meaningful public-boundary tests cannot ordinarily reach. Current examples are the internal annotation helper's prior-layout conflict guard/throw (two lines), byte/string/boolean writer type guards (three lines), the >u32 byte-length guard/throw (two lines), and the unit type/length guard/throw (two lines). Native parsers reject ordinary type mismatches before the writer, current constructors attach layouts to fresh schemas, and exercising the large-byte guard requires more than 4 GiB of input or spoofing its properties. These nine lines are a current coverage snapshot, not permanent exemptions: they remain reported, and future behavior should receive meaningful tests. Do not replace this with implementation-mirroring tests, forced unreachable guards, or suppressed coverage.

## Commit hooks

Run `vp hooks enable` once in your clone. The tracked `.vite-hooks/pre-commit` runs `vp staged`, which applies `vp check --fix` to staged files. `vp hooks status` reports the local dispatcher. Generated dispatcher files are ignored.

## Rust compatibility

Regenerate all fixtures, including the generators marked `#[ignore]`, from the repository root:

```sh
cargo test --locked -j 1 --manifest-path rust/borsh_test/Cargo.toml -- --include-ignored
test -z "$(git status --porcelain --untracked-files=all -- rust/borsh_test/test_data)"
vp test run
```

On this development Mac, Cargo must resolve to the installed Mr Boxington shim. Check `command -v cargo` before the first build and use `mbx` if needed. Keep `-j 1`. CI uses the runner's Cargo. Default `cargo test` alone does not execute the ignored fixture generators. Review fixture changes intentionally; CI rejects unexpected drift.

## Releases

Use `vp exec changeset` to record a public package change. The release workflow can create Changesets version PRs while publishing is disabled. Its explicit version command is `vp run version-packages`.

Changesets uses monorepo tags such as `@zorsh/zorsh@X.Y.Z` for future releases, and each future public package will use its own `<package-name>@<version>` tags. Existing `vX.Y.Z` tags remain as historical release tags; no alias tags are added.

Npm publication is default-off: the release job runs only on `main` and supplies a publish command only when the repository variable `NPM_PUBLISH_ENABLED` is exactly the string `true`. The variable is currently `false`. Setting it alone triggers nothing; an intentional opt-in requires setting it to `true` and deliberately running the Release workflow manually **on `main`** after reviewing the package versions. Main-branch pushes matching the workflow paths can also trigger a release while enabled. Set the variable back to `false` when the release is complete. Never enable it as part of this workspace migration.

These controls apply to the updated workflow on `main`; they do not revoke npm publishing authority or change npm-side credentials. Older workflow revisions can have different behavior. Publishing uses the existing npm trusted publisher (OIDC).

Branch names use `feat/`, `fix/`, `docs/` or `chore/`. Every PR must receive an adversarial Sonnet 5.5 review before merge, in addition to its ordinary checks and review.
