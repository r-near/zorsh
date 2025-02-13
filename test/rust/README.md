# Rust Compatibility Tests

This directory contains tests that verify Zorsh's compatibility with Rust's Borsh implementation. These tests ensure that Zorsh correctly serializes and deserializes data in a format that is compatible with Rust's Borsh library.

## Running the Tests

To run the Rust compatibility tests:

1. Make sure you have Rust and Cargo installed on your system
2. Navigate to the `rust/borsh_test` directory
3. Generate test data:
   ```bash
   cargo test -- --ignored
   ```
4. Return to the project root and run the TypeScript tests:
   ```bash
   npm test
   ```

The tests in `complex-serialization.test.ts` verify that complex data structures are correctly serialized and deserialized between TypeScript and Rust implementations.
