use serde_json::{Value, json};
use zorsh_borsh_oracle::{handle_line, registry::SCHEMA_IDS};

fn call(schema: &str, operation: &str, payload: Value) -> Value {
    let mut request =
        json!({"protocolVersion":1,"id":"test","schemaId":schema,"operation":operation});
    request[if operation == "encode" {
        "value"
    } else {
        "hex"
    }] = payload;
    handle_line(&serde_json::to_vec(&request).unwrap())
}
fn golden(schema: &str, value: Value, hex: &str) {
    let encoded = call(schema, "encode", value.clone());
    assert_eq!(encoded["ok"], true, "{schema}: {encoded}");
    assert_eq!(encoded["hex"], hex, "{schema}");
    let decoded = call(schema, "decode", json!(hex));
    assert_eq!(decoded["ok"], true, "{schema}: {decoded}");
    assert_eq!(decoded["value"], value, "{schema}");
    assert_eq!(encoded["value"], value, "{schema}");
}
fn rejection(schema: &str, op: &str, value: Value, kind: &str) {
    let r = call(schema, op, value);
    assert_eq!(r["ok"], false, "{r}");
    assert_eq!(r["error"]["kind"], kind, "{schema}: {r}");
}

#[test]
fn integers_exact_boundaries_and_carry() {
    for (schema, min, max, low, high) in [
        ("u8", "0", "255", "00", "ff"),
        ("u16", "0", "65535", "0000", "ffff"),
        ("u32", "0", "4294967295", "00000000", "ffffffff"),
        (
            "u64",
            "0",
            "18446744073709551615",
            "0000000000000000",
            "ffffffffffffffff",
        ),
        (
            "u128",
            "0",
            "340282366920938463463374607431768211455",
            "00000000000000000000000000000000",
            "ffffffffffffffffffffffffffffffff",
        ),
        ("i8", "-128", "127", "80", "7f"),
        ("i16", "-32768", "32767", "0080", "ff7f"),
        ("i32", "-2147483648", "2147483647", "00000080", "ffffff7f"),
        (
            "i64",
            "-9223372036854775808",
            "9223372036854775807",
            "0000000000000080",
            "ffffffffffffff7f",
        ),
        (
            "i128",
            "-170141183460469231731687303715884105728",
            "170141183460469231731687303715884105727",
            "00000000000000000000000000000080",
            "ffffffffffffffffffffffffffffff7f",
        ),
    ] {
        golden(schema, json!(min), low);
        golden(schema, json!(max), high);
    }
    golden(
        "u128",
        json!("18446744073709551616"),
        "00000000000000000100000000000000",
    );
    golden("i128", json!("-1"), "ffffffffffffffffffffffffffffffff");
    for (schema, value) in [
        ("u8", "256"),
        ("u8", "-1"),
        ("i8", "128"),
        ("i8", "-129"),
        ("u128", "340282366920938463463374607431768211456"),
        ("i128", "-170141183460469231731687303715884105729"),
    ] {
        rejection(schema, "encode", json!(value), "transport");
    }
}

#[test]
fn floats_bits_preserve_zero_infinity_subnormal_and_reject_nans() {
    for (schema, bits, hex) in [
        ("f32", "00000000", "00000000"),
        ("f32", "80000000", "00000080"),
        ("f32", "7f800000", "0000807f"),
        ("f32", "ff800000", "000080ff"),
        ("f32", "00000001", "01000000"),
        ("f32", "7f7fffff", "ffff7f7f"),
        ("f64", "8000000000000000", "0000000000000080"),
        ("f64", "7ff0000000000000", "000000000000f07f"),
        ("f64", "fff0000000000000", "000000000000f0ff"),
        ("f64", "0000000000000001", "0100000000000000"),
    ] {
        golden(schema, json!({"bits":bits}), hex);
    }
    for (schema, bits, hex) in [
        ("f32", "7fc00000", "0000c07f"),
        ("f32", "7f800001", "0100807f"),
        ("f32", "ffffffff", "ffffffff"),
        ("f32", "ffc01234", "3412c0ff"),
        ("f64", "7ff8000000000000", "000000000000f87f"),
        ("f64", "7ff0000000000001", "010000000000f07f"),
        ("f64", "ffffffffffffffff", "ffffffffffffffff"),
    ] {
        rejection(schema, "encode", json!({"bits":bits}), "borsh_rejection");
        rejection(schema, "decode", json!(hex), "borsh_rejection");
    }
}

