# Fixed-type borsh-rs differential oracle

This independent test executable is the Rust side of future Effect 4 Borsh
differential checks. It registers **39 concrete Rust types**. Each accepted encode reaches
`borsh::to_vec::<T>`; each decode reaches `borsh::from_slice::<T>`, including its
trailing-byte rejection. Structs/enums use the actual Borsh derives and collections
use standard Rust types. There is no schema input, schema extraction, contract
introspection, dynamic wire interpreter, or hand-written Borsh implementation.

The encoder first runs `borsh::object_length` through Borsh's own serializer to
reject outputs exceeding the raw-byte envelope before allocating a byte buffer.
Borsh errors from that pass (including NaN and visited `Vec<ZST>`) are Borsh
rejections. Successful values then run `to_vec`, and both operations normalize
transport values from the resulting concrete Rust value.

The oracle is a test executable, not a public library API. Preserve Cargo.lock
when integrating. `borsh = "=1.8.1"`, features `derive` and `de_strict_order`, is
intentional. The committed Cargo.lock pins the complete dependency graph. The existing [borsh 1.5.5 fixture crate](../borsh_test) remains independent.

Official source references:

- [borsh 1.8.1 features](https://docs.rs/crate/borsh/1.8.1/features)
- [derive discriminant annotation](https://docs.rs/borsh/1.8.1/borsh/derive.BorshSerialize.html#2-borshuse_discriminantbool-item-level-attribute)
- [Borsh deserializer source, including strict ordering](https://docs.rs/borsh/1.8.1/src/borsh/de/mod.rs.html)

## Build and validation

The commands below run from `rust/borsh-oracle`. On this Mac, check
`command -v cargo` first. It must resolve to
`/Users/ricky/Library/Application Support/mbx/bin/cargo`, or use `mbx` explicitly.
Keep the target in the crate directory and retain `-j 1`:

```sh
CARGO_TARGET_DIR="$PWD/target" cargo build --locked -j 1
CARGO_TARGET_DIR="$PWD/target" cargo test --locked -j 1
cargo fmt --check
CARGO_TARGET_DIR="$PWD/target" cargo clippy --locked -j 1 --all-targets -- -D warnings
./target/debug/zorsh-borsh-oracle
```

Do not launch `cargo run` as the long-lived oracle from a JS harness. Build first,
then launch the binary directly to avoid build output and startup variability.
The binary emits no startup output and flushes one response for each input frame.

CI runs rustfmt and Clippy with warnings denied in `lint-and-typecheck`, and
`cargo test --locked -j 1` in `tests`. These remain the existing required job
names. CI uses the runner's installed Rust tooling and caches both independent
Rust crate directories; it still regenerates the legacy fixtures, checks drift,
and runs both TypeScript packages' full tests and coverage.

The 22 Rust tests consist of eight concrete-type conformance tests, four proptest
properties (256 cases each, seed 20261020), and ten protocol/process tests.
They cover exact bytes and rejection cases, bounded framing, process persistence,
and nonzero exit on a broken output pipe. CLI test children have a five-second
lifetime deadline covering pipe I/O and exit. A supervisor owns each child, kills
and reaps it on timeout, and performs the same cleanup when a test unwinds or
returns early. Unix fixtures that stop responding or never exit verify timeout
errors within three seconds using shorter 200/500 ms deadlines; an early-panic
fixture verifies prompt reaping. These are direct-child tests on macOS/Linux,
without descendant processes retaining the pipes. They establish behavior of the
Rust oracle transport and registered types. **TypeScript differential checks and
coverage-guided fuzzing have not been implemented or run in this slice**; those
are follow-up harness work. No Miri/concurrency/formal tools are added: the
production oracle has no unsafe, FFI or concurrency and makes no theorem or
performance claim.

## Protocol version 1

UTF-8 NDJSON over stdin/stdout, persistent sequential requests. LF terminates a
frame; a final nonempty frame at EOF is also processed. CR before LF is JSON
whitespace. Empty lines are protocol errors. All JSON object keys must be unique,
including keys inside transported values. Invalid UTF-8, lone JSON surrogates,
excessive JSON nesting and extra request fields are protocol errors. Valid
surrogate pairs represent ordinary Unicode strings. There is no BOM stripping
inside string values.

Exactly five request fields:

```json
{"protocolVersion":1,"id":"carry","schemaId":"u128","operation":"encode","value":"18446744073709551616"}
{"protocolVersion":1,"id":"carry-decode","schemaId":"u128","operation":"decode","hex":"00000000000000000100000000000000"}
```

Encode requires `value`; decode requires `hex`. Supplying both is a protocol
error. `protocolVersion` must be the JSON integer `1`, not a string or `1.0`.
`id` is any string up to 128 UTF-8 bytes, including the empty string; the harness
is responsible for choosing unique IDs. `schemaId` is a string up to 64 UTF-8
bytes matching the registry below. `operation` is `encode` or `decode`.

Both successful operations return exactly the same shape, with the operation and
ID from the request. `value` is the canonical transport value and `hex` is the
exact encoded bytes (the input bytes on successful decode):

```json
{"protocolVersion":1,"id":"carry","ok":true,"schemaId":"u128","operation":"encode","value":"18446744073709551616","hex":"00000000000000000100000000000000"}
```

Object field order is not a protocol contract. Each response occupies one line.

```json
{"protocolVersion":1,"id":"bad-bool","ok":false,"error":{"kind":"borsh_rejection","message":"Invalid bool representation: 2"}}
```

`message` is diagnostic text, **not stable comparison data**; borsh-rs owns its
wording. Error categories are stable:

| `error.kind` | Meaning | Equivalent to JS codec rejection? |
| --- | --- | --- |
| `borsh_rejection` | A real Borsh serialize/deserialize call returned an error | Yes, if testing the same registered type within the envelope |
| `transport` | JSON value/hex does not represent the requested concrete Rust value | No |
| `protocol` | Invalid JSON/request shape/version | No |
| `unknown_schema` | Valid-shaped request refers to an unregistered schema ID | No |
| `unknown_operation` | Request operation is not encode/decode | No |
| `resource_limit` | Oracle envelope exceeded | No; exclude or classify the case separately |

Malformed JSON, oversized input frames and invalid/oversized IDs return `id:null`.
Other failures preserve a valid bounded ID when it can be recovered. The process
continues after request errors. Oversized input lines are drained to LF before
reading the next request, with one resource response for that line. I/O failures
(including a broken stdout pipe) print a diagnostic on stderr and exit nonzero.
Panics are not caught or relabeled; a crash/exit/timeout/missing response is a
harness failure, never a codec rejection.

## Transport values

- All integer widths: decimal **strings**, including u8/u16. No JSON numbers,
  whitespace, `+`, exponent notation, or separators. Leading zeros are accepted;
  output uses canonical decimal. A leading `-` is accepted for signed integers;
  signed `-0` normalizes to `0`. Integer strings are capped at 40 bytes and must
  fit the concrete Rust type; invalid values are transport errors.
- bool: JSON boolean. String: ordinary JSON Unicode string, encoded as UTF-8 by
  Rust/Borsh. Unit `()`: JSON null.
- f32: `{"bits":"80000000"}`; f64:
  `{"bits":"8000000000000000"}`. Fixed-width hexadecimal bit **patterns** in
  ordinary numeric order (not wire-byte order), no prefix. Uppercase accepted;
  output lowercase. `from_bits`/`to_bits` preserve signed zero, infinities,
  subnormals, and all NaN payloads. NaN bit patterns are valid transport, then
  **Borsh rejects them** in both directions. No decimal float conversion occurs.
- Bytes (`bytes`, `bytes32`, `bytes0`): unprefixed even ASCII hex strings.
  Uppercase accepted, normalized lowercase. No whitespace. Fixed arrays require
  the exact byte count. For `vec_bytes0`, each item is an empty hex string.
- Option: `{"tag":"None"}` or `{"tag":"Some","value":...}` with exactly those
  fields. Nested options remain distinct: `Some(None)` is
  `{"tag":"Some","value":{"tag":"None"}}`; null does not encode None.
- Non-byte arrays, sequences and tuples: JSON arrays, exact fixed lengths where
  applicable. Integers inside remain strings. Empty named struct `Empty {}`: `{}`.
- Struct: exact named fields, no extras; declaration order below owns wire order.
- Enum: exactly `{"variant":"Count","value":"513"}` or another named variant.
  Unit variant Idle has `value:null`; Named has
  `value:{"label":"x","enabled":true}`. Rust's derive owns the tags.
- Map: pair array `[["256","b"],["1","a"]]`; output sorted by Rust `u16::Ord`
  as `[["1","a"],["256","b"]]`. Set: string array; output sorted by Rust
  `String::Ord`. Duplicate keys/items, including numerically equal `"01"`/`"1"`,
  are transport errors rather than silent collection collapse.

Map/set decode deliberately enables **`de_strict_order`**: unsorted or duplicate
wire keys/items are Borsh rejections. Borsh builds without that feature can accept
and normalize those same bytes. A JS compiler/harness must target this strict
policy explicitly; it must not treat permissive Rust decoding as the same oracle.
Rust ordering here is value ordering, not lexicographic encoded little-endian
bytes (`1` sorts before `256`). No float-key schemas are registered.

## Fixed schema registry

No names/types are supplied by the TypeScript compiler. An extension must add a
concrete Rust type and transport conversion plus exact-byte/invalid-input cases.

| Schema ID | Exact concrete Rust type |
| --- | --- |
| `bool` | `bool` |
| `u8`, `u16`, `u32`, `u64`, `u128` | Corresponding Rust unsigned integer |
| `i8`, `i16`, `i32`, `i64`, `i128` | Corresponding Rust signed integer |
| `f32`, `f64` | Corresponding Rust IEEE float |
| `string` | `String` |
| `unit` | `()` |
| `bytes` | `Vec<u8>` |
| `bytes32` | `[u8; 32]` |
| `bytes0` | `[u8; 0]` |
| `vec_u16` | `Vec<u16>` |
| `tuple_u8_u128` | `(u8, u128)` |
| `option_u128` | `Option<u128>` |
| `option_option_u8` | `Option<Option<u8>>` |
| `array_u16_3` | `[u16; 3]` |
| `storage_deposit` | `StorageDeposit { token_id: String, account_id: String, storage_deposit_amount: Option<u128> }` |
| `explicit_enum` | Derived `#[repr(u8)] #[borsh(use_discriminant = true)] enum ExplicitEnum { Idle = 3, Count(u16) = 17, Named { label: String, enabled: bool } = 250 }` |
| `map_u16_string` | `std::collections::BTreeMap<u16, String>` |
| `set_string` | `std::collections::BTreeSet<String>` |
| `empty` | Derived `struct Empty {}` |
| `tuple_unit` | `((),)` |
| `array_unit_0` | `[(); 0]` |
| `array_unit_1` | `[(); 1]` |
| `vec_unit` | `Vec<()>` |
| `vec_empty` | `Vec<Empty>` |
| `vec_bytes0` | `Vec<[u8; 0]>` |
| `vec_vec_unit` | `Vec<Vec<()>>` |
| `array_vec_unit_0` | `[Vec<()>; 0]` |
| `array_vec_unit_1` | `[Vec<()>; 1]` |
| `option_unit` | `Option<()>` |
| `vec_option_unit` | `Vec<Option<()>>` |

Zero-sized visitation is observable: unit, Empty, `((),)`, `[();0]`, `[();1]` and
`[u8;0]` accept empty bytes. `Vec<()>`, `Vec<Empty>` and `Vec<[u8;0]>` reject even
empty vectors. An empty `Vec<Vec<()>>` accepts, but a nonempty outer vector visits
and rejects its inner vector. `[Vec<()>;0]` accepts without visiting an item;
`[Vec<()>;1]` rejects. `Option<()>` and `Vec<Option<()>>` accept. Therefore a TS
compiler must model visit-time failures rather than reject every schema that
contains a zero-sized vector somewhere.

## Resource envelope and harness obligations

- Input frame: at most **1,048,576 bytes**, excluding LF. A bounded reader checks
  before appending; it never retains an oversized line's full body. JSON parsing
  occurs only after that check. Serde's default JSON recursion guard is retained.
- Output frame: at most **1,048,576 bytes**, excluding LF. If a normalized success
  response would exceed it, the process sends a bounded resource error instead.
- Raw Borsh data: at most **65,536 bytes** on encode and decode. Hex length is
  checked before decoding/allocating raw bytes. Encode uses Borsh's counting
  serializer to check size before `to_vec` allocation.
- Concrete Rust `String` values: at most **65,536 UTF-8 bytes** each. Hex strings
  use two ASCII characters per raw byte, up to **131,072 characters**.
- Transport arrays: at most **16,384 items each on encode**; fixed arrays also
  require exact length. These checks follow bounded JSON parsing, not a streaming
  allocation-free parser.
  Decode uses real Borsh types and can produce more than 16,384 values within the
  raw cap (e.g. `Vec<Option<()>>`); the output-frame cap still applies.
- ID/schema byte limits are 128/64, respectively. Transport floats are fixed width;
  decimal integer strings are capped at 40 bytes.

These are operational limits, **not a hard process RSS or CPU bound**. Borsh,
Serde, JSON normalization and output serialization allocate before the output cap
is checked. The registry is finite with bounded nesting, and borsh-rs rejects
visited zero-sized vectors; byte caps alone would not constrain arbitrary
zero-sized types. Future harnesses must enforce child memory limits, per-request
watchdogs, bounded stdout/stderr capture, and process cleanup. A line without LF
can keep draining until EOF; the external watchdog owns that liveness boundary.
Do not add dynamic/unbounded schemas and assume the current envelope suffices.

A future JS driver must check response version, ID, success/error shape, and
expected operation/schema; normalize integer/bit/byte transport without losing
precision; compare both bytes and normalized values; and preserve minimized
counterexamples, seeds, versions and the oracle binary/source identity. It must
separately score protocol/transport/resource/process failures. Negative controls
must show that corrupted codecs are caught. Property generation, cross-language
comparison and coverage-guided campaigns belong to that harness; the Rust tests
in this crate alone establish none of those cross-language claims.

## Verification ownership

Borsh derives and standard implementations own wire semantics. Transport
conversion owns JSON precision, value validation and canonical normalization.
The protocol module owns framing, error classification and stream persistence.
Rust exact/property/process tests exercise those boundaries. Future compiler
changes must add cross-language conformance evidence; these Rust tests alone do
not validate a TypeScript implementation. Changes to registry types, wire policy,
transport normalization or limits must update this contract and the Rust tests.

Verification impact: deterministic Rust behavior, protocol semantics and the
property/fuzz surface. There is no concurrent, persistence, unsafe or theorem
model to update. See the repository [contribution guidance](../../CONTRIBUTING.md).
