//! Run API unit JavaScript in QuickJS with a Node-like `req` / `res` bound to the incoming HTTP request.
//!
//! URL and URLSearchParams are provided as Rust-backed classes (see [`url`]).
//! Request/response data is passed via `rquickjs-serde` — no JSON roundtrips.

pub mod actor_runner;
pub mod common_imports;
pub mod modules;
pub mod queue_worker_runner;
pub mod types;
pub mod unit_prompts;
pub mod workflow_runner;

mod api_runner;
mod error;

pub use api_runner::run_unit_handler;
pub use common_imports::{
    prepare_compiled_unit_source, prepare_source_for_comm, prepare_source_scoped,
    ImportResolveCtx, PrepareError, UNNAMED_IMPORT_MSG, WRONG_IMPORT_MSG,
};
pub use modules::sdk::{SdkCommCtx, set_comm_ctx, clear_comm_ctx};
pub use types::{TriggerHttpResponse, TriggerHttpSnapshot};
