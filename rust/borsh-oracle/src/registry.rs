//! A closed registry of real concrete Rust types, independently authored from TS.
use crate::error::{Error, Result};
use crate::transport::{self, MAX_RAW_BYTES, Transport, object};
use borsh::{BorshDeserialize, BorshSerialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(BorshSerialize, BorshDeserialize)]
struct Transfer {
    receiver: String,
    amount: u128,
}
impl Transport for Transfer {
    fn parse(v: &Value) -> Result<Self> {
        let m = object(v, &["receiver", "amount"])?;
        Ok(Self {
            receiver: String::parse(&m["receiver"])?,
            amount: u128::parse(&m["amount"])?,
        })
    }
    fn normalized(&self) -> Value {
        json!({"receiver": self.receiver, "amount": self.amount.normalized()})
    }
}

#[derive(BorshSerialize, BorshDeserialize)]
struct StorageDeposit {
    token_id: String,
    account_id: String,
    storage_deposit_amount: Option<u128>,
}
impl Transport for StorageDeposit {
    fn parse(v: &Value) -> Result<Self> {
        let m = object(v, &["token_id", "account_id", "storage_deposit_amount"])?;
        Ok(Self {
            token_id: String::parse(&m["token_id"])?,
            account_id: String::parse(&m["account_id"])?,
            storage_deposit_amount: Option::<u128>::parse(&m["storage_deposit_amount"])?,
        })
    }
    fn normalized(&self) -> Value {
        json!({"token_id": self.token_id, "account_id": self.account_id,
            "storage_deposit_amount": self.storage_deposit_amount.normalized()})
    }
}

#[derive(BorshSerialize, BorshDeserialize)]
#[borsh(use_discriminant = true)]
#[repr(u8)]
enum ExplicitEnum {
    Idle = 3,
    Count(u16) = 17,
    Named { label: String, enabled: bool } = 250,
}
impl Transport for ExplicitEnum {
    fn parse(v: &Value) -> Result<Self> {
        let m = object(v, &["variant", "value"])?;
        match transport::text(&m["variant"])? {
            "Idle" => {
                <()>::parse(&m["value"])?;
                Ok(Self::Idle)
            }
            "Count" => Ok(Self::Count(u16::parse(&m["value"])?)),
            "Named" => {
                let p = object(&m["value"], &["label", "enabled"])?;
                Ok(Self::Named {
                    label: String::parse(&p["label"])?,
                    enabled: bool::parse(&p["enabled"])?,
                })
            }
            _ => Err(Error::transport("unknown ExplicitEnum variant")),
        }
    }
    fn normalized(&self) -> Value {
        match self {
            Self::Idle => json!({"variant":"Idle","value":null}),
            Self::Count(v) => json!({"variant":"Count","value":v.normalized()}),
            Self::Named { label, enabled } => {
                json!({"variant":"Named","value":{"label":label,"enabled":enabled}})
            }
        }
    }
}

#[derive(BorshSerialize, BorshDeserialize)]
enum Status {
    Pending,
    Active,
    Done,
}
impl Transport for Status {
    fn parse(v: &Value) -> Result<Self> {
        let m = object(v, &["variant", "value"])?;
        <()>::parse(&m["value"])?;
        match transport::text(&m["variant"])? {
            "Pending" => Ok(Self::Pending),
            "Active" => Ok(Self::Active),
            "Done" => Ok(Self::Done),
            _ => Err(Error::transport("unknown Status variant")),
        }
    }
    fn normalized(&self) -> Value {
        let variant = match self {
            Self::Pending => "Pending",
            Self::Active => "Active",
            Self::Done => "Done",
        };
        json!({"variant":variant,"value":null})
    }
}

#[derive(BorshSerialize, BorshDeserialize)]
enum Shape {
    Empty,
    Square(u32),
    Rect { width: u16, height: u16 },
}
impl Transport for Shape {
    fn parse(v: &Value) -> Result<Self> {
        let m = object(v, &["variant", "value"])?;
        match transport::text(&m["variant"])? {
            "Empty" => {
                <()>::parse(&m["value"])?;
                Ok(Self::Empty)
            }
            "Square" => Ok(Self::Square(u32::parse(&m["value"])?)),
            "Rect" => {
                let p = object(&m["value"], &["width", "height"])?;
                Ok(Self::Rect {
                    width: u16::parse(&p["width"])?,
                    height: u16::parse(&p["height"])?,
                })
            }
            _ => Err(Error::transport("unknown Shape variant")),
        }
    }
    fn normalized(&self) -> Value {
        match self {
            Self::Empty => json!({"variant":"Empty","value":null}),
            Self::Square(v) => json!({"variant":"Square","value":v.normalized()}),
            Self::Rect { width, height } => json!({"variant":"Rect",
                "value":{"width":width.normalized(),"height":height.normalized()}}),
        }
    }
}

