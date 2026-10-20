use serde_json::{Value, json};
use std::io::{BufReader, Cursor, Write};
use std::process::Command;

mod support;
use support::{CLI_TIMEOUT, TestChild};
use zorsh_borsh_oracle::{MAX_FRAME_BYTES, handle_line, serve};

fn request(id: &str) -> Value {
    json!({"protocolVersion":1,"id":id,"schemaId":"u8","operation":"encode","value":"7"})
}
fn kind(v: &Value) -> &str {
    v["error"]["kind"].as_str().unwrap()
}

#[test]
fn protocol_rejects_bad_json_duplicates_surrogates_and_fields() {
    for bytes in [
        b"".as_slice(),b"null",b"[]",b"{}",b"{} {}",b"\xff",
        br#"{"id":"\ud800"}"#,br#"{"id":"\udfff"}"#,
        br#"{"id":"x","id":"y"}"#,
        br#"{"protocolVersion":1,"id":"x","schemaId":"option_unit","operation":"encode","value":{"tag":"None","tag":"Some"}}"#,
    ] { assert_eq!(kind(&handle_line(bytes)),"protocol"); }
    for (field, value) in [
        ("protocolVersion", json!(2)),
        ("protocolVersion", json!(1.0)),
        ("id", json!(7)),
        ("schemaId", json!(null)),
        ("operation", json!(false)),
        ("hex", json!("00")),
    ] {
        let mut r = request("test");
        r[field] = value;
        assert_eq!(
            kind(&handle_line(&serde_json::to_vec(&r).unwrap())),
            "protocol"
        );
    }
    let mut r = request("x");
    r["operation"] = json!("inspect");
    assert_eq!(
        kind(&handle_line(&serde_json::to_vec(&r).unwrap())),
        "unknown_operation"
    );
    r = request("x");
    r["schemaId"] = json!("missing");
    assert_eq!(
        kind(&handle_line(&serde_json::to_vec(&r).unwrap())),
        "unknown_schema"
    );
}

#[test]
fn resource_limits_are_distinct_and_keep_bounded_request_ids() {
    for (field, value) in [
        ("id", json!("a".repeat(129))),
        ("schemaId", json!("a".repeat(65))),
    ] {
        let mut r = request("x");
        r[field] = value;
        let response = handle_line(&serde_json::to_vec(&r).unwrap());
        assert_eq!(kind(&response), "resource_limit");
    }
    let mut r = request("raw");
    r["operation"] = json!("decode");
    r.as_object_mut().unwrap().remove("value");
    r["hex"] = json!("00".repeat(65_537));
    assert_eq!(
        kind(&handle_line(&serde_json::to_vec(&r).unwrap())),
        "resource_limit"
    );
    r = request("string");
    r["schemaId"] = json!("string");
    r["value"] = json!("x".repeat(65_536));
    // The data fits the transport string bound but not Borsh's extra length prefix.
    assert_eq!(
        kind(&handle_line(&serde_json::to_vec(&r).unwrap())),
        "resource_limit"
    );
    r = request("items");
    r["schemaId"] = json!("vec_u16");
    r["value"] = json!(vec!["0"; 16_385]);
    assert_eq!(
        kind(&handle_line(&serde_json::to_vec(&r).unwrap())),
        "resource_limit"
    );
}

#[test]
fn bounded_reader_drains_oversized_lines_and_resynchronizes() {
    let mut input = vec![b'x'; MAX_FRAME_BYTES + 1];
    input.push(b'\n');
    input.extend(serde_json::to_vec(&request("after")).unwrap());
    input.push(b'\n');
    input.extend(b"broken\n");
    input.extend(serde_json::to_vec(&request("last")).unwrap());
    let mut output = Vec::new();
    // Tiny buffers exercise boundaries across every framing branch.
    serve(
        &mut BufReader::with_capacity(7, Cursor::new(input)),
        &mut output,
    )
    .unwrap();
    let responses: Vec<Value> = output
        .split(|b| *b == b'\n')
        .filter(|b| !b.is_empty())
        .map(|b| serde_json::from_slice(b).unwrap())
        .collect();
    assert_eq!(responses.len(), 4);
    assert_eq!(kind(&responses[0]), "resource_limit");
    assert_eq!(responses[1]["id"], "after");
    assert_eq!(responses[1]["hex"], "07");
    assert_eq!(kind(&responses[2]), "protocol");
    assert_eq!(responses[3]["id"], "last");
}