#[test]
fn concrete_types_and_options() {
    golden("bool", json!(false), "00");
    golden("bool", json!(true), "01");
    golden("string", json!("\u{feff}a🦀"), "08000000efbbbf61f09fa680");
    golden("bytes", json!("00ff80"), "0300000000ff80");
    golden("bytes32", json!("00".repeat(32)), &"00".repeat(32));
    golden("vec_u16", json!(["1", "256"]), "0200000001000001");
    golden("array_u16_3", json!(["0", "1", "65535"]), "00000100ffff");
    golden(
        "tuple_u8_u128",
        json!(["7", "18446744073709551616"]),
        "0700000000000000000100000000000000",
    );
    golden("option_u128", json!({"tag":"None"}), "00");
    golden(
        "option_u128",
        json!({"tag":"Some","value":"1"}),
        "0101000000000000000000000000000000",
    );
    golden("option_option_u8", json!({"tag":"None"}), "00");
    golden(
        "option_option_u8",
        json!({"tag":"Some","value":{"tag":"None"}}),
        "0100",
    );
    golden(
        "option_option_u8",
        json!({"tag":"Some","value":{"tag":"Some","value":"255"}}),
        "0101ff",
    );
    golden(
        "storage_deposit",
        json!({"token_id":"a","account_id":"b","storage_deposit_amount":{"tag":"Some","value":"1"}}),
        "010000006101000000620101000000000000000000000000000000",
    );
    golden(
        "explicit_enum",
        json!({"variant":"Idle","value":null}),
        "03",
    );
    golden(
        "explicit_enum",
        json!({"variant":"Count","value":"513"}),
        "110102",
    );
    golden(
        "explicit_enum",
        json!({"variant":"Named","value":{"label":"x","enabled":true}}),
        "fa010000007801",
    );
    golden("status", json!({"variant":"Pending","value":null}), "00");
    golden("status", json!({"variant":"Done","value":null}), "02");
    golden("shape", json!({"variant":"Empty","value":null}), "00");
    golden(
        "shape",
        json!({"variant":"Square","value":"5"}),
        "0105000000",
    );
    golden(
        "shape",
        json!({"variant":"Rect","value":{"width":"513","height":"2"}}),
        "0201020200",
    );
}

#[test]
fn concrete_results_have_rust_tags_and_selected_payloads() {
    golden(
        "result_u16_string",
        json!({"tag":"Ok","value":"513"}),
        "010102",
    );
    golden(
        "result_u16_string",
        json!({"tag":"Err","value":"x"}),
        "000100000078",
    );
    golden(
        "result_option_u8_unit",
        json!({"tag":"Ok","value":{"tag":"None"}}),
        "0100",
    );
    golden(
        "result_option_u8_unit",
        json!({"tag":"Ok","value":{"tag":"Some","value":"7"}}),
        "010107",
    );
    golden(
        "result_option_u8_unit",
        json!({"tag":"Err","value":null}),
        "00",
    );
    golden(
        "result_unit_vec_unit",
        json!({"tag":"Ok","value":null}),
        "01",
    );
    rejection(
        "result_unit_vec_unit",
        "encode",
        json!({"tag":"Err","value":[]}),
        "borsh_rejection",
    );
    rejection(
        "result_unit_vec_unit",
        "decode",
        json!("0000000000"),
        "borsh_rejection",
    );
    for hex in [
        "",
        "01",
        "0101",
        "00",
        "0001000000",
        "0001000000ff",
        "01010200",
    ] {
        rejection("result_u16_string", "decode", json!(hex), "borsh_rejection");
    }
    for tag in 2u8..=255 {
        rejection(
            "result_u16_string",
            "decode",
            json!(format!("{tag:02x}")),
            "borsh_rejection",
        );
    }
    for value in [
        json!(null),
        json!({"tag":"Ok"}),
        json!({"tag":"Other","value":"1"}),
        json!({"tag":"Ok","value":"65536"}),
        json!({"tag":"Err","value":1}),
        json!({"tag":"Ok","value":"1","extra":null}),
    ] {
        rejection("result_u16_string", "encode", value, "transport");
    }
}