#[derive(BorshSerialize, BorshDeserialize)]
struct Empty {}
impl Transport for Empty {
    fn parse(v: &Value) -> Result<Self> {
        object(v, &[])?;
        Ok(Self {})
    }
    fn normalized(&self) -> Value {
        json!({})
    }
}

fn execute<T: BorshSerialize + BorshDeserialize>(
    operation: &str,
    payload: &Value,
    parse: impl FnOnce(&Value) -> Result<T>,
    normalize: impl FnOnce(&T) -> Value,
) -> Result<Value> {
    let (value, bytes) = match operation {
        "encode" => {
            let value = parse(payload)?;
            // Borsh counts through its own serializer before allocating the byte buffer.
            // In particular NaN and visited Vec<ZST> remain Borsh errors.
            let size = borsh::object_length(&value).map_err(Error::borsh)?;
            if size > MAX_RAW_BYTES {
                return Err(Error::resource("encoded Borsh bytes exceed limit"));
            }
            let bytes = borsh::to_vec::<T>(&value).map_err(Error::borsh)?;
            (value, bytes)
        }
        "decode" => {
            let bytes = transport::unhex(transport::text(payload)?)?;
            let value = borsh::from_slice::<T>(&bytes).map_err(Error::borsh)?;
            (value, bytes)
        }
        _ => {
            return Err(Error::new(
                "unknown_operation",
                "operation must be encode or decode",
            ));
        }
    };
    Ok(json!({"value":normalize(&value), "hex":transport::hex(&bytes)}))
}
fn standard<T: Transport + BorshSerialize + BorshDeserialize>(
    op: &str,
    p: &Value,
) -> Result<Value> {
    execute::<T>(op, p, T::parse, T::normalized)
}
fn bytes(op: &str, p: &Value) -> Result<Value> {
    execute::<Vec<u8>>(
        op,
        p,
        |v| transport::unhex(transport::text(v)?),
        |v| json!(transport::hex(v)),
    )
}
fn byte_array<const N: usize>(op: &str, p: &Value) -> Result<Value> {
    execute::<[u8; N]>(
        op,
        p,
        |v| {
            transport::unhex(transport::text(v)?)?
                .try_into()
                .map_err(|_| Error::transport(format!("expected {N} bytes")))
        },
        |v| json!(transport::hex(v)),
    )
}

macro_rules! registry {
    ($($id:literal => $ty:ty),* $(,)?) => {
        pub const SCHEMA_IDS: &[&str] = &[$($id,)* "bytes", "bytes32", "bytes0", "vec_bytes0"];
        pub fn run(schema: &str, op: &str, payload: &Value) -> Result<Value> {
            match schema {
                $($id => standard::<$ty>(op, payload),)*
                "bytes" => bytes(op, payload),
                "bytes32" => byte_array::<32>(op, payload),
                "bytes0" => byte_array::<0>(op, payload),
                "vec_bytes0" => execute::<Vec<[u8; 0]>>(op, payload, |v| {
                    transport::array(v)?.iter().map(|item| {
                        transport::unhex(transport::text(item)?)?.try_into()
                            .map_err(|_| Error::transport("expected zero bytes"))
                    }).collect()
                }, |v| Value::Array(v.iter().map(|b| json!(transport::hex(b))).collect())),
                _ => Err(Error::new("unknown_schema", "unregistered schemaId")),
            }
        }
    };
}
registry! {
    "bool" => bool,
    "u8" => u8, "u16" => u16, "u32" => u32, "u64" => u64, "u128" => u128,
    "i8" => i8, "i16" => i16, "i32" => i32, "i64" => i64, "i128" => i128,
    "f32" => f32, "f64" => f64, "string" => String, "unit" => (),
    "vec_u16" => Vec<u16>, "tuple_u8_u128" => (u8, u128),
    "option_u128" => Option<u128>, "option_option_u8" => Option<Option<u8>>,
    "array_u16_3" => [u16; 3], "storage_deposit" => StorageDeposit, "transfer" => Transfer,
    "explicit_enum" => ExplicitEnum, "status" => Status, "shape" => Shape,
    "map_u16_string" => BTreeMap<u16, String>, "set_string" => BTreeSet<String>,
    "set_i16" => BTreeSet<i16>, "set_i128" => BTreeSet<i128>,
    "set_u128" => BTreeSet<u128>, "set_bool" => BTreeSet<bool>,
    "empty" => Empty, "tuple_unit" => ((),),
    "array_unit_0" => [(); 0], "array_unit_1" => [(); 1],
    "vec_unit" => Vec<()>, "vec_empty" => Vec<Empty>,
    "vec_vec_unit" => Vec<Vec<()>>,
    "array_vec_unit_0" => [Vec<()>; 0], "array_vec_unit_1" => [Vec<()>; 1],
    "option_unit" => Option<()>, "vec_option_unit" => Vec<Option<()>>,
    "result_u16_string" => core::result::Result<u16, String>,
    "result_option_u8_unit" => core::result::Result<Option<u8>, ()>,
    "result_unit_vec_unit" => core::result::Result<(), Vec<()>>,
}
