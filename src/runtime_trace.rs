//! Verbose terminal tracing for API integration tests and concurrency debugging.
//!
//! Enable: `RUST_LOG=runtime_trace=info` (set by `units/api-tests/test.sh` in TEST_MODE).

#[macro_export]
macro_rules! rt_enter {
    ($op:expr $(, $($rest:tt)*)?) => {
        tracing::info!(target: "runtime_trace", phase = "enter", op = $op $(, $($rest)*)?)
    };
}

#[macro_export]
macro_rules! rt_exit_ok {
    ($op:expr $(, $($rest:tt)*)?) => {
        { tracing::info!(target: "runtime_trace", phase = "exit_ok", op = $op $(, $($rest)*)?); }
    };
}

#[macro_export]
macro_rules! rt_exit_err {
    ($op:expr $(, $($rest:tt)*)?) => {
        { tracing::info!(target: "runtime_trace", phase = "exit_err", op = $op $(, $($rest)*)?); }
    };
}

#[macro_export]
macro_rules! rt_step {
    ($step:expr $(, $($rest:tt)*)?) => {
        tracing::info!(target: "runtime_trace", step = $step $(, $($rest)*)?)
    };
}
