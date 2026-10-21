# Rust compatibility tests

These tests compare Zorsh against Borsh vectors produced by the Rust crate at repository-root `rust/borsh_test`.

Follow the root [contributing checks](../../../../CONTRIBUTING.md#checks) to regenerate fixtures and prepare the TypeScript suite. Fixture regeneration must leave `rust/borsh_test/test_data` unchanged unless the change is intentional.

`complex-serialization.test.ts` checks complex structures, and `canonical-ordering.test.ts` checks canonical collection ordering against the committed Rust bytes.
