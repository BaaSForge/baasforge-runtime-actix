//! Micro-bench for QuickJS cold-start stages.
//!
//! ```text
//! cargo run --release --bin js_cold_start_bench -- --fixture heavy --mode bytecode --write
//! ```

use baal_runtime_actix::libs::unit_js::cold_start_fixtures;
use baal_runtime_actix::libs::unit_js::{
    run_unit_handler, snapshot_js_timings, JsInvokeTimings, TriggerHttpSnapshot,
};
use serde::Serialize;
use std::time::Instant;

#[derive(Serialize)]
struct Percentiles {
    p50_us: u128,
    p95_us: u128,
    p99_us: u128,
}

#[derive(Serialize)]
struct StageRow {
    total: Percentiles,
    runtime_create: Percentiles,
    llrt_attach: Percentiles,
    bootstrap_eval: Percentiles,
    module_declare: Percentiles,
    handler_exec: Percentiles,
}

#[derive(Serialize)]
struct BenchReport {
    fixture: String,
    mode: String,
    n: usize,
    rss_kb_after: Option<u64>,
    stages: StageRow,
    samples_us: Vec<u128>,
}

fn percentile(sorted: &[u128], p: f64) -> u128 {
    if sorted.is_empty() {
        return 0;
    }
    let idx = ((p / 100.0) * (sorted.len() as f64 - 1.0)).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

fn summarize(values: &[u128]) -> Percentiles {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    Percentiles {
        p50_us: percentile(&sorted, 50.0),
        p95_us: percentile(&sorted, 95.0),
        p99_us: percentile(&sorted, 99.0),
    }
}

fn rss_kb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            return rest
                .split_whitespace()
                .next()
                .and_then(|n| n.parse().ok());
        }
    }
    None
}

fn empty_snapshot() -> TriggerHttpSnapshot {
    TriggerHttpSnapshot {
        method: "GET".into(),
        url: "/".into(),
        header_pairs: vec![],
        body_text: String::new(),
        body_base64: String::new(),
        trigger_path: "/".into(),
    }
}

fn apply_mode(mode: &str) {
    // SAFETY: bench binary owns this process; flags are applied before any invoke.
    unsafe {
        match mode {
            "off" | "legacy" => {
                std::env::remove_var("BAAL_JS_BYTECODE");
                std::env::remove_var("BAAL_JS_RUNTIME_POOL");
            }
            "bytecode" => {
                std::env::set_var("BAAL_JS_BYTECODE", "1");
                std::env::remove_var("BAAL_JS_RUNTIME_POOL");
            }
            "pool" => {
                std::env::set_var("BAAL_JS_BYTECODE", "1");
                std::env::set_var("BAAL_JS_RUNTIME_POOL", "1");
            }
            other => panic!("unknown mode {other}; expected off|bytecode|pool"),
        }
    }
}

#[tokio::main]
async fn main() {
    let mut fixture = "hello".to_string();
    let mut mode = "off".to_string();
    let mut n: usize = 50;
    let mut write = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--fixture" => fixture = args.next().expect("--fixture value"),
            "--mode" => mode = args.next().expect("--mode value"),
            "--n" => n = args.next().expect("--n value").parse().expect("n"),
            "--write" => write = true,
            other => panic!("unknown arg {other}"),
        }
    }

    apply_mode(&mode);
    if mode == "bytecode" || mode == "pool" {
        baal_runtime_actix::libs::unit_js::bytecode::precompile_static_shims();
    }
    if mode == "pool" {
        baal_runtime_actix::libs::unit_js::js_pool::prewarm();
    }

    let source = cold_start_fixtures::source(&fixture).unwrap_or_else(|| {
        panic!("unknown fixture {fixture}");
    });
    let snap = empty_snapshot();

    // Discard 1 warmup.
    run_unit_handler(source, &snap, None, Some(&fixture))
        .await
        .unwrap_or_else(|e| panic!("warmup failed: {e}"));

    let mut totals = Vec::with_capacity(n);
    let mut runtime_create = Vec::with_capacity(n);
    let mut llrt_attach = Vec::with_capacity(n);
    let mut bootstrap_eval = Vec::with_capacity(n);
    let mut module_declare = Vec::with_capacity(n);
    let mut handler_exec = Vec::with_capacity(n);

    for i in 0..n {
        let started = Instant::now();
        let res = run_unit_handler(source, &snap, None, Some(&fixture))
            .await
            .unwrap_or_else(|e| panic!("invoke {i} failed: {e}"));
        if res.status != 200 {
            panic!("invoke {i} status {} body {}", res.status, res.body);
        }
        let wall = started.elapsed().as_micros();
        let t: JsInvokeTimings = snapshot_js_timings();
        totals.push(wall);
        runtime_create.push(t.runtime_create_us);
        llrt_attach.push(t.llrt_attach_us);
        bootstrap_eval.push(t.bootstrap_eval_us);
        module_declare.push(t.module_declare_us);
        handler_exec.push(t.handler_exec_us);
    }

    let report = BenchReport {
        fixture: fixture.clone(),
        mode: mode.clone(),
        n,
        rss_kb_after: rss_kb(),
        stages: StageRow {
            total: summarize(&totals),
            runtime_create: summarize(&runtime_create),
            llrt_attach: summarize(&llrt_attach),
            bootstrap_eval: summarize(&bootstrap_eval),
            module_declare: summarize(&module_declare),
            handler_exec: summarize(&handler_exec),
        },
        samples_us: totals.clone(),
    };

    let json = serde_json::to_string_pretty(&report).expect("json");
    println!("{json}");

    if write {
        let path = format!("docs/js-cold-start-{mode}-{fixture}.json");
        std::fs::create_dir_all("docs").ok();
        std::fs::write(&path, json).expect("write report");
        eprintln!("wrote {path}");
    }
}