#[test]
fn malformed_borsh_is_rejected_including_trailing_bytes() {
    for (schema, hex) in [
        ("bool", "02"),
        ("u8", ""),
        ("u8", "0000"),
        ("u128", "00"),
        ("option_u128", "02"),
        ("option_option_u8", "0102"),
        ("string", "01000000ff"),
        ("string", "0200000061"),
        ("explicit_enum", "00"),
        ("explicit_enum", "11"),
        ("status", "03"),
        ("shape", "03"),
        ("shape", "01050000"),
        ("bytes", "ffffffff"),
        ("vec_u16", "ffffffff"),
        ("map_u16_string", "ffffffff"),
        ("set_string", "ffffffff"),
    ] {
        rejection(schema, "decode", json!(hex), "borsh_rejection");
    }
    for schema in ["bool", "u8", "unit", "empty", "option_unit", "array_unit_0"] {
        let value = match schema {
            "bool" => json!(true),
            "u8" => json!("1"),
            "empty" => json!({}),
            "option_unit" => json!({"tag":"None"}),
            "array_unit_0" => json!([]),
            _ => Value::Null,
        };
        let encoded = call(schema, "encode", value);
        let hex = format!("{}00", encoded["hex"].as_str().unwrap());
        rejection(schema, "decode", json!(hex), "borsh_rejection");
    }
}

#[test]
fn transfer_struct_has_concrete_field_order_and_rejections() {
    golden(
        "transfer",
        json!({"receiver":"é🦀","amount":"513"}),
        "06000000c3a9f09fa68001020000000000000000000000000000",
    );
    rejection("transfer", "decode", json!("0000000001"), "borsh_rejection");
    rejection(
        "transfer",
        "encode",
        json!({"receiver":"alice.near"}),
        "transport",
    );
}

#[test]
fn composite_zero_sized_vectors_are_rejected() {
    #[derive(borsh::BorshSerialize, borsh::BorshDeserialize)]
    struct UnitField {
        a: (),
    }
    assert!(borsh::to_vec(&UnitField { a: () }).unwrap().is_empty());
    assert!(borsh::from_slice::<UnitField>(&[]).is_ok());
    for bytes in [vec![0, 0, 0, 0], vec![1, 0, 0, 0]] {
        assert!(borsh::from_slice::<Vec<((),)>>(&bytes).is_err());
        assert!(borsh::from_slice::<Vec<UnitField>>(&bytes).is_err());
    }
    assert!(borsh::to_vec(&Vec::<((),)>::new()).is_err());
    assert!(borsh::to_vec(&vec![((),)]).is_err());
    assert!(borsh::to_vec(&Vec::<UnitField>::new()).is_err());
    assert!(borsh::to_vec(&vec![UnitField { a: () }]).is_err());
}

#[test]
fn zst_visitation_is_owned_by_borsh_not_schema_validation() {
    for (schema, value) in [
        ("unit", Value::Null),
        ("empty", json!({})),
        ("tuple_unit", json!([null])),
        ("array_unit_0", json!([])),
        ("array_unit_1", json!([null])),
        ("bytes0", json!("")),
        ("array_vec_unit_0", json!([])),
    ] {
        golden(schema, value, "");
    }
    golden("vec_vec_unit", json!([]), "00000000");
    golden("option_unit", json!({"tag":"None"}), "00");
    golden("option_unit", json!({"tag":"Some","value":null}), "01");
    golden(
        "vec_option_unit",
        json!([{"tag":"None"},{"tag":"Some","value":null}]),
        "020000000001",
    );
    for schema in ["vec_unit", "vec_empty", "vec_bytes0"] {
        rejection(schema, "encode", json!([]), "borsh_rejection");
        rejection(schema, "decode", json!("00000000"), "borsh_rejection");
    }
    for (schema, value, hex) in [
        ("vec_unit", json!([null]), "01000000"),
        ("vec_empty", json!([{}]), "01000000"),
        ("vec_bytes0", json!([""]), "01000000"),
        ("vec_vec_unit", json!([[]]), "0100000000000000"),
        ("array_vec_unit_1", json!([[]]), "00000000"),
    ] {
        rejection(schema, "encode", value, "borsh_rejection");
        rejection(schema, "decode", json!(hex), "borsh_rejection");
    }
}

