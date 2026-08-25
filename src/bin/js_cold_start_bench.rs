//! Micro-bench for QuickJS invoke time with/without the in-memory bytecode cache.
//!
//! ```text
//! cargo run --release --bin js_cold_start_bench -- --fixture heavy --mode bytecode
//! ```

use baal_runtime_actix::libs::unit_js::{run_unit_handler, TriggerHttpSnapshot};
use serde::Serialize;
use std::time::Instant;

#[derive(Serialize)]
struct Percentiles {
    p50_us: u128,
    p95_us: u128,
    p99_us: u128,
}

#[derive(Serialize)]
struct BenchReport {
    fixture: String,
    mode: String,
    n: usize,
    rss_kb_after: Option<u64>,
    total: Percentiles,
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
            "off" => {
                std::env::remove_var("BAAL_JS_BYTECODE");
            }
            "bytecode" => {
                std::env::set_var("BAAL_JS_BYTECODE", "1");
            }
            other => panic!("unknown mode {other}; expected off|bytecode"),
        }
    }
}

const HELLO: &str = r#"
export function handleRequest(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}
"#;

const HEAVY: &str = r#"
import { z } from "zod";
import { SignJWT } from "jose";
import { get } from "lodash-es";
export async function handleRequest(req, res) {
  const schema = z.object({ n: z.number() });
  const n = schema.parse({ n: get({ n: 1 }, "n") }).n;
  const secret = new TextEncoder().encode("baal-cold-start-bench-secret-key!!");
  const token = await new SignJWT({ n })
    .setProtectedHeader({ alg: "HS256" })
    .sign(secret);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ n, tokenLen: token.length }));
}
"#;

fn fixture_source(name: &str) -> Option<&'static str> {
    match name {
        "hello" => Some(HELLO),
        "heavy" => Some(HEAVY),
        _ => None,
    }
}

#[tokio::main]
async fn main() {
    let mut fixture = "hello".to_string();
    let mut mode = "off".to_string();
    let mut n: usize = 50;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--fixture" => fixture = args.next().expect("--fixture value"),
            "--mode" => mode = args.next().expect("--mode value"),
            "--n" => n = args.next().expect("--n value").parse().expect("n"),
            other => panic!("unknown arg {other}"),
        }
    }

    apply_mode(&mode);
    if mode == "bytecode" {
        baal_runtime_actix::libs::unit_js::bytecode::precompile_static_shims();
    }

    let source = fixture_source(&fixture).unwrap_or_else(|| {
        panic!("unknown fixture {fixture}; expected hello|heavy");
    });
    let snap = empty_snapshot();

    run_unit_handler(source, &snap, None, Some(&fixture))
        .await
        .unwrap_or_else(|e| panic!("warmup failed: {e}"));

    let mut totals = Vec::with_capacity(n);
    for i in 0..n {
        let started = Instant::now();
        let res = run_unit_handler(source, &snap, None, Some(&fixture))
            .await
            .unwrap_or_else(|e| panic!("invoke {i} failed: {e}"));
        if res.status != 200 {
            panic!("invoke {i} status {} body {}", res.status, res.body);
        }
        totals.push(started.elapsed().as_micros());
    }

    let report = BenchReport {
        fixture: fixture.clone(),
        mode: mode.clone(),
        n,
        rss_kb_after: rss_kb(),
        total: summarize(&totals),
        samples_us: totals,
    };

    println!("{}", serde_json::to_string_pretty(&report).expect("json"));
}
