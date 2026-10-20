# Rust compatibility tests

These tests compare Zorsh against Borsh vectors produced by the Rust crate at repository-root `rust/borsh_test`.

From the repository root, regenerate every fixture (including ignored generators), check for drift, and run the TypeScript suite:

```sh
cargo test --locked -j 1 --manifest-path rust/borsh_test/Cargo.toml -- --include-ignored
test -z "$(git status --porcelain --untracked-files=all -- rust/borsh_test/test_data)"
vp test run
```

On the development Mac, use the Mr Boxington Cargo shim; see the root [contributing guide](../../../../CONTRIBUTING.md). `complex-serialization.test.ts` checks complex structures, and `canonical-ordering.test.ts` checks canonical collection ordering against the committed Rust bytes.
