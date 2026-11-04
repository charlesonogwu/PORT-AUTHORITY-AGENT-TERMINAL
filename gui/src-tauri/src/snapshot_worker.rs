// One long-lived `paat dashboard-serve` process answers every dashboard
// refresh. Before, each 3-second refresh started two fresh `paat` CLI
// processes (cmd.exe + node.exe each), and the snapshot one then started
// powershell.exe three times: about eight short-lived programs per refresh.
//
// Protocol (src/dashboard/serve.ts in the npm package), one JSON per line:
//   dashboard -> helper:  {"id":"7","method":"snapshot"}
//   helper -> dashboard:  {"id":"7","ok":true,"result":{"snapshot":{...},"supervisor":{...}}}
//
// The helper exits by itself when its stdin closes, so it also goes away if
// the dashboard crashes. If it cannot start (for example an older `paat`
// without `dashboard-serve`), the caller falls back to one-shot CLI calls and
// the slot waits its backoff before trying the helper again.

use serde_json::{json, Value};
use std::fmt;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

/// Longest one refresh may take before the helper is treated as stuck. Its
/// own PowerShell queries give up well before this.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// After the helper breaks, use one-shot CLI calls for this long before retrying it.
pub const RETRY_BACKOFF: Duration = Duration::from_secs(60);
/// Stop the helper after this long without refreshes (the dashboard pauses
/// polling while it is hidden). The next refresh starts it again.
pub const IDLE_LIMIT: Duration = Duration::from_secs(120);
/// How long a helper gets to exit by itself after its stdin closes.
const GRACEFUL_EXIT: Duration = Duration::from_secs(2);

/// Why a request to the helper failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelperError {
    /// The helper can't be used (didn't start, exited, timed out, broken
    /// pipe). It has to be replaced.
    Broken(String),
    /// The helper answered with an error for this request, for example a
    /// busy registry lock. It is still healthy and can be asked again.
    Reply(String),
}

impl fmt::Display for HelperError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HelperError::Broken(message) | HelperError::Reply(message) => f.write_str(message),
        }
    }
}

/// A running `paat dashboard-serve` process.
pub struct Worker {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
    next_id: u64,
}

impl Worker {
    /// Start the helper. Its stdout is read on a background thread so each
    /// reply can be awaited with a timeout.
    pub fn spawn(mut command: Command) -> Result<Self, String> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command
            .spawn()
            .map_err(|e| format!("failed to start the dashboard helper: {e}"))?;
        let stdin = child.stdin.take();
        let Some(stdout) = child.stdout.take() else {
            terminate(&mut child);
            return Err("dashboard helper has no stdout".into());
        };
        let (sender, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            lines,
            next_id: 1,
        })
    }

    /// Send one request and wait for its reply.
    pub fn request(&mut self, method: &str, timeout: Duration) -> Result<Value, HelperError> {
        let id = self.next_id.to_string();
        self.next_id += 1;
        let message = json!({ "id": id, "method": method }).to_string();
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| HelperError::Broken("dashboard helper input is closed".into()))?;
        writeln!(stdin, "{message}")
            .and_then(|()| stdin.flush())
            .map_err(|e| HelperError::Broken(format!("dashboard helper exited: {e}")))?;

        let deadline = Instant::now() + timeout;
        loop {
            let line = match self
                .lines
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok(line) => line,
                Err(RecvTimeoutError::Timeout) => {
                    return Err(HelperError::Broken(format!(
                        "dashboard helper timed out after {} ms",
                        timeout.as_millis()
                    )))
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(HelperError::Broken(
                        "dashboard helper exited before replying".into(),
                    ))
                }
            };
            // Skip anything that isn't this request's reply (stray output, a
            // late reply to an earlier request).
            let Ok(reply) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if reply.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                continue;
            }
            if reply.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
            }
            let error = reply
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            return Err(HelperError::Reply(format!(
                "dashboard helper error: {error}"
            )));
        }
    }

    fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Close the helper's input so it can exit by itself; stop it (and
    /// everything it started) if it hasn't within GRACEFUL_EXIT.
    pub fn shutdown(mut self) -> Option<ExitStatus> {
        drop(self.stdin.take());
        let deadline = Instant::now() + GRACEFUL_EXIT;
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(status)) => return Some(status),
                Ok(None) => thread::sleep(Duration::from_millis(20)),
                Err(_) => break,
            }
        }
        terminate(&mut self.child);
        self.child.wait().ok()
    }
}

