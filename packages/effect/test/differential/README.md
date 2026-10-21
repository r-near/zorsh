# Borsh differential tests

From the repository root:

```sh
vp run test-effect-differential
```

Vitest compares built `@zorsh/effect` exports with the independent [borsh-rs oracle](../../../../rust/borsh-oracle/README.md). Value and raw-byte properties cover 18 primitive IDs, with 1,000 generated cases each, seed 20261020, and explicit edge/malformed/boundary cases. Tests compare independently encoded bytes, cross-decoded values, acceptance, canonical re-encoding, ownership and reuse after rejection. Container properties cover structs, tuples, vectors, fixed arrays, tagged enums, Options and Results, with 300 value and 300 raw/mutated-frame cases each. Native sets cover signed integer, bigint, boolean and Unicode ordering; maps cover `u16` keys and `String` values. Each native adapter has 200 value and 200 canonical-frame mutation cases: unchanged frames, swapped/duplicate entries, count changes and key-byte changes. Explicit cases check every tag, zero-sized visitation and malicious vector counts. Coverage-guided testing is separate work.

Fast-check failures print the counterexample, seed and shrink path. Select the failing Vitest test and pass those parameters to replay it:

```sh
ZORSH_DIFFERENTIAL_SEED=20261020 ZORSH_DIFFERENTIAL_PATH=0:0 vp test run packages/effect/test/differential/primitives.test.ts -t 'borsh-rs u16 > values' --coverage.enabled=false
```

`ZORSH_DIFFERENTIAL_RUNS` changes the bounded run count; `ZORSH_BORSH_ORACLE` selects another executable. Paths resolve relative to the caller; the default binary path resolves from the test file. Rebuild artifacts after source changes. Bare `vp test run` uses existing builds.

One sequential child handles requests with a three-second deadline, bounded frames and stderr, and checked shutdown. Only `borsh_rejection` is a format rejection; other errors fail the test. Infrastructure failure interrupts shrinking and retains any earlier codec counterexample. Asynchronous process output identifies the active operation, not necessarily the input that caused it. The focused regression proves real Rust byte mismatches shrink and replay.
