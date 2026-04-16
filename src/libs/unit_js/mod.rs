//! Run API unit JavaScript in QuickJS with a Node-like `req` / `res` bound to the incoming HTTP request.
//!
//! URL and URLSearchParams are provided as Rust-backed classes (see [`url`]).
//! Request/response data is passed via `rquickjs-serde` — no JSON roundtrips.

pub mod modules;
pub mod queue_worker_runner;
pub mod types;
pub mod workflow_runner;

mod api_runner;
mod error;

pub use api_runner::run_unit_handler;
pub use types::{TriggerHttpResponse, TriggerHttpSnapshot};
