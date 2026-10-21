# Zorsh

A TypeScript workspace for Borsh binary serialization.

| Package                            | Status                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| [`@zorsh/zorsh`](packages/zorsh)   | Existing Zod-like API, version 0.5.2. See its README for installation and API examples.   |
| [`@zorsh/effect`](packages/effect) | Private 0.0.0 native Effect 4 Borsh primitive codecs. Containers are not implemented yet. |

The private root owns shared tooling. Packages have independent versions; adding an Effect implementation does not require changing the existing Zorsh API. Rust compatibility generators and their committed fixtures live in `rust/borsh_test`.

Development uses [Vite+](https://viteplus.dev/guide/), pinned Node.js and pnpm, and one workspace lockfile. Start with:

```sh
vp install --frozen-lockfile
vp check
vp run test-effect-differential
vp run test-package
vp test run
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for hooks, package verification, Rust compatibility, and the default-off release gate.
