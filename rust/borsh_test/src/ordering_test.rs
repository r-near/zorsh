//! Reference vectors for the canonical ordering of `HashMap` keys and
//! `HashSet` elements.
//!
//! borsh-rs writes hash collections sorted by the key's `Ord`, and `BTreeMap`
//! / `BTreeSet` already iterate in that order, so the encoding of a collection
//! never depends on insertion order. These vectors pin the exact bytes Zorsh
//! must produce for every key type it supports. Regenerate them with
//! `cargo test -- --ignored generate_ordering_test_data`.

use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshSerialize, BorshDeserialize, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Clone)]
pub struct VersionKey {
    pub major: u8,
    pub minor: u8,
}

#[derive(BorshSerialize, BorshDeserialize, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Clone)]
pub enum TagKey {
    Number(u8),
    Empty,
    Label(String),
}

#[derive(BorshSerialize, BorshDeserialize, PartialEq, Eq, PartialOrd, Ord, Hash, Debug, Clone, Copy)]
pub enum Color {
    Red,
    Green,
    Blue,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
    use std::fs::File;
    use std::io::Write;

    fn write_vector<T: BorshSerialize>(name: &str, value: &T) -> std::io::Result<()> {
        let bytes = borsh::to_vec(value)?;
        File::create(format!("test_data/ordering_{name}.bin"))?.write_all(&bytes)
    }

    #[test]
    #[ignore]
    fn generate_ordering_test_data() -> std::io::Result<()> {
        std::fs::create_dir_all("test_data")?;

        // Byte-string keys: bytewise order, shorter prefix first. The decimal
        // form of these keys sorts differently ("122..." < "97...").
        write_vector(
            "bytes_map",
            &BTreeMap::from([
                (b"zeta".to_vec(), b"1".to_vec()),
                (b"alpha".to_vec(), b"2".to_vec()),
                (b"alphabet".to_vec(), b"3".to_vec()),
                (Vec::new(), b"4".to_vec()),
                (vec![2], b"5".to_vec()),
                (vec![10], b"6".to_vec()),
                (vec![0x80], b"7".to_vec()),
                (vec![9], b"8".to_vec()),
            ]),
        )?;

        // Integer keys: numeric order (not the decimal-string order "1" < "10" < "2").
        write_vector(
            "u32_map",
            &HashMap::from([
                (10u32, "ten".to_string()),
                (2, "two".to_string()),
                (1, "one".to_string()),
                (u32::MAX, "max".to_string()),
                (0, "zero".to_string()),
            ]),
        )?;
        write_vector(
            "i32_map",
            &HashMap::from([(-1i32, 1u8), (2, 2), (-10, 3), (i32::MIN, 4), (i32::MAX, 5), (0, 6)]),
        )?;
        write_vector("u64_map", &HashMap::from([(10u64, 1u8), (9, 2), (100, 3), (u64::MAX, 4)]))?;
        write_vector("i64_set", &HashSet::from([-1i64, 1, i64::MIN, i64::MAX, 0, -10, 10]))?;
        write_vector("u128_set", &HashSet::from([u128::MAX, 1, 0, 1 << 64]))?;
        write_vector("i128_set", &HashSet::from([i128::MIN, -1, 0, i128::MAX]))?;

        // String keys: UTF-8 byte order. Characters outside the Basic
        // Multilingual Plane sort after U+E000..U+FFFF here, but before them
        // under UTF-16 code-unit comparison.
        write_vector(
            "string_map",
            &HashMap::from([
                ("\u{10000}".to_string(), 1u8),
                ("\u{FFFF}".to_string(), 2),
                ("a".to_string(), 3),
                (String::new(), 4),
                ("\u{E000}".to_string(), 5),
                ("b".to_string(), 6),
                ("ab".to_string(), 7),
                ("\u{D7FF}".to_string(), 8),
                ("\u{1F600}".to_string(), 9),
                ("\u{10FFFF}".to_string(), 10),
            ]),
        )?;

        write_vector("bool_set", &HashSet::from([true, false]))?;
        write_vector(
            "option_map",
            &HashMap::from([(Some(5u8), 1u8), (None, 2), (Some(0), 3), (Some(255), 4)]),
        )?;
        write_vector(
            "tuple_set",
            &HashSet::from([
                (1u8, "b".to_string()),
                (1, "a".to_string()),
                (0, "z".to_string()),
                (0, String::new()),
            ]),
        )?;
        write_vector(
            "struct_map",
            &BTreeMap::from([
                (VersionKey { major: 1, minor: 0 }, 1u8),
                (VersionKey { major: 0, minor: 255 }, 2),
                (VersionKey { major: 0, minor: 1 }, 3),
            ]),
        )?;
        write_vector(
            "enum_map",
            &BTreeMap::from([
                (TagKey::Label("x".to_string()), 1u8),
                (TagKey::Empty, 2),
                (TagKey::Number(5), 3),
                (TagKey::Number(1), 4),
                (TagKey::Label(String::new()), 5),
            ]),
        )?;
        write_vector(
            "vec_set",
            &HashSet::from([vec![2u16], vec![1, 2, 3], vec![1, 2], vec![], vec![1]]),
        )?;
        write_vector("array_set", &HashSet::from([[1u8, 0], [0, 9], [0, 10]]))?;
        write_vector("native_enum_set", &HashSet::from([Color::Blue, Color::Red, Color::Green]))?;
        write_vector(
            "nested_set",
            &BTreeSet::from([
                BTreeSet::from([2u8]),
                BTreeSet::from([1, 3]),
                BTreeSet::new(),
                BTreeSet::from([1]),
            ]),
        )?;
        write_vector(
            "nested_map",
            &BTreeMap::from([
                (BTreeMap::new(), 1u8),
                (BTreeMap::from([(1u8, 1u8)]), 2),
                (BTreeMap::from([(1, 2)]), 3),
                (BTreeMap::from([(0, 9)]), 4),
            ]),
        )?;
        Ok(())
    }
}
