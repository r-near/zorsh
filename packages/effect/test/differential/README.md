# Primitive differential tests

These tests compare the private package's built public `@zorsh/effect` exports,
using native `Borsh.toCodec` and Effect Schema operations, against concrete Rust
types serialized by **borsh 1.8.1**. The [oracle](../../../../rust/borsh-oracle/README.md)
is independent of the TypeScript implementation. No production code is patched.

Run from the repository root after `vp install --frozen-lockfile`:

```sh
command -v cargo
CARGO_TARGET_DIR="$PWD/rust/borsh-oracle/target" cargo +1.98.0 build --manifest-path rust/borsh-oracle/Cargo.toml --locked -j 1
vp -C packages/effect pack
vp run test-effect-differential
```

On this Mac, Cargo must resolve to the mbx shim (or a configured mise wrapper);
otherwise use `mbx +1.98.0 build` with the same arguments. Build again after any
codec/oracle changes: the harness deliberately imports `dist` through package
exports. Missing build artifacts fail; tests never silently skip. macOS and Linux
with `/bin/ps` are supported. CI uses the pinned Node version in `.node-version`.

The focused command disables source coverage because it exercises built exports.
The default full `vp test run` also discovers both `.test.mjs` files, alongside
the existing TypeScript tests. CI builds both prerequisites first, runs the full
suite with source coverage, and uploads `.artifacts/primitive-differential` on
failure. Source coverage thresholds remain separate and unchanged.

The default campaign runs **36 fast-check properties** (value/raw for 18 IDs),
**1,000 inputs per property**, seed **20261020**, plus **487 deterministic cases**.
IDs are bool; u8/u16/u32/u64/u128; i8/i16/i32/i64/i128; f32/f64; string; bytes;
bytes32; bytes0; and unit. Assertions cover independent encoded bytes,
cross-decoding and normalized values, raw acceptance/value parity, canonical
re-encoding, prefixes/suffixes, immutable inputs, owned outputs, nonzero offsets,
and reuse after rejection. Floats include signed zero, infinities, subnormals and
NaN rejection; Unicode includes supplementary scalars, BOM, malformed UTF-8 and
explicit lone-surrogate rejection. Deterministic string/byte cases reach the
shared 65,536-byte binary envelope. Out-of-envelope suffixes are checked only in
TypeScript and are never counted as Rust format rejections.

Only Rust `borsh_rejection` matches an Effect `SchemaError`. Protocol, transport,
resource, timeout and crash failures fail the harness. The toy child tests client
failure handling only; it never supplies expected Borsh bytes or values.

One persistent sequential child serves each campaign. Requests have 3-second
deadlines; stdout frames are capped at 1 MiB and captured stderr at 64 KiB. RSS is
sampled every 100 ms with one bounded `/bin/ps` observation at a time (500 ms
deadline, 1 KiB output). A sample above 128 MiB or failed observation fails the
session. This watchdog is **not a hard OS memory sandbox** and can miss short
peaks. Cleanup sends SIGTERM, escalates to SIGKILL after 250 ms, awaits child close
and finishes the active observation. The client uses native JSON parsing for the
owned fixed executable, not a hostile-service JSON parser.

## Replay and negative controls

Run a different seed or a focused schema/family with the standalone runner:

```sh
vp exec node packages/effect/test/differential/run.mjs --runs 1000 --seed 20261020
```

Options are `--oracle`, `--output`, `--runs`, `--seed`, `--schema`, `--family`
(`value`/`raw`) and `--path`. Replay paths require both schema and family. The
Vitest boundary also accepts `ZORSH_BORSH_ORACLE`, `ZORSH_DIFFERENTIAL_OUTPUT`,
`ZORSH_DIFFERENTIAL_RUNS` and `ZORSH_DIFFERENTIAL_SEED`.

Run/failure JSON under the ignored `.artifacts/primitive-differential` includes
concrete minimized transport/raw hex, seed, shrink path, exact replay argv,
actual Node/dependency versions, executable SHA256 and built codec JS hashes.
Use the recorded replay command with matching artifacts to reproduce a failure.

Two controlled test adapters prove mismatch detection and actual shrinking:

```sh
vp exec node packages/effect/test/differential/run.mjs --schema u16 --family value --runs 1000 --seed 20261020 --mutation encoded-bitflip --output .artifacts/primitive-differential/proof-encode
vp exec node packages/effect/test/differential/run.mjs --schema u16 --family raw --runs 1000 --seed 20261020 --mutation decoded-value --output .artifacts/primitive-differential/proof-value
```

Both must exit 1 with the intended assertion. At this seed, encoded bytes shrink
to value `"0"`, prefix selector 0, suffix `"00"`, path `0:0:0:0:0:0`; decoded
value mismatch shrinks to raw `0000`, path `1:0:0`. Run each failure's recorded
replay command: it must reproduce the minimized assertion without further
shrinking. Remove only `--mutation ...` and the same replay must pass. Mutations
are limited to those two u16 adapters and do not change package/oracle files.

These are bounded property-based differential campaigns with shrinking, not
coverage-guided fuzzing or proof of parity for future container schemas.
