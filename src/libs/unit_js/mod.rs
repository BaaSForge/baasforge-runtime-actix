//! Run API unit JavaScript in QuickJS with a Node-like `req` / `res` bound to the incoming HTTP request.
//!
//! URL and URLSearchParams are provided as Rust-backed classes (see [`url`]).
//! Request/response data is passed via `rquickjs-serde` — no JSON roundtrips.

pub mod modules;
pub mod types;
pub mod workflow_runner;

mod error;
mod runner;

pub use runner::run_unit_handler;
pub use types::{TriggerHttpResponse, TriggerHttpSnapshot};
