use serde_json::{Value, json};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub struct Error {
    pub kind: &'static str,
    pub message: String,
}

impl Error {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn transport(message: impl Into<String>) -> Self {
        Self::new("transport", message)
    }

    pub fn resource(message: impl Into<String>) -> Self {
        Self::new("resource_limit", message)
    }

    pub fn borsh(error: std::io::Error) -> Self {
        Self::new("borsh_rejection", error.to_string())
    }

    pub fn response(&self, id: Option<&str>) -> Value {
        json!({"protocolVersion": 1, "id": id, "ok": false,
            "error": {"kind": self.kind, "message": self.message}})
    }
}
