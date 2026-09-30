use crate::{CoreError, FailureKind, GenerationAttempt, MAX_TIMEOUT};
use std::{
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

#[derive(Debug)]
struct CancellationState {
    cancelled: AtomicBool,
    wait_lock: Mutex<()>,
    wake: Condvar,
    async_wake: tokio::sync::Notify,
}

#[derive(Debug, Clone)]
pub struct CancellationToken {
    state: Arc<CancellationState>,
}

impl Default for CancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

impl CancellationToken {
    pub fn new() -> Self {
        Self {
            state: Arc::new(CancellationState {
                cancelled: AtomicBool::new(false),
                wait_lock: Mutex::new(()),
                wake: Condvar::new(),
                async_wake: tokio::sync::Notify::new(),
            }),
        }
    }

    pub fn cancel(&self) {
        self.state.cancelled.store(true, Ordering::Release);
        self.state.wake.notify_all();
        self.state.async_wake.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.state.cancelled.load(Ordering::Acquire)
    }

    pub fn check(&self) -> Result<(), CoreError> {
        if self.is_cancelled() {
            Err(CoreError::new(
                FailureKind::Cancellation,
                "operation was cancelled",
            ))
        } else {
            Ok(())
        }
    }

    /// Waits until cancellation or the supplied duration elapses.
    /// Returns `true` when cancelled.
    pub fn wait_timeout(&self, duration: Duration) -> bool {
        if self.is_cancelled() {
            return true;
        }
        let guard = self
            .state
            .wait_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _ = self
            .state
            .wake
            .wait_timeout_while(guard, duration, |_| !self.is_cancelled())
            .unwrap_or_else(|e| e.into_inner());
        self.is_cancelled()
    }

    pub async fn cancelled(&self) {
        loop {
            let notified = self.state.async_wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Debug, Clone)]
pub struct OperationControl {
    cancellation: CancellationToken,
    deadline: Option<Instant>,
    summaries: Arc<Mutex<[String; 2]>>,
    summary_sink: Option<tokio::sync::mpsc::Sender<String>>,
}

impl OperationControl {
    pub fn new(timeout: Duration, cancellation: CancellationToken) -> Result<Self, CoreError> {
        if timeout.is_zero() || timeout > MAX_TIMEOUT {
            return Err(CoreError::new(
                FailureKind::Timeout,
                "timeout is outside the supported range",
            ));
        }
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| CoreError::new(FailureKind::Timeout, "timeout is invalid"))?;
        Ok(Self {
            cancellation,
            deadline: Some(deadline),
            summaries: Arc::default(),
            summary_sink: None,
        })
    }

    /// Generation can wait for the provider without imposing a local time limit.
    pub fn until_cancelled(cancellation: CancellationToken) -> Self {
        Self {
            cancellation,
            deadline: None,
            summaries: Arc::default(),
            summary_sink: None,
        }
    }

    pub fn cancellation(&self) -> &CancellationToken {
        &self.cancellation
    }

    pub fn with_summary_sink(mut self, sink: tokio::sync::mpsc::Sender<String>) -> Self {
        self.summary_sink = Some(sink);
        self
    }

    /// Summaries are provider-facing text, separate from the schema-valid output.
    /// The entire generation, including a repair, retains at most 16 KiB of UTF-8.
    pub async fn emit_reasoning_summary(&self, attempt: GenerationAttempt, text: &str) {
        let retained = {
            let mut summaries = self.summaries.lock().expect("summary state poisoned");
            let remaining = 16_384_usize.saturating_sub(summaries.iter().map(String::len).sum());
            let mut end = remaining.min(text.len());
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            let retained = text[..end].to_owned();
            summaries[usize::from(attempt == GenerationAttempt::SchemaRepair)].push_str(&retained);
            retained
        };
        if !retained.is_empty()
            && let Some(sink) = &self.summary_sink
        {
            let _ = sink.send(retained).await;
        }
    }

    pub fn reasoning_summary(&self, attempt: GenerationAttempt) -> Option<String> {
        let summaries = self.summaries.lock().expect("summary state poisoned");
        let summary = &summaries[usize::from(attempt == GenerationAttempt::SchemaRepair)];
        (!summary.is_empty()).then(|| summary.clone())
    }

    pub fn remaining(&self) -> Option<Duration> {
        self.deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
    }

    pub fn check(&self) -> Result<(), CoreError> {
        self.cancellation.check()?;
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(CoreError::new(FailureKind::Timeout, "operation timed out"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_is_shared_and_observable_before_start() {
        let token = CancellationToken::new();
        let peer = token.clone();
        peer.cancel();
        assert_eq!(token.check().unwrap_err().kind(), FailureKind::Cancellation);
    }

    #[test]
    fn unbounded_generation_still_observes_cancellation() {
        let token = CancellationToken::new();
        let control = OperationControl::until_cancelled(token.clone());
        assert!(control.remaining().is_none());
        assert!(control.check().is_ok());
        token.cancel();
        assert_eq!(
            control.check().unwrap_err().kind(),
            FailureKind::Cancellation
        );
    }

    #[test]
    fn deadline_expires_and_timeout_is_bounded() {
        assert!(
            OperationControl::new(
                MAX_TIMEOUT + Duration::from_secs(1),
                CancellationToken::new()
            )
            .is_err()
        );
        let control =
            OperationControl::new(Duration::from_millis(1), CancellationToken::new()).unwrap();
        std::thread::sleep(Duration::from_millis(3));
        assert_eq!(control.check().unwrap_err().kind(), FailureKind::Timeout);
    }
}