#[test]
fn frame_limit_is_inclusive_and_output_is_bounded() {
    let mut line = serde_json::to_vec(&request("boundary")).unwrap();
    line.resize(MAX_FRAME_BYTES, b' ');
    let mut input = line.clone();
    input.push(b'\n');
    let mut output = Vec::new();
    serve(&mut Cursor::new(input), &mut output).unwrap();
    let r: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(r["ok"], true);
    line.push(b' ');
    assert_eq!(kind(&handle_line(&line)), "resource_limit");
    // Vec<Option<()>> is one byte per element on wire, but JSON can expand >1 MiB.
    let mut r = request("expanded");
    r["schemaId"] = json!("vec_option_unit");
    r["operation"] = json!("decode");
    r.as_object_mut().unwrap().remove("value");
    r["hex"] = json!(format!("fcff0000{}", "01".repeat(65_532)));
    let input = serde_json::to_vec(&r).unwrap();
    let mut output = Vec::new();
    serve(&mut Cursor::new(input), &mut output).unwrap();
    assert!(output.len() <= MAX_FRAME_BYTES + 1);
    assert_eq!(
        kind(&serde_json::from_slice(&output).unwrap()),
        "resource_limit"
    );
}

#[test]
fn io_errors_propagate_instead_of_becoming_codec_rejections() {
    struct Broken;
    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let input = serde_json::to_vec(&request("x")).unwrap();
    let error = serve(&mut Cursor::new(input), &mut Broken).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
}

#[test]
fn actual_cli_is_persistent_and_stdout_has_only_responses() {
    let mut child = TestChild::spawn(
        &mut Command::new(env!("CARGO_BIN_EXE_zorsh-borsh-oracle")),
        "persistent oracle",
        CLI_TIMEOUT,
    )
    .unwrap();
    for (index, payload) in [
        serde_json::to_vec(&request("one")).unwrap(),
        b"bad".to_vec(),
        serde_json::to_vec(&request("two")).unwrap(),
    ]
    .into_iter()
    .enumerate()
    {
        let stdin = child.stdin.as_mut().unwrap();
        stdin.write_all(&payload).unwrap();
        stdin.write_all(b"\n").unwrap();
        stdin.flush().unwrap();
        let line = child.read_line().unwrap();
        let r: Value = serde_json::from_str(&line).unwrap();
        if index == 1 {
            assert_eq!(kind(&r), "protocol");
        } else {
            assert_eq!(r["ok"], true);
        }
    }
    let output = child.finish().unwrap();
    assert!(output.stdout.is_empty());
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
}

#[test]
fn actual_cli_broken_pipe_exits_nonzero_with_stderr() {
    let mut child = TestChild::spawn(
        &mut Command::new(env!("CARGO_BIN_EXE_zorsh-borsh-oracle")),
        "broken-pipe oracle",
        CLI_TIMEOUT,
    )
    .unwrap();
    drop(child.stdout.take());
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(&serde_json::to_vec(&request("broken-pipe")).unwrap())
        .unwrap();
    stdin.write_all(b"\n").unwrap();
    drop(stdin);
    let output = child.finish().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("borsh oracle I/O failure:"));
}

// POSIX sh uses exec so each controlled fixture is one direct process, with no
// descendants retaining the output pipes. These run on the macOS/Linux hosts.
#[cfg(unix)]
fn stalled_child(script: &str, label: &str, timeout: std::time::Duration) -> TestChild {
    TestChild::spawn(Command::new("sh").arg("-c").arg(script), label, timeout).unwrap()
}

#[test]
#[cfg(unix)]
fn deadline_unblocks_no_response_and_reaps_child() {
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    let started = Instant::now();
    let mut child = stalled_child("exec sleep 30", "no response", Duration::from_millis(200));
    let reaped = child.reaped.clone();
    let error = child.read_line().unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    assert!(error.to_string().contains("no response"));
    assert!(error.to_string().contains("killed and reaped"));
    assert!(reaped.load(Ordering::Acquire));
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[test]
#[cfg(unix)]
fn deadline_bounds_final_exit_and_reaps_child() {
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    let started = Instant::now();
    let mut child = stalled_child(
        "printf 'ready\\n'; exec sleep 30",
        "never exits",
        Duration::from_millis(500),
    );
    let reaped = child.reaped.clone();
    assert_eq!(child.read_line().unwrap(), "ready\n");
    let error = child.finish().unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    assert!(error.to_string().contains("never exits"));
    assert!(reaped.load(Ordering::Acquire));
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[test]
#[cfg(unix)]
fn panic_cleanup_kills_and_reaps_before_returning() {
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};
    let started = Instant::now();
    let child = stalled_child("exec sleep 30", "early assertion", CLI_TIMEOUT);
    let reaped = child.reaped.clone();
    // The owned child is dropped during unwind; only its atomic reap receipt is
    // inspected afterwards, so no partially mutated supervisor state is reused.
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
        let _child = child;
        panic!("controlled early assertion failure");
    }));
    assert!(panic.is_err());
    assert!(reaped.load(Ordering::Acquire));
    // Drop cancels promptly rather than waiting for the five-second deadline.
    assert!(started.elapsed() < Duration::from_secs(3));
}
