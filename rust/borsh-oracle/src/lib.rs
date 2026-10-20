pub mod error;
pub mod registry;
mod strict_json;
pub mod transport;

use error::{Error, Result};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};

pub const MAX_FRAME_BYTES: usize = 1_048_576;
pub const MAX_ID_BYTES: usize = 128;
pub const MAX_SCHEMA_ID_BYTES: usize = 64;

fn request(v: &Value) -> Result<Value> {
    let m = v
        .as_object()
        .ok_or_else(|| Error::new("protocol", "request must be object"))?;
    if m.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
        return Err(Error::new("protocol", "protocolVersion must be integer 1"));
    }
    let id = m
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::new("protocol", "id must be string"))?;
    if id.len() > MAX_ID_BYTES {
        return Err(Error::resource("id exceeds limit"));
    }
    let schema = m
        .get("schemaId")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::new("protocol", "schemaId must be string"))?;
    if schema.len() > MAX_SCHEMA_ID_BYTES {
        return Err(Error::resource("schemaId exceeds limit"));
    }
    let op = m
        .get("operation")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::new("protocol", "operation must be string"))?;
    let field = match op {
        "encode" => "value",
        "decode" => "hex",
        _ => {
            return Err(Error::new(
                "unknown_operation",
                "operation must be encode or decode",
            ));
        }
    };
    let fields = ["protocolVersion", "id", "schemaId", "operation", field];
    if m.len() != fields.len() || fields.iter().any(|k| !m.contains_key(*k)) {
        return Err(Error::new("protocol", "missing or extra request fields"));
    }
    let data = registry::run(schema, op, &m[field])?;
    Ok(
        json!({"protocolVersion":1, "id":id,"ok":true,"schemaId":schema,"operation":op,
        "value":data["value"],"hex":data["hex"]}),
    )
}

pub fn handle_line(bytes: &[u8]) -> Value {
    if bytes.len() > MAX_FRAME_BYTES {
        return Error::resource("input frame exceeds limit").response(None);
    }
    let v = match strict_json::parse(bytes) {
        Ok(v) => v,
        Err(e) => return Error::new("protocol", format!("invalid JSON: {e}")).response(None),
    };
    let id = v
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| s.len() <= MAX_ID_BYTES);
    request(&v).unwrap_or_else(|e| e.response(id))
}

/// Returns one frame, draining an oversized line without retaining its tail.
/// LF is not part of the byte limit. A final nonempty frame at EOF is accepted.
fn read_frame(reader: &mut impl BufRead) -> io::Result<Option<Result<Vec<u8>>>> {
    let mut bytes = Vec::new();
    let mut oversized = false;
    let mut seen = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(if seen {
                Some(if oversized {
                    Err(Error::resource("input frame exceeds limit"))
                } else {
                    Ok(bytes)
                })
            } else {
                None
            });
        }
        seen = true;
        let newline = available.iter().position(|b| *b == b'\n');
        let count = newline.unwrap_or(available.len());
        if !oversized {
            if bytes.len().saturating_add(count) > MAX_FRAME_BYTES {
                oversized = true;
                bytes.clear();
            } else {
                bytes.extend_from_slice(&available[..count]);
            }
        }
        reader.consume(count + usize::from(newline.is_some()));
        if newline.is_some() {
            return Ok(Some(if oversized {
                Err(Error::resource("input frame exceeds limit"))
            } else {
                Ok(bytes)
            }));
        }
    }
}

pub fn serve(reader: &mut impl BufRead, writer: &mut impl Write) -> io::Result<()> {
    while let Some(frame) = read_frame(reader)? {
        let response = match frame {
            Ok(bytes) => handle_line(&bytes),
            Err(e) => e.response(None),
        };
        let mut encoded = serde_json::to_vec(&response)?;
        if encoded.len() > MAX_FRAME_BYTES {
            let id = response.get("id").and_then(Value::as_str);
            encoded =
                serde_json::to_vec(&Error::resource("output frame exceeds limit").response(id))?;
        }
        writer.write_all(&encoded)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }
    Ok(())
}
