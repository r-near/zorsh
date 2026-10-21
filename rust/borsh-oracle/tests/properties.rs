use proptest::prelude::*;
use serde_json::{Value, json};
use zorsh_borsh_oracle::handle_line;

fn encode(schema: &str, value: Value) -> Value {
    handle_line(&serde_json::to_vec(&json!({"protocolVersion":1,"id":"property","schemaId":schema,"operation":"encode","value":value})).unwrap())
}
fn roundtrip(schema: &str, value: Value) {
    let encoded = encode(schema, value);
    assert_eq!(encoded["ok"], true, "{encoded}");
    let decoded=handle_line(&serde_json::to_vec(&json!({"protocolVersion":1,"id":"decode","schemaId":schema,"operation":"decode","hex":encoded["hex"]})).unwrap());
    assert_eq!(decoded["ok"], true, "{decoded}");
    assert_eq!(encoded["value"], decoded["value"]);
}
proptest! {
    #![proptest_config(ProptestConfig { cases: 256, rng_seed: proptest::test_runner::RngSeed::Fixed(20261020), ..ProptestConfig::default() })]
    #[test]
    fn integer_and_vec_transport_roundtrips(a in any::<u128>(), b in any::<i128>(), xs in prop::collection::vec(any::<u16>(),0..128)) {
        roundtrip("u128",json!(a.to_string()));roundtrip("i128",json!(b.to_string()));
        roundtrip("vec_u16",json!(xs.iter().map(ToString::to_string).collect::<Vec<_>>()));
    }
    #[test]
    fn float_raw_bits_match_borsh_nan_policy(bits32 in any::<u32>(), bits64 in any::<u64>()) {
        for (schema,bits,nan) in [("f32",format!("{bits32:08x}"),f32::from_bits(bits32).is_nan()),
            ("f64",format!("{bits64:016x}"),f64::from_bits(bits64).is_nan())] {
            let value=json!({"bits":bits});
            if nan { let result = encode(schema,value); prop_assert_eq!(result["error"]["kind"].as_str(),Some("borsh_rejection")); }
            else { roundtrip(schema,value); }
        }
    }
    #[test]
    fn utf8_string_roundtrips(s in ".{0,256}") { roundtrip("string",json!(s)); }
    #[test]
    fn arbitrary_short_decode_is_a_response_not_a_panic(bytes in prop::collection::vec(any::<u8>(),0..128), index in 0usize..39) {
        let schema=zorsh_borsh_oracle::registry::SCHEMA_IDS[index];
        let response=handle_line(&serde_json::to_vec(&json!({"protocolVersion":1,"id":"bytes","schemaId":schema,"operation":"decode","hex":zorsh_borsh_oracle::transport::hex(&bytes)})).unwrap());
        prop_assert!(response["ok"].is_boolean());
        if response["ok"]==false { prop_assert_eq!(response["error"]["kind"].as_str(),Some("borsh_rejection")); }
    }
}
