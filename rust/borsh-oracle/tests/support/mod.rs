//! Direct-child deadlines for CLI tests. The supervisor owns Child exclusively;
//! blocked pipe I/O in the test cannot stop it from killing and reaping the child.
use std::io::{self, BufRead, BufReader, Read};
use std::process::{
    Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Output, Stdio,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub const CLI_TIMEOUT: Duration = Duration::from_secs(5);

struct ReapingChild {
    child: Child,
    reaped: Arc<AtomicBool>,
}
impl Drop for ReapingChild {
    fn drop(&mut self) {
        if !self.reaped.load(Ordering::Acquire) {
            let _ = self.child.kill();
            match self.child.wait() {
                Ok(_) => self.reaped.store(true, Ordering::Release),
                Err(error) => eprintln!("failed to reap test child {}: {error}", self.child.id()),
            }
        }
    }
}

pub struct TestChild {
    pub stdin: Option<ChildStdin>,
    pub stdout: Option<BufReader<ChildStdout>>,
    stderr: ChildStderr,
    cancel: mpsc::Sender<()>,
    supervisor: Option<JoinHandle<io::Result<ExitStatus>>>,
    // Set only after wait/try_wait has successfully reaped the direct child.
    pub reaped: Arc<AtomicBool>,
}
impl TestChild {
    pub fn spawn(command: &mut Command, label: &str, timeout: Duration) -> io::Result<Self> {
        Self::spawn_with_stdout(command, label, timeout, Stdio::piped())
    }

    pub fn spawn_with_stdout(
        command: &mut Command,
        label: &str,
        timeout: Duration,
        stdout: Stdio,
    ) -> io::Result<Self> {
        let reaped = Arc::new(AtomicBool::new(false));
        let mut process = ReapingChild {
            child: command
                .stdin(Stdio::piped())
                .stdout(stdout)
                .stderr(Stdio::piped())
                .spawn()?,
            reaped: Arc::clone(&reaped),
        };
        let stdin = process.child.stdin.take();
        let stdout = process.child.stdout.take().map(BufReader::new);
        let stderr = process.child.stderr.take().expect("piped stderr");
        let (cancel, cancelled) = mpsc::channel();
        let label = label.to_owned();
        let deadline = Instant::now() + timeout;
        let supervisor = thread::Builder::new().name("CLI test deadline".into()).spawn(move || {
            loop {
                if let Some(status) = process.child.try_wait()? {
                    process.reaped.store(true, Ordering::Release);
                    return Ok(status);
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    let pid = process.child.id();
                    // kill may race with normal exit; wait is still required to reap.
                    let _ = process.child.kill();
                    process.child.wait()?;
                    process.reaped.store(true, Ordering::Release);
                    let message = format!("test child {label:?} (pid {pid}) exceeded {timeout:?}; killed and reaped");
                    eprintln!("{message}");
                    return Err(io::Error::new(io::ErrorKind::TimedOut, message));
                }
                match cancelled.recv_timeout(remaining.min(Duration::from_millis(10))) {
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    // ReapingChild cleans up on cancellation, I/O error or panic.
                    _ => return Err(io::Error::new(io::ErrorKind::Interrupted, "test child cancelled")),
                }
            }
        })?;
        Ok(Self {
            stdin,
            stdout,
            stderr,
            cancel,
            supervisor: Some(supervisor),
            reaped,
        })
    }

    fn outcome(&mut self) -> io::Result<ExitStatus> {
        self.supervisor
            .take()
            .expect("supervisor joined once")
            .join()
            .map_err(|_| io::Error::other("CLI test supervisor panicked"))?
    }

    pub fn read_line(&mut self) -> io::Result<String> {
        let mut line = String::new();
        if self
            .stdout
            .as_mut()
            .expect("captured stdout")
            .read_line(&mut line)?
            == 0
        {
            // Preserve the timeout diagnostic instead of reporting a JSON/EOF error.
            self.outcome()?;
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "test child closed stdout before responding",
            ));
        }
        Ok(line)
    }

    pub fn finish(mut self) -> io::Result<Output> {
        self.stdin.take();
        let status = self.outcome()?;
        // The direct child is reaped before draining its remaining pipe buffers.
        // Test children do not spawn descendants that could retain these handles.
        let mut stdout = Vec::new();
        if let Some(reader) = self.stdout.as_mut() {
            reader.read_to_end(&mut stdout)?;
        }
        let mut stderr = Vec::new();
        self.stderr.read_to_end(&mut stderr)?;
        Ok(Output {
            status,
            stdout,
            stderr,
        })
    }
}
impl Drop for TestChild {
    fn drop(&mut self) {
        self.stdin.take();
        let _ = self.cancel.send(());
        if let Some(supervisor) = self.supervisor.take() {
            // Cancellation wakes the supervisor; it kills AND waits before join.
            let _ = supervisor.join();
        }
    }
}