#[test]
fn strict_ordering_and_duplicate_transport_keys() {
    golden(
        "map_u16_string",
        json!([["1", "a"], ["256", "b"]]),
        "020000000100010000006100010100000062",
    );
    golden(
        "set_string",
        json!(["a", "b"]),
        "0200000001000000610100000062",
    );
    let normalized = call(
        "map_u16_string",
        "encode",
        json!([["256", "b"], ["01", "a"]]),
    );
    assert_eq!(normalized["value"], json!([["1", "a"], ["256", "b"]]));
    for (schema, hex) in [
        ("map_u16_string", "020000000001010000006201000100000061"),
        ("map_u16_string", "020000000100010000006101000100000062"),
        ("set_string", "0200000001000000620100000061"),
        ("set_string", "0200000001000000610100000061"),
    ] {
        rejection(schema, "decode", json!(hex), "borsh_rejection");
    }
    rejection(
        "map_u16_string",
        "encode",
        json!([["1", "a"], ["01", "b"]]),
        "transport",
    );
    rejection("set_string", "encode", json!(["a", "a"]), "transport");
}

#[test]
fn bad_transport_never_counts_as_borsh_rejection() {
    for (schema, value) in [
        ("u8", json!(1)),
        ("u8", json!("+1")),
        ("u8", json!(" 1")),
        ("bool", json!("true")),
        ("bytes", json!("0")),
        ("bytes", json!("0x00")),
        ("bytes", json!("gg")),
        ("bytes32", json!("00")),
        ("f32", json!({"bits":"0"})),
        ("option_u128", Value::Null),
        ("option_u128", json!({"tag":"None","value":"1"})),
        ("option_option_u8", json!({"tag":"Some","value":null})),
        ("array_u16_3", json!([])),
        (
            "explicit_enum",
            json!({"variant":"Count","value":"1","extra":true}),
        ),
        ("status", json!({"variant":"Done","value":"0"})),
        ("shape", json!({"variant":"Circle","value":null})),
    ] {
        rejection(schema, "encode", value, "transport");
    }
    rejection("u8", "decode", json!("0G"), "transport");
    rejection("u8", "decode", json!(0), "transport");
    let normalized = call("u16", "encode", json!("0001"));
    assert_eq!(normalized["value"], "1");
    let normalized = call("f32", "encode", json!({"bits":"FF800000"}));
    assert_eq!(normalized["value"], json!({"bits":"ff800000"}));
}

#[test]
fn registry_has_no_accidental_duplicate_ids() {
    let ids: std::collections::BTreeSet<_> = SCHEMA_IDS.iter().collect();
    assert_eq!(ids.len(), SCHEMA_IDS.len());
    assert_eq!(SCHEMA_IDS.len(), 49);
}

#[test]
fn primitive_set_ordering() {
    golden(
        "set_i16",
        json!(["-32768", "-1", "0", "32767"]),
        "040000000080ffff0000ff7f",
    );
    golden("set_bool", json!([false, true]), "020000000001");
    golden(
        "set_i128",
        json!([
            "-170141183460469231731687303715884105728",
            "170141183460469231731687303715884105727"
        ]),
        "0200000000000000000000000000000000000080ffffffffffffffffffffffffffffff7f",
    );
    golden(
        "set_u128",
        json!(["0", "340282366920938463463374607431768211455"]),
        "0200000000000000000000000000000000000000ffffffffffffffffffffffffffffffff",
    );
    for (schema, raw) in [
        ("set_i16", "020000000000ffff"),
        ("set_bool", "020000000101"),
        ("set_bool", "0100000002"),
    ] {
        rejection(schema, "decode", json!(raw), "borsh_rejection");
    }
}
