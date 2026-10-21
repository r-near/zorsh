//! JSON conversion only. No Borsh byte encoding or decoding lives here.
use crate::error::{Error, Result};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_RAW_BYTES: usize = 65_536;
pub const MAX_ITEMS: usize = 16_384;

pub trait Transport: Sized {
    fn parse(value: &Value) -> Result<Self>;
    fn normalized(&self) -> Value;
}

pub fn object<'a>(v: &'a Value, fields: &[&str]) -> Result<&'a Map<String, Value>> {
    let map = v
        .as_object()
        .ok_or_else(|| Error::transport("expected object"))?;
    if map.len() != fields.len() || fields.iter().any(|k| !map.contains_key(*k)) {
        return Err(Error::transport(format!(
            "expected exactly fields {fields:?}"
        )));
    }
    Ok(map)
}

pub fn array(v: &Value) -> Result<&[Value]> {
    let a = v
        .as_array()
        .ok_or_else(|| Error::transport("expected array"))?;
    if a.len() > MAX_ITEMS {
        return Err(Error::resource("too many transport items"));
    }
    Ok(a)
}

pub fn text(v: &Value) -> Result<&str> {
    v.as_str()
        .ok_or_else(|| Error::transport("expected string"))
}

pub fn unhex(s: &str) -> Result<Vec<u8>> {
    if s.len() > MAX_RAW_BYTES * 2 {
        return Err(Error::resource("hex exceeds raw byte limit"));
    }
    if !s.len().is_multiple_of(2) || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::transport("expected even unprefixed ASCII hex"));
    }
    s.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| {
            let digit = |b: u8| {
                if b <= b'9' {
                    b - b'0'
                } else {
                    b.to_ascii_lowercase() - b'a' + 10
                }
            };
            Ok(digit(c[0]) * 16 + digit(c[1]))
        })
        .collect()
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

macro_rules! integers {
    ($($ty:ty),* $(,)?) => {$ (
        impl Transport for $ty {
            fn parse(v: &Value) -> Result<Self> {
                let s = text(v)?;
                let digits = s.strip_prefix('-').unwrap_or(s);
                if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) || s.len() > 40 {
                    return Err(Error::transport("expected bounded decimal integer string"));
                }
                s.parse().map_err(|_| Error::transport(concat!("integer outside ", stringify!($ty), " range")))
            }
            fn normalized(&self) -> Value { Value::String(self.to_string()) }
        }
    )*};
}
integers!(u8, u16, u32, u64, u128, i8, i16, i32, i64, i128);

impl Transport for bool {
    fn parse(v: &Value) -> Result<Self> {
        v.as_bool()
            .ok_or_else(|| Error::transport("expected boolean"))
    }
    fn normalized(&self) -> Value {
        Value::Bool(*self)
    }
}
impl Transport for String {
    fn parse(v: &Value) -> Result<Self> {
        let s = text(v)?;
        if s.len() > MAX_RAW_BYTES {
            return Err(Error::resource("UTF-8 string exceeds raw byte limit"));
        }
        Ok(s.to_owned())
    }
    fn normalized(&self) -> Value {
        Value::String(self.clone())
    }
}
impl Transport for () {
    fn parse(v: &Value) -> Result<Self> {
        if v.is_null() {
            Ok(())
        } else {
            Err(Error::transport("expected null for unit"))
        }
    }
    fn normalized(&self) -> Value {
        Value::Null
    }
}
macro_rules! floats {
    ($ty:ty, $bits:ty, $width:expr) => {
        impl Transport for $ty {
            fn parse(v: &Value) -> Result<Self> {
                let m = object(v, &["bits"])?;
                let s = text(&m["bits"])?;
                if s.len() != $width || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(Error::transport("float bits must be fixed-width unprefixed hex"));
                }
                let bits = <$bits>::from_str_radix(s, 16).map_err(|_| Error::transport("invalid float bits"))?;
                Ok(Self::from_bits(bits))
            }
            fn normalized(&self) -> Value { json!({"bits": format!(concat!("{:0", $width, "x}"), self.to_bits())}) }
        }
    };
}
floats!(f32, u32, 8);
floats!(f64, u64, 16);

impl<T: Transport> Transport for Vec<T> {
    fn parse(v: &Value) -> Result<Self> {
        array(v)?.iter().map(T::parse).collect()
    }
    fn normalized(&self) -> Value {
        Value::Array(self.iter().map(T::normalized).collect())
    }
}
impl<T: Transport, const N: usize> Transport for [T; N] {
    fn parse(v: &Value) -> Result<Self> {
        let a = array(v)?;
        if a.len() != N {
            return Err(Error::transport(format!("expected array length {N}")));
        }
        a.iter()
            .map(T::parse)
            .collect::<Result<Vec<_>>>()?
            .try_into()
            .map_err(|_| Error::transport("array length changed"))
    }
    fn normalized(&self) -> Value {
        Value::Array(self.iter().map(T::normalized).collect())
    }
}
impl<T: Transport> Transport for Option<T> {
    fn parse(v: &Value) -> Result<Self> {
        let map = v
            .as_object()
            .ok_or_else(|| Error::transport("expected tagged option"))?;
        match map.get("tag").and_then(Value::as_str) {
            Some("None") => {
                object(v, &["tag"])?;
                Ok(None)
            }
            Some("Some") => {
                let m = object(v, &["tag", "value"])?;
                Ok(Some(T::parse(&m["value"])?))
            }
            _ => Err(Error::transport("expected option tag None or Some")),
        }
    }
    fn normalized(&self) -> Value {
        match self {
            None => json!({"tag": "None"}),
            Some(v) => json!({"tag": "Some", "value": v.normalized()}),
        }
    }
}
impl<A: Transport, B: Transport> Transport for (A, B) {
    fn parse(v: &Value) -> Result<Self> {
        let a = array(v)?;
        if a.len() != 2 {
            return Err(Error::transport("expected tuple length 2"));
        }
        Ok((A::parse(&a[0])?, B::parse(&a[1])?))
    }
    fn normalized(&self) -> Value {
        json!([self.0.normalized(), self.1.normalized()])
    }
}
impl Transport for ((),) {
    fn parse(v: &Value) -> Result<Self> {
        let a = array(v)?;
        if a.len() != 1 {
            return Err(Error::transport("expected tuple length 1"));
        }
        Ok((<()>::parse(&a[0])?,))
    }
    fn normalized(&self) -> Value {
        json!([null])
    }
}
impl Transport for BTreeMap<u16, String> {
    fn parse(v: &Value) -> Result<Self> {
        let mut out = Self::new();
        for entry in array(v)? {
            let (k, val) = <(u16, String)>::parse(entry)?;
            if out.insert(k, val).is_some() {
                return Err(Error::transport("duplicate map key"));
            }
        }
        Ok(out)
    }
    fn normalized(&self) -> Value {
        Value::Array(
            self.iter()
                .map(|(k, v)| json!([k.normalized(), v.normalized()]))
                .collect(),
        )
    }
}
impl Transport for BTreeSet<String> {
    fn parse(v: &Value) -> Result<Self> {
        let mut out = Self::new();
        for val in array(v)? {
            if !out.insert(String::parse(val)?) {
                return Err(Error::transport("duplicate set item"));
            }
        }
        Ok(out)
    }
    fn normalized(&self) -> Value {
        Value::Array(self.iter().map(Transport::normalized).collect())
    }
}