/// Stop a helper and its children. On Windows the helper is cmd.exe (npm's
/// paat.cmd) running node.exe, which runs powershell.exe; killing only
/// cmd.exe would leave the other two running.
fn terminate(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let _ = crate::cli::quiet_command("taskkill.exe")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

/// Owns at most one helper: starts it on demand, replaces it when it breaks
/// (pausing restarts for `backoff`), and stops it once it sits idle.
pub struct WorkerSlot {
    worker: Option<Worker>,
    retry_after: Option<Instant>,
    backoff: Duration,
    last_used: Option<Instant>,
}

impl WorkerSlot {
    pub const fn new(backoff: Duration) -> Self {
        Self {
            worker: None,
            retry_after: None,
            backoff,
            last_used: None,
        }
    }

    /// Ask the helper, starting one if there isn't a live one.
    pub fn request<F>(
        &mut self,
        method: &str,
        timeout: Duration,
        make_command: F,
    ) -> Result<Value, String>
    where
        F: FnOnce() -> Result<Command, String>,
    {
        if self
            .retry_after
            .is_some_and(|retry_at| Instant::now() < retry_at)
        {
            return Err("dashboard helper failed recently; will retry later".into());
        }
        if !self.worker.as_mut().is_some_and(Worker::is_running) {
            self.retire();
            match make_command().and_then(Worker::spawn) {
                Ok(worker) => self.worker = Some(worker),
                Err(error) => {
                    self.retry_after = Some(Instant::now() + self.backoff);
                    return Err(error);
                }
            }
        }
        let result = match self.worker.as_mut() {
            Some(worker) => worker.request(method, timeout),
            None => Err(HelperError::Broken("dashboard helper unavailable".into())),
        };
        self.last_used = Some(Instant::now());
        match result {
            Ok(value) => {
                self.retry_after = None;
                Ok(value)
            }
            // An error answer still proves the helper works; keep it.
            Err(HelperError::Reply(message)) => Err(message),
            Err(HelperError::Broken(message)) => {
                self.retire();
                self.retry_after = Some(Instant::now() + self.backoff);
                Err(message)
            }
        }
    }

    /// Stop the helper if it has had no requests for `limit`.
    pub fn retire_if_idle(&mut self, limit: Duration) {
        if self.last_used.is_some_and(|used| used.elapsed() >= limit) {
            self.retire();
        }
    }

    fn retire(&mut self) {
        if let Some(worker) = self.worker.take() {
            worker.shutdown();
        }
    }

    #[cfg(test)]
    pub fn shutdown(&mut self) {
        self.retire();
    }
}

/// Lets callers that queued behind a refresh share its result, but only a
/// refresh that began after they asked: one that began earlier may predate
/// what they need to see (for example a browser they just killed). The
/// dashboard polls on a fixed timer, so without this a slow refresh would let
/// requests pile up.
pub struct Coalescer<T> {
    last: Option<(Instant, T)>,
}

impl<T: Clone> Coalescer<T> {
    pub const fn new() -> Self {
        Self { last: None }
    }

    pub fn run(&mut self, requested_at: Instant, compute: impl FnOnce() -> T) -> T {
        if let Some((started_at, value)) = &self.last {
            if *started_at >= requested_at {
                return value.clone();
            }
        }
        let started_at = Instant::now();
        let value = compute();
        self.last = Some((started_at, value.clone()));
        value
    }
}

/// Split the helper's combined reply into the two results the dashboard merges.
pub fn split_snapshot_reply(mut reply: Value) -> (Result<Value, String>, Result<Value, String>) {
    let mut take = |key: &str| match reply.get_mut(key).map(Value::take) {
        Some(value) if !value.is_null() => Ok(value),
        _ => Err(format!("dashboard helper reply has no {key}")),
    };
    let snapshot = take("snapshot");
    let supervisor = take("supervisor");
    (snapshot, supervisor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::Cell;
    use std::io::BufRead;
    use std::thread;

    const QUICK: Duration = Duration::from_secs(20);

    /// Stand-in for `paat dashboard-serve`, run as a child copy of this test binary.
    #[test]
    #[ignore = "fake dashboard-serve worker launched by the snapshot_worker tests"]
    fn fake_worker_process() {
        let mode = std::env::var("PAAT_FAKE_WORKER_MODE").unwrap_or_default();
        match mode.as_str() {
            "exit" => return,
            "stubborn" => {
                thread::sleep(Duration::from_secs(60));
                return;
            }
            _ => {}
        }
        // libtest has already printed "test <name> ... " without a newline;
        // end that line so the first reply isn't glued onto it.
        println!();
        let mut seq = 0;
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let Ok(request) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let id = request["id"].clone();
            seq += 1;
            let ok = json!({ "id": id, "ok": true, "result": { "method": request["method"], "pid": std::process::id(), "seq": seq } });
            match mode.as_str() {
                "hang" => continue,
                "error" => println!("{}", json!({ "id": id, "ok": false, "error": "boom" })),
                "flaky" if seq == 1 => {
                    println!("{}", json!({ "id": id, "ok": false, "error": "boom" }))
                }
                "noise" => {
                    println!("not json at all");
                    println!(
                        "{}",
                        json!({ "id": "someone-else", "ok": true, "result": 0 })
                    );
                    println!("{}", ok);
                }
                _ => println!("{}", ok),
            }
        }
    }

    fn fake_worker(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "snapshot_worker::tests::fake_worker_process",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("PAAT_FAKE_WORKER_MODE", mode);
        command
    }

    #[test]
    fn worker_answers_every_refresh_from_one_long_lived_process() {
        let mut worker = Worker::spawn(fake_worker("echo")).unwrap();
        let first = worker.request("snapshot", QUICK).unwrap();
        let second = worker.request("snapshot", QUICK).unwrap();
        let third = worker.request("snapshot", QUICK).unwrap();
        assert_eq!(first["method"], "snapshot");
        assert_eq!(
            first["pid"], second["pid"],
            "a refresh started a new worker process"
        );
        assert_eq!(
            second["pid"], third["pid"],
            "a refresh started a new worker process"
        );
        worker.shutdown();
    }

    #[test]
    fn worker_skips_noise_and_replies_meant_for_other_requests() {
        let mut worker = Worker::spawn(fake_worker("noise")).unwrap();
        let reply = worker.request("snapshot", QUICK).unwrap();
        assert_eq!(reply["method"], "snapshot");
        worker.shutdown();
    }

    #[test]
    fn worker_reports_an_error_reply() {
        let mut worker = Worker::spawn(fake_worker("error")).unwrap();
        let error = worker.request("snapshot", QUICK).unwrap_err().to_string();
        assert!(error.contains("boom"), "unexpected error: {error}");
        worker.shutdown();
    }

    #[test]
    fn worker_times_out_when_the_helper_stops_answering() {
        let mut worker = Worker::spawn(fake_worker("hang")).unwrap();
        let started = Instant::now();
        let error = worker
            .request("snapshot", Duration::from_millis(300))
            .unwrap_err()
            .to_string();
        assert!(error.contains("timed out"), "unexpected error: {error}");
        assert!(started.elapsed() < Duration::from_secs(5));
        worker.shutdown();
    }

    #[test]
    fn worker_reports_a_helper_that_exited() {
        let mut worker = Worker::spawn(fake_worker("exit")).unwrap();
        let error = worker.request("snapshot", QUICK).unwrap_err().to_string();
        assert!(error.contains("exited"), "unexpected error: {error}");
        worker.shutdown();
    }

    #[test]
    fn shutdown_stops_a_helper_that_ignores_its_input() {
        let worker = Worker::spawn(fake_worker("stubborn")).unwrap();
        let started = Instant::now();
        assert!(worker.shutdown().is_some(), "worker was not stopped");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn slot_reuses_its_worker_between_refreshes() {
        let mut slot = WorkerSlot::new(Duration::ZERO);
        let spawned = Cell::new(0);
        let factory = || {
            spawned.set(spawned.get() + 1);
            Ok(fake_worker("echo"))
        };
        let first = slot.request("snapshot", QUICK, factory).unwrap();
        let second = slot.request("snapshot", QUICK, factory).unwrap();
        assert_eq!(first["pid"], second["pid"]);
        assert_eq!(spawned.get(), 1, "the slot started more than one worker");
        slot.shutdown();
    }

    #[test]
    fn slot_replaces_a_worker_that_died_between_refreshes() {
        let mut slot = WorkerSlot::new(Duration::ZERO);
        let first = slot
            .request("snapshot", QUICK, || Ok(fake_worker("echo")))
            .unwrap();
        if let Some(worker) = slot.worker.as_mut() {
            worker.child.kill().unwrap();
            worker.child.wait().unwrap();
        }
        let second = slot
            .request("snapshot", QUICK, || Ok(fake_worker("echo")))
            .unwrap();
        assert_ne!(first["pid"], second["pid"]);
        slot.shutdown();
    }

    #[test]
    fn slot_retries_a_failed_worker_once_its_backoff_has_passed() {
        let mut slot = WorkerSlot::new(Duration::ZERO);
        assert!(slot
            .request("snapshot", QUICK, || Ok(fake_worker("exit")))
            .is_err());
        let reply = slot
            .request("snapshot", QUICK, || Ok(fake_worker("echo")))
            .unwrap();
        assert_eq!(reply["method"], "snapshot");
        slot.shutdown();
    }

    #[test]
    fn slot_waits_out_its_backoff_before_starting_another_worker() {
        let mut slot = WorkerSlot::new(Duration::from_secs(60));
        assert!(slot
            .request("snapshot", QUICK, || Ok(fake_worker("exit")))
            .is_err());
        let spawned = Cell::new(0);
        let error = slot
            .request("snapshot", QUICK, || {
                spawned.set(spawned.get() + 1);
                Ok(fake_worker("echo"))
            })
            .unwrap_err();
        assert!(error.contains("retry"), "unexpected error: {error}");
        assert_eq!(spawned.get(), 0, "a worker was started during the backoff");
        slot.shutdown();
    }

    #[test]
    fn slot_backs_off_when_the_worker_cannot_start() {
        let mut slot = WorkerSlot::new(Duration::from_secs(60));
        let error = slot
            .request("snapshot", QUICK, || {
                Err("paat is not installed".to_string())
            })
            .unwrap_err();
        assert!(error.contains("paat is not installed"));
        let spawned = Cell::new(0);
        assert!(slot
            .request("snapshot", QUICK, || {
                spawned.set(spawned.get() + 1);
                Ok(fake_worker("echo"))
            })
            .is_err());
        assert_eq!(spawned.get(), 0);
    }

    #[test]
    fn slot_keeps_a_healthy_helper_after_an_error_reply() {
        let mut slot = WorkerSlot::new(Duration::from_secs(60));
        let spawned = Cell::new(0);
        let factory = || {
            spawned.set(spawned.get() + 1);
            Ok(fake_worker("flaky"))
        };
        let error = slot.request("snapshot", QUICK, factory).unwrap_err();
        assert!(error.contains("boom"), "unexpected error: {error}");
        let reply = slot.request("snapshot", QUICK, factory).unwrap();
        assert_eq!(
            reply["seq"], 2,
            "the helper was replaced after an ordinary error reply"
        );
        assert_eq!(spawned.get(), 1);
        slot.shutdown();
    }

    #[test]
    fn slot_stops_an_idle_helper_and_restarts_it_on_demand() {
        let mut slot = WorkerSlot::new(Duration::ZERO);
        let first = slot
            .request("snapshot", QUICK, || Ok(fake_worker("echo")))
            .unwrap();
        slot.retire_if_idle(Duration::from_secs(60));
        assert!(slot.worker.is_some(), "a recently used helper was stopped");
        slot.retire_if_idle(Duration::ZERO);
        assert!(slot.worker.is_none(), "an idle helper kept running");
        let second = slot
            .request("snapshot", QUICK, || Ok(fake_worker("echo")))
            .unwrap();
        assert_ne!(first["pid"], second["pid"]);
        slot.shutdown();
    }

    #[test]
    fn coalescer_shares_a_refresh_that_began_after_the_caller_asked() {
        let mut coalescer = Coalescer::new();
        let asked = Instant::now();
        let runs = Cell::new(0);
        let compute = || {
            runs.set(runs.get() + 1);
            runs.get()
        };
        assert_eq!(coalescer.run(asked, compute), 1);
        // This caller queued while that refresh ran, and it began after they asked.
        assert_eq!(coalescer.run(asked, compute), 1);
        assert_eq!(runs.get(), 1);
    }

    #[test]
    fn coalescer_never_shares_a_refresh_that_began_before_the_caller_asked() {
        let mut coalescer = Coalescer::new();
        let runs = Cell::new(0);
        let compute = || {
            runs.set(runs.get() + 1);
            runs.get()
        };
        coalescer.run(Instant::now(), compute);
        // Asked while that refresh was already running, e.g. right after a Kill:
        // its data predates the request, so a fresh refresh is needed.
        let began = coalescer
            .last
            .as_ref()
            .map(|(started, _)| *started)
            .unwrap();
        assert_eq!(coalescer.run(began + Duration::from_nanos(1), compute), 2);
    }

    /// Manual end-to-end check against a real build, through an npm-style
    /// .cmd shim like the one `npm install -g` creates:
    ///   PAAT_REAL_CLI=<repo>\dist\src\cli\index.js cargo test --release real_helper -- --ignored --nocapture
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "manual: set PAAT_REAL_CLI to a built dist/src/cli/index.js"]
    fn real_helper_answers_through_an_npm_style_shim() {
        let cli = std::env::var("PAAT_REAL_CLI").expect("set PAAT_REAL_CLI");
        let dir = std::env::temp_dir().join(format!("paat-real-helper-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("paat.cmd");
        std::fs::write(&shim, format!("@echo off\r\nnode \"{cli}\" %*\r\n")).unwrap();
        let mut command = crate::cli::quiet_command(&shim);
        command.arg("dashboard-serve");
        let mut worker = Worker::spawn(command).unwrap();
        for refresh in 1..=3 {
            let started = Instant::now();
            let (snapshot, supervisor) =
                split_snapshot_reply(worker.request("snapshot", REQUEST_TIMEOUT).unwrap());
            let snapshot = snapshot.unwrap();
            assert!(snapshot["liveSessions"].is_array());
            assert!(supervisor.unwrap()["running"].is_boolean());
            println!(
                "refresh {refresh}: {} ms, {} live sessions",
                started.elapsed().as_millis(),
                snapshot["liveSessions"].as_array().map_or(0, Vec::len)
            );
        }
        let started = Instant::now();
        assert!(worker.shutdown().is_some());
        assert!(
            started.elapsed() < GRACEFUL_EXIT,
            "the helper did not exit by itself when its input closed"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn split_reply_separates_the_snapshot_from_the_supervisor_status() {
        let (snapshot, supervisor) = split_snapshot_reply(json!({
            "snapshot": { "ok": true, "liveSessions": [] },
            "supervisor": { "ok": true, "running": true },
        }));
        assert_eq!(snapshot.unwrap(), json!({ "ok": true, "liveSessions": [] }));
        assert_eq!(supervisor.unwrap(), json!({ "ok": true, "running": true }));
    }

    #[test]
    fn split_reply_reports_missing_parts() {
        let (snapshot, supervisor) = split_snapshot_reply(json!({ "unexpected": true }));
        assert!(snapshot.is_err());
        assert!(supervisor.is_err());
    }
}
