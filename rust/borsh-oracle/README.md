# borsh-rs oracle

Independent test executable using pinned borsh 1.8.1 with `derive` and `de_strict_order`. The registry contains 43 concrete Rust types; Borsh derives and standard implementations own wire encoding. Each encode checks `borsh::object_length` before `borsh::to_vec`; decode uses `borsh::from_slice`, including trailing-byte rejection. Keep Cargo.lock. The older `rust/borsh_test` fixture source remains independent.

Build and test from the repository root:

```sh
cargo +1.98.0 build --locked -j 1 --manifest-path rust/borsh-oracle/Cargo.toml
cargo +1.98.0 test --locked -j 1 --manifest-path rust/borsh-oracle/Cargo.toml
```

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for lint/toolchain checks and the [TypeScript differential tests](../../packages/effect/test/differential/README.md) for cross-language comparisons. Launch the built executable directly, not `cargo run`.

## Protocol

Sequential UTF-8 NDJSON on stdin/stdout, one response per request. EOF also terminates a final nonempty frame. Duplicate keys, invalid UTF-8/surrogates and extra fields are protocol errors. Requests contain exactly `protocolVersion: 1` (JSON integer), `id`, `schemaId`, `operation` and either `value` for encode or `hex` for decode:

```json
{"protocolVersion":1,"id":"1","schemaId":"u16","operation":"encode","value":"513"}
{"protocolVersion":1,"id":"1","ok":true,"schemaId":"u16","operation":"encode","value":"513","hex":"0102"}
{"protocolVersion":1,"id":"2","ok":false,"error":{"kind":"borsh_rejection","message":"diagnostic text"}}
```

Successful operations return canonical transport values and exact bytes. Field order and error wording are irrelevant. Only `borsh_rejection` represents invalid Borsh. `transport`, `protocol`, `unknown_schema`, `unknown_operation`, `resource_limit`, process failures and timeouts are infrastructure failures. Request errors preserve a recoverable bounded ID; otherwise it is null. Oversized lines drain through LF. I/O failure exits nonzero.

Frames are limited to 1 MiB excluding LF; CR in CRLF counts. Raw Borsh data and each transported String are limited to 65,536 bytes; encode arrays to 16,384 items. IDs/schema IDs are limited to 128/64 UTF-8 bytes. Output expansion can hit the frame cap after normalization. These limits are not a hard process memory bound; drivers also need deadlines, bounded output and cleanup.

## Transport

- Integers are bounded decimal strings, never JSON numbers; output is canonical decimal. Leading zeros and signed negative zero normalize. No whitespace, plus, exponent or separators; maximum 40 bytes.
- Floats are `{ "bits": "80000000" }` (f32) or 16 hex digits (f64), in numeric bit order. Signed zero, infinities and NaN payloads survive transport; Borsh rejects NaN. Hex input accepts uppercase; output is lowercase.
- Booleans/strings use JSON booleans/Unicode strings; unit uses null. Byte vectors/arrays use even unprefixed hex strings with exact fixed lengths.
- Options use `{ "tag": "None" }` or `{ "tag": "Some", "value": ... }`. Sequences/tuples use arrays; structs use exact named fields in declaration wire order.
- Results use `{ "tag": "Ok", "value": ... }` or `{ "tag": "Err", "value": ... }`.
- Enum transport is `{ "variant": "Count", "value": "513" }`; Idle carries null, Named carries `{ "label": "x", "enabled": true }`.
- Maps use key/value pair arrays and sets use value arrays. Duplicate keys/items are transport errors. Results sort by Rust value order. `de_strict_order` rejects unsorted/duplicate wire entries; this differs from permissive Borsh builds.

## Registry

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
| `transfer` | `Transfer { receiver: String, amount: u128 }` |
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
| `result_u16_string` | `Result<u16, String>` |
| `result_option_u8_unit` | `Result<Option<u8>, ()>` |
| `result_unit_vec_unit` | `Result<(), Vec<()>>` |

Zero-sized visitation is observable: unit, Empty, `((),)`, `[();0]`, `[();1]` and
`[u8;0]` accept empty bytes. `Vec<()>`, `Vec<Empty>` and `Vec<[u8;0]>` reject even
empty vectors. An empty `Vec<Vec<()>>` accepts, but a nonempty outer vector visits
and rejects its inner vector. `[Vec<()>;0]` accepts without visiting an item;
`[Vec<()>;1]` rejects. `Option<()>` and `Vec<Option<()>>` accept. Therefore a TS
compiler must model visit-time failures rather than reject every schema that
contains a zero-sized vector somewhere.
