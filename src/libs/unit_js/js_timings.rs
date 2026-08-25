//! Per-invoke QuickJS stage timings (thread-local).
//!
//! Populated by the runners and the module loader; the cold-start bench reads
//! [`snapshot`] after each [`super::api_runner::run_unit_handler`] call.

use std::cell::RefCell;
use std::time::Duration;

#[derive(Debug, Clone, Default)]
pub struct JsInvokeTimings {
    pub runtime_create_us: u128,
    pub llrt_attach_us: u128,
    pub bootstrap_eval_us: u128,
    pub module_declare_us: u128,
    pub handler_exec_us: u128,
    pub from_pool: bool,
    pub bytecode_hits: u32,
    pub bytecode_misses: u32,
    pub last_specifier: String,
}

impl JsInvokeTimings {
    pub fn total_us(&self) -> u128 {
        self.runtime_create_us
            + self.llrt_attach_us
            + self.bootstrap_eval_us
            + self.module_declare_us
            + self.handler_exec_us
    }
}

thread_local! {
    static CURRENT: RefCell<JsInvokeTimings> = const { RefCell::new(JsInvokeTimings {
        runtime_create_us: 0,
        llrt_attach_us: 0,
        bootstrap_eval_us: 0,
        module_declare_us: 0,
        handler_exec_us: 0,
        from_pool: false,
        bytecode_hits: 0,
        bytecode_misses: 0,
        last_specifier: String::new(),
    }) };
}

pub fn reset() {
    CURRENT.with(|c| *c.borrow_mut() = JsInvokeTimings::default());
}

pub fn snapshot() -> JsInvokeTimings {
    CURRENT.with(|c| c.borrow().clone())
}

pub fn set_runtime_create(d: Duration, from_pool: bool) {
    CURRENT.with(|c| {
        let mut t = c.borrow_mut();
        t.runtime_create_us = d.as_micros();
        t.from_pool = from_pool;
    });
}

pub fn set_llrt_attach(d: Duration) {
    CURRENT.with(|c| c.borrow_mut().llrt_attach_us = d.as_micros());
}

pub fn set_bootstrap_eval(d: Duration) {
    CURRENT.with(|c| c.borrow_mut().bootstrap_eval_us = d.as_micros());
}

pub fn set_handler_exec(d: Duration) {
    CURRENT.with(|c| c.borrow_mut().handler_exec_us = d.as_micros());
}

pub fn add_module_declare(d: Duration, specifier: &str) {
    CURRENT.with(|c| {
        let mut t = c.borrow_mut();
        t.module_declare_us = t.module_declare_us.saturating_add(d.as_micros());
        t.last_specifier = specifier.to_string();
    });
}

pub fn record_bytecode_hit() {
    CURRENT.with(|c| {
        let mut t = c.borrow_mut();
        t.bytecode_hits = t.bytecode_hits.saturating_add(1);
    });
}

pub fn record_bytecode_miss() {
    CURRENT.with(|c| {
        let mut t = c.borrow_mut();
        t.bytecode_misses = t.bytecode_misses.saturating_add(1);
    });
}

pub fn emit_trace(op: &'static str) {
    let t = snapshot();
    tracing::info!(
        target: "js.cold_start",
        op,
        runtime_create_us = t.runtime_create_us,
        llrt_attach_us = t.llrt_attach_us,
        bootstrap_eval_us = t.bootstrap_eval_us,
        module_declare_us = t.module_declare_us,
        handler_exec_us = t.handler_exec_us,
        total_us = t.total_us(),
        from_pool = t.from_pool,
        bytecode_hits = t.bytecode_hits,
        bytecode_misses = t.bytecode_misses,
        last_specifier = t.last_specifier.as_str(),
        "js invoke stages"
    );
}
