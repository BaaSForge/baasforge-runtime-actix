//! Workflow integration test binary.
//!
//! Discovers compiled JS workflow units in a directory, runs each through the
//! real workflow engine backed by Redis, orchestrates suspend/resume cycles,
//! and outputs a JSON report identical in shape to the runtime-check suite.
//!
//! No NATS required — sleep timers and promise wakes are handled in-process by
//! the test harness.
//!
//! ```sh
//! WF_REDIS_URL=redis://127.0.0.1:16379 WORKFLOW_DIST=units/workflow-tests/dist \
//!   cargo run --bin test_workflow --release
//! ```

use baal_runtime_actix::libs::ids::new_uuid;
use baal_runtime_actix::services::workflow_engine::{
    self, SharedRedis,
};
use redis::AsyncCommands;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

struct TestDef {
    name: &'static str,
    category: &'static str,
    js_file: &'static str,
    input: &'static str,
    handlers: &'static [H],
    timeout_promise: bool,
    cancel_on_suspend: bool,
    retry_step: Option<&'static str>,
    retry_max: usize,
    crash_clear_steps: &'static [&'static str],
    replay: bool,
    dedup: bool,
    checks: &'static [Check],
}

struct H {
    name: &'static str,
    input: &'static str,
}

enum Check {
    Eq(&'static str, fn() -> Value),
    True(&'static str),
    NotNull(&'static str),
    Contains(&'static str, &'static str),
}

#[derive(Clone)]
struct TestResult {
    name: String,
    category: String,
    pass: bool,
    detail: Option<String>,
    error: Option<String>,
}

const PROJECT_ID: &str = "test-project-00000000";

// ---------------------------------------------------------------------------
// JSON path helper
// ---------------------------------------------------------------------------

fn json_get<'a>(val: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = val;
    for part in path.split('.') {
        if let Ok(idx) = part.parse::<usize>() {
            current = current.get(idx)?;
        } else {
            current = current.get(part)?;
        }
    }
    Some(current)
}

fn apply_check(output: &Value, check: &Check) -> Result<(), String> {
    match check {
        Check::Eq(path, expected_fn) => {
            let actual = json_get(output, path)
                .ok_or_else(|| format!("missing field '{path}'"))?;
            let expected = expected_fn();
            if actual != &expected {
                Err(format!("'{path}': expected {expected}, got {actual}"))
            } else {
                Ok(())
            }
        }
        Check::True(path) => {
            let actual = json_get(output, path)
                .ok_or_else(|| format!("missing field '{path}'"))?;
            if actual != &json!(true) {
                Err(format!("'{path}': expected true, got {actual}"))
            } else {
                Ok(())
            }
        }
        Check::NotNull(path) => {
            let actual = json_get(output, path)
                .ok_or_else(|| format!("missing field '{path}'"))?;
            if actual.is_null() {
                Err(format!("'{path}': expected non-null"))
            } else {
                Ok(())
            }
        }
        Check::Contains(path, substr) => {
            let actual = json_get(output, path)
                .ok_or_else(|| format!("missing field '{path}'"))?;
            let s = actual.as_str().ok_or_else(|| format!("'{path}': not a string"))?;
            if !s.contains(substr) {
                Err(format!("'{path}': '{s}' does not contain '{substr}'"))
            } else {
                Ok(())
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Redis helpers
// ---------------------------------------------------------------------------

fn redis_key(project_id: &str, instance_id: &str, suffix: &str) -> String {
    format!("wf:{project_id}:{instance_id}:{suffix}")
}

async fn clean_instance(redis: &SharedRedis, project_id: &str, instance_id: &str) -> Result<(), String> {
    let pattern = format!("wf:{project_id}:{instance_id}:*");
    let mut conn = redis.lock().await;
    let keys: Vec<String> = redis::cmd("KEYS")
        .arg(&pattern)
        .query_async(&mut *conn)
        .await
        .map_err(|e| format!("KEYS failed: {e}"))?;
    for key in &keys {
        let _: () = conn.del::<_, ()>(key).await.map_err(|e| format!("DEL failed: {e}"))?;
    }
    Ok(())
}

async fn get_meta_status(redis: &SharedRedis, pid: &str, iid: &str) -> Result<String, String> {
    let key = redis_key(pid, iid, "meta");
    let mut conn = redis.lock().await;
    let raw: Option<String> = conn.get(&key).await.map_err(|e| e.to_string())?;
    let raw = raw.ok_or("meta not found")?;
    let meta: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    Ok(meta["status"].as_str().unwrap_or("unknown").to_string())
}

async fn get_result_value(redis: &SharedRedis, pid: &str, iid: &str) -> Result<Value, String> {
    let key = redis_key(pid, iid, "result");
    let mut conn = redis.lock().await;
    let raw: Option<String> = conn.get(&key).await.map_err(|e| e.to_string())?;
    let raw = raw.ok_or("result not found")?;
    serde_json::from_str(&raw).map_err(|e| format!("parse result: {e}"))
}

async fn get_suspended_info(redis: &SharedRedis, pid: &str, iid: &str) -> Result<Value, String> {
    let key = redis_key(pid, iid, "suspended");
    let mut conn = redis.lock().await;
    let raw: Option<String> = conn.get(&key).await.map_err(|e| e.to_string())?;
    let raw = raw.ok_or("suspended info not found")?;
    serde_json::from_str(&raw).map_err(|e| format!("parse suspended: {e}"))
}

async fn mark_sleep_elapsed(redis: &SharedRedis, pid: &str, iid: &str, name: &str) -> Result<(), String> {
    let key = redis_key(pid, iid, &format!("sleep:{name}"));
    let val = json!({"elapsed": true}).to_string();
    let mut conn = redis.lock().await;
    let _: () = conn.set(&key, &val).await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn mark_promise_timed_out(redis: &SharedRedis, pid: &str, iid: &str, name: &str) -> Result<(), String> {
    let key = redis_key(pid, iid, &format!("promise:{name}"));
    let val = json!({"status": "timed_out"}).to_string();
    let mut conn = redis.lock().await;
    let _: () = conn.set(&key, &val).await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn clear_step(redis: &SharedRedis, pid: &str, iid: &str, step: &str) -> Result<(), String> {
    let key = redis_key(pid, iid, &format!("step:{step}"));
    let mut conn = redis.lock().await;
    let _: () = conn.del(&key).await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn clear_result_and_meta_for_replay(redis: &SharedRedis, pid: &str, iid: &str) -> Result<(), String> {
    let mut conn = redis.lock().await;
    let _: () = conn.del::<_, ()>(redis_key(pid, iid, "result")).await.map_err(|e| e.to_string())?;
    let _: () = conn.del::<_, ()>(redis_key(pid, iid, "meta")).await.map_err(|e| e.to_string())?;
    let _: () = conn.del::<_, ()>(redis_key(pid, iid, "suspended")).await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn reset_meta_to_running(redis: &SharedRedis, pid: &str, iid: &str) -> Result<(), String> {
    let key = redis_key(pid, iid, "meta");
    let mut conn = redis.lock().await;
    let raw: Option<String> = conn.get(&key).await.map_err(|e| e.to_string())?;
    let Some(raw) = raw else { return Err("meta not found for reset".into()); };
    let mut meta: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    meta["status"] = json!("running");
    let updated = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    let _: () = conn.set(&key, &updated).await.map_err(|e| e.to_string())?;
    // Also clear suspended info
    let _: () = conn.del::<_, ()>(redis_key(pid, iid, "suspended")).await.map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async fn run_test(redis: &SharedRedis, dist_dir: &Path, test: &TestDef) -> TestResult {
    let js_path = dist_dir.join(test.js_file);
    let source = match std::fs::read_to_string(&js_path) {
        Ok(s) => s,
        Err(e) => return TestResult {
            name: test.name.to_string(),
            category: test.category.to_string(),
            pass: false,
            detail: None,
            error: Some(format!("cannot read {}: {e}", js_path.display())),
        },
    };

    let instance_id = new_uuid().to_string();
    let nats: Option<async_nats::Client> = None;

    if let Err(e) = clean_instance(redis, PROJECT_ID, &instance_id).await {
        return fail(test, &format!("clean failed: {e}"));
    }

    if test.dedup {
        return run_dedup_test(redis, &source, &instance_id, test).await;
    }
    if test.cancel_on_suspend {
        return run_cancel_test(redis, &source, &instance_id, test).await;
    }

    let mut handler_idx: usize = 0;
    let mut retry_count: usize = 0;

    let start_err = workflow_engine::start_workflow(
        redis, &nats, PROJECT_ID, "test.wf.test", &instance_id, test.input, &source,
    ).await.err();

    if let Some(ref e) = start_err {
        if test.retry_step.is_some() && retry_count < test.retry_max {
            // will retry below
        } else {
            return fail(test, &format!("start failed: {e}"));
        }
    }

    for iteration in 0..100 {
        let status = match get_meta_status(redis, PROJECT_ID, &instance_id).await {
            Ok(s) => s,
            Err(e) => return fail(test, &format!("get status: {e}")),
        };

        match status.as_str() {
            "completed" => {
                let output = match get_result_value(redis, PROJECT_ID, &instance_id).await {
                    Ok(v) => v,
                    Err(e) => return fail(test, &format!("get result: {e}")),
                };

                if test.replay && iteration == 0 {
                    return run_replay_test(redis, &source, &instance_id, &output, test).await;
                }
                if !test.crash_clear_steps.is_empty() && iteration == 0 {
                    return run_crash_replay_test(redis, &source, &instance_id, test).await;
                }

                return validate(test, &output);
            }
            "suspended" => {
                let info = match get_suspended_info(redis, PROJECT_ID, &instance_id).await {
                    Ok(v) => v,
                    Err(e) => return fail(test, &format!("get suspended: {e}")),
                };
                let stype = info["type"].as_str().unwrap_or("");
                let sname = info["name"].as_str().unwrap_or("").to_string();

                match stype {
                    "sleep" => {
                        if let Err(e) = mark_sleep_elapsed(redis, PROJECT_ID, &instance_id, &sname).await {
                            return fail(test, &format!("mark sleep: {e}"));
                        }
                    }
                    "promise" => {
                        if test.timeout_promise {
                            if let Err(e) = mark_promise_timed_out(redis, PROJECT_ID, &instance_id, &sname).await {
                                return fail(test, &format!("mark timeout: {e}"));
                            }
                        } else if handler_idx < test.handlers.len() {
                            let h = &test.handlers[handler_idx];
                            if let Err(e) = workflow_engine::call_handler(
                                redis, &nats, PROJECT_ID, &instance_id, h.name, h.input, &source,
                            ).await {
                                return fail(test, &format!("handler '{}' failed: {e}", h.name));
                            }
                            handler_idx += 1;
                        } else {
                            return fail(test, &format!("unexpected promise suspension: {sname} (no handler left)"));
                        }
                    }
                    _ => return fail(test, &format!("unknown suspension type: {stype}")),
                }

                if let Err(e) = workflow_engine::resume_workflow(
                    redis, &nats, PROJECT_ID, &instance_id, &source,
                ).await {
                    if test.retry_step.is_some() && retry_count < test.retry_max {
                        // retry below
                    } else {
                        return fail(test, &format!("resume failed (iter {iteration}): {e}"));
                    }
                }
            }
            "failed" => {
                if let Some(step) = test.retry_step
                    && retry_count < test.retry_max
                {
                    retry_count += 1;
                    let _ = clear_step(redis, PROJECT_ID, &instance_id, step).await;
                    let _ = reset_meta_to_running(redis, PROJECT_ID, &instance_id).await;
                    {
                        let mut conn = redis.lock().await;
                        let _: Result<(), _> = conn.del::<_, ()>(redis_key(PROJECT_ID, &instance_id, "result")).await;
                    }
                    let _ = workflow_engine::resume_workflow(
                        redis, &nats, PROJECT_ID, &instance_id, &source,
                    ).await;
                    continue;
                }
                return fail(test, "workflow failed unexpectedly");
            }
            "cancelled" => return fail(test, "workflow cancelled unexpectedly"),
            other => return fail(test, &format!("unknown status: {other}")),
        }
    }
    fail(test, "max iterations (100) exceeded — possible infinite loop")
}

async fn run_dedup_test(redis: &SharedRedis, source: &str, iid: &str, test: &TestDef) -> TestResult {
    let nats: Option<async_nats::Client> = None;

    // First run
    if let Err(e) = workflow_engine::start_workflow(
        redis, &nats, PROJECT_ID, "test.wf.test", iid, r#"{"salt":"first-call"}"#, source,
    ).await {
        return fail(test, &format!("dedup first start: {e}"));
    }

    // Wait for completion
    for _ in 0..50 {
        match get_meta_status(redis, PROJECT_ID, iid).await {
            Ok(s) if s == "completed" => break,
            Ok(s) if s == "suspended" => {
                let info = get_suspended_info(redis, PROJECT_ID, iid).await.unwrap_or_default();
                let stype = info["type"].as_str().unwrap_or("");
                let sname = info["name"].as_str().unwrap_or("").to_string();
                if stype == "sleep" {
                    let _ = mark_sleep_elapsed(redis, PROJECT_ID, iid, &sname).await;
                }
                let _ = workflow_engine::resume_workflow(redis, &nats, PROJECT_ID, iid, source).await;
            }
            _ => break,
        }
    }

    let first_result = match get_result_value(redis, PROJECT_ID, iid).await {
        Ok(v) => v,
        Err(e) => return fail(test, &format!("dedup get first result: {e}")),
    };

    // Second run with same instance_id but different input
    let _ = workflow_engine::start_workflow(
        redis, &nats, PROJECT_ID, "test.wf.test", iid, r#"{"salt":"second-call"}"#, source,
    ).await;

    let second_result = match get_result_value(redis, PROJECT_ID, iid).await {
        Ok(v) => v,
        Err(e) => return fail(test, &format!("dedup get second result: {e}")),
    };

    // The nonce must be identical (dedup returned existing, didn't re-run)
    let first_nonce = json_get(&first_result, "once.nonce");
    let second_nonce = json_get(&second_result, "once.nonce");
    if first_nonce != second_nonce {
        return fail(test, &format!(
            "dedup failed: nonces differ — first={first_nonce:?}, second={second_nonce:?}"
        ));
    }
    // Salt must be from first call
    let salt = json_get(&first_result, "once.salt");
    if salt != Some(&json!("first-call")) {
        return fail(test, &format!("dedup: salt should be 'first-call', got {salt:?}"));
    }

    validate(test, &first_result)
}

async fn run_cancel_test(redis: &SharedRedis, source: &str, iid: &str, test: &TestDef) -> TestResult {
    let nats: Option<async_nats::Client> = None;

    if let Err(e) = workflow_engine::start_workflow(
        redis, &nats, PROJECT_ID, "test.wf.test", iid, test.input, source,
    ).await {
        return fail(test, &format!("cancel start: {e}"));
    }

    let status = match get_meta_status(redis, PROJECT_ID, iid).await {
        Ok(s) => s,
        Err(e) => return fail(test, &format!("cancel get status: {e}")),
    };

    if status != "suspended" {
        return fail(test, &format!("expected suspended before cancel, got '{status}'"));
    }

    if let Err(e) = workflow_engine::cancel_workflow(redis, PROJECT_ID, iid).await {
        return fail(test, &format!("cancel_workflow: {e}"));
    }

    let final_status = match get_meta_status(redis, PROJECT_ID, iid).await {
        Ok(s) => s,
        Err(e) => return fail(test, &format!("cancel final status: {e}")),
    };

    if final_status != "cancelled" {
        return fail(test, &format!("expected cancelled, got '{final_status}'"));
    }

    // Verify no result was committed
    let result_key = redis_key(PROJECT_ID, iid, "result");
    let has_result: bool = {
        let mut conn = redis.lock().await;
        conn.exists(&result_key).await.unwrap_or(false)
    };
    if has_result {
        return fail(test, "result key exists after cancellation — should not have been committed");
    }

    pass(test, "cancelled successfully, no result committed")
}

async fn run_replay_test(
    redis: &SharedRedis, source: &str, iid: &str, first_output: &Value, test: &TestDef,
) -> TestResult {
    let nats: Option<async_nats::Client> = None;

    // Clear result + meta (keep steps/sleeps/promises) so we can re-run
    if let Err(e) = clear_result_and_meta_for_replay(redis, PROJECT_ID, iid).await {
        return fail(test, &format!("replay clear: {e}"));
    }

    // Re-start with same instance (meta gone, so dedup won't trigger)
    if let Err(e) = workflow_engine::start_workflow(
        redis, &nats, PROJECT_ID, "test.wf.test", iid, test.input, source,
    ).await {
        return fail(test, &format!("replay start: {e}"));
    }

    // Orchestrate to completion
    for _ in 0..50 {
        match get_meta_status(redis, PROJECT_ID, iid).await {
            Ok(s) if s == "completed" => break,
            Ok(s) if s == "suspended" => {
                let info = get_suspended_info(redis, PROJECT_ID, iid).await.unwrap_or_default();
                let stype = info["type"].as_str().unwrap_or("");
                let sname = info["name"].as_str().unwrap_or("").to_string();
                if stype == "sleep" {
                    let _ = mark_sleep_elapsed(redis, PROJECT_ID, iid, &sname).await;
                }
                let _ = workflow_engine::resume_workflow(redis, &nats, PROJECT_ID, iid, source).await;
            }
            _ => break,
        }
    }

    let replay_output = match get_result_value(redis, PROJECT_ID, iid).await {
        Ok(v) => v,
        Err(e) => return fail(test, &format!("replay get result: {e}")),
    };

    // Step markers must be identical across runs (memoization)
    let first_steps = json_get(first_output, "steps");
    let replay_steps = json_get(&replay_output, "steps");
    if first_steps != replay_steps {
        return fail(test, &format!(
            "replay mismatch: steps differ.\nfirst:  {first_steps:?}\nreplay: {replay_steps:?}"
        ));
    }

    validate(test, &replay_output)
}

async fn run_crash_replay_test(
    redis: &SharedRedis, source: &str, iid: &str, test: &TestDef,
) -> TestResult {
    let nats: Option<async_nats::Client> = None;

    // Clear specified steps (simulate crash before those steps persisted)
    for step in test.crash_clear_steps {
        if let Err(e) = clear_step(redis, PROJECT_ID, iid, step).await {
            return fail(test, &format!("crash clear step '{step}': {e}"));
        }
    }

    // Clear the result and reset meta (simulate process died after partial work)
    {
        let mut conn = redis.lock().await;
        let _: Result<(), _> = conn.del::<_, ()>(redis_key(PROJECT_ID, iid, "result")).await;
    }
    if let Err(e) = reset_meta_to_running(redis, PROJECT_ID, iid).await {
        return fail(test, &format!("crash reset meta: {e}"));
    }

    // Resume — cached steps are replayed, cleared steps re-execute
    if let Err(e) = workflow_engine::resume_workflow(
        redis, &nats, PROJECT_ID, iid, source,
    ).await {
        return fail(test, &format!("crash resume: {e}"));
    }

    // Orchestrate remaining suspensions to completion
    for _ in 0..50 {
        match get_meta_status(redis, PROJECT_ID, iid).await {
            Ok(s) if s == "completed" => break,
            Ok(s) if s == "suspended" => {
                let info = get_suspended_info(redis, PROJECT_ID, iid).await.unwrap_or_default();
                let stype = info["type"].as_str().unwrap_or("");
                let sname = info["name"].as_str().unwrap_or("").to_string();
                if stype == "sleep" {
                    let _ = mark_sleep_elapsed(redis, PROJECT_ID, iid, &sname).await;
                }
                let _ = workflow_engine::resume_workflow(redis, &nats, PROJECT_ID, iid, source).await;
            }
            _ => break,
        }
    }

    let output = match get_result_value(redis, PROJECT_ID, iid).await {
        Ok(v) => v,
        Err(e) => return fail(test, &format!("crash get result: {e}")),
    };

    validate(test, &output)
}

fn validate(test: &TestDef, output: &Value) -> TestResult {
    for check in test.checks {
        if let Err(msg) = apply_check(output, check) {
            return TestResult {
                name: test.name.to_string(),
                category: test.category.to_string(),
                pass: false,
                detail: Some(format!("output: {output}")),
                error: Some(msg),
            };
        }
    }
    TestResult {
        name: test.name.to_string(),
        category: test.category.to_string(),
        pass: true,
        detail: Some(format!("{output}")),
        error: None,
    }
}

fn fail(test: &TestDef, msg: &str) -> TestResult {
    TestResult {
        name: test.name.to_string(),
        category: test.category.to_string(),
        pass: false,
        detail: None,
        error: Some(msg.to_string()),
    }
}

fn pass(test: &TestDef, detail: &str) -> TestResult {
    TestResult {
        name: test.name.to_string(),
        category: test.category.to_string(),
        pass: true,
        detail: Some(detail.to_string()),
        error: None,
    }
}

// ---------------------------------------------------------------------------
// Test definitions — 48 tests grouped by category
// ---------------------------------------------------------------------------

fn all_tests() -> Vec<TestDef> {
    vec![
        // ---- basic (4) ----
        TestDef {
            name: "empty-workflow", category: "basic",
            js_file: "basic/empty-workflow.js",
            input: r#"{"value":42}"#,
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[Check::Eq("value", || json!(42))],
        },
        TestDef {
            name: "sequential-steps", category: "basic",
            js_file: "basic/sequential-steps.js",
            input: r#"{"seed":5}"#,
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("first", || json!(6)),
                Check::Eq("second", || json!(12)),
                Check::Eq("third", || json!(17)),
                Check::Eq("chain", || json!("6:12:17")),
            ],
        },
        TestDef {
            name: "step-return-types", category: "basic",
            js_file: "basic/step-return-types.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("str", || json!("baal-workflow")),
                Check::Eq("num", || json!(-3.5)),
                Check::Eq("obj.id", || json!(7)),
                Check::Eq("arr.0", || json!(10)),
                Check::Eq("nul", || json!(null)),
            ],
        },
        TestDef {
            name: "step-with-side-effects", category: "basic",
            js_file: "basic/step-with-side-effects.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("computed", || json!(47)),
                Check::Eq("scheduledMs", || json!(15)),
            ],
        },

        // ---- compensation (4) ----
        TestDef {
            name: "basic-compensation", category: "compensation",
            js_file: "compensation/basic-compensation.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("compensationOrder", || json!(["undo-reserve", "undo-charge"])),
            ],
        },
        TestDef {
            name: "compensation-failure", category: "compensation",
            js_file: "compensation/compensation-failure.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("compensationError", || json!("compensation blew up")),
                Check::True("undoReserveCompleted"),
            ],
        },
        TestDef {
            name: "nested-compensation", category: "compensation",
            js_file: "compensation/nested-compensation.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("outerUndoRan"),
                Check::Eq("innerLedger", || json!("nested-compensation-step")),
            ],
        },
        TestDef {
            name: "partial-compensation", category: "compensation",
            js_file: "compensation/partial-compensation.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("compensationOrder", || json!(["undo-reserve"])),
            ],
        },

        // ---- deterministic (3) ----
        TestDef {
            name: "date-now", category: "deterministic",
            js_file: "deterministic/date-now.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("nonDecreasing"),
                Check::NotNull("t1"),
                Check::NotNull("t2"),
            ],
        },
        TestDef {
            name: "rand-random", category: "deterministic",
            js_file: "deterministic/rand-random.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("inUnitInterval"),
                Check::NotNull("a"),
                Check::NotNull("b"),
            ],
        },
        TestDef {
            name: "rand-uuidv4", category: "deterministic",
            js_file: "deterministic/rand-uuidv4.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("stepsAreDistinct"),
                Check::NotNull("step1"),
                Check::NotNull("step2"),
            ],
        },

        // ---- memoization (3) ----
        TestDef {
            name: "idempotent-steps", category: "memoization",
            js_file: "memoization/idempotent-steps.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("valuesMatch"),
                Check::Eq("first.id", || json!(1)),
                Check::Eq("first.note", || json!("first-execution")),
            ],
        },
        TestDef {
            name: "step-cache-integrity", category: "memoization",
            js_file: "memoization/step-cache-integrity.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0,
            crash_clear_steps: &["cache-gamma"],
            replay: false, dedup: false,
            checks: &[
                Check::Eq("alpha.n", || json!(11)),
                Check::Eq("beta.sum", || json!(15)),
                Check::Eq("gamma.label", || json!("derived-15")),
                Check::NotNull("fingerprint"),
            ],
        },
        TestDef {
            name: "step-memoization", category: "memoization",
            js_file: "memoization/step-memoization.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[],
            replay: true, dedup: false,
            checks: &[
                Check::Eq("steps.0.ordinal", || json!(1)),
                Check::Eq("steps.1.ordinal", || json!(2)),
                Check::Eq("steps.2.ordinal", || json!(3)),
                Check::NotNull("instanceKey"),
            ],
        },

        // ---- parallel (2) ----
        TestDef {
            name: "promise-all", category: "parallel",
            js_file: "parallel/promise-all.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("sum", || json!(42)),
                Check::Eq("a.label", || json!("a")),
                Check::Eq("b.label", || json!("b")),
            ],
        },
        TestDef {
            name: "parallel-steps-isolation", category: "parallel",
            js_file: "parallel/parallel-steps-isolation.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("isolated"),
                Check::Eq("left.lane", || json!("left")),
                Check::Eq("right.lane", || json!("right")),
            ],
        },

        // ---- promises (6) ----
        TestDef {
            name: "basic-promise", category: "promises",
            js_file: "promises/basic-promise.js",
            input: "{}",
            handlers: &[H { name: "approve", input: r#"{"value":"test-approval"}"# }],
            timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("received", || json!("test-approval")),
                Check::True("complete"),
            ],
        },
        TestDef {
            name: "multiple-promises", category: "promises",
            js_file: "promises/multiple-promises.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("a", || json!(10)),
                Check::Eq("b", || json!(32)),
                Check::Eq("c", || json!("done")),
                Check::Eq("sum", || json!(42)),
            ],
        },
        TestDef {
            name: "promise-from-shared-handler", category: "promises",
            js_file: "promises/promise-from-shared-handler.js",
            input: "{}",
            handlers: &[H { name: "submitResult", input: r#"{"id":"test-id","score":99}"# }],
            timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("id", || json!("test-id")),
                Check::Eq("score", || json!(99)),
            ],
        },
        TestDef {
            name: "promise-reject", category: "promises",
            js_file: "promises/promise-reject.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("ok"),
                Check::True("rejected"),
                Check::NotNull("message"),
            ],
        },
        TestDef {
            name: "promise-resolve-before-wait", category: "promises",
            js_file: "promises/promise-resolve-before-wait.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("immediate"),
                Check::Eq("value", || json!("resolved-first")),
            ],
        },
        TestDef {
            name: "promise-timeout", category: "promises",
            js_file: "promises/promise-timeout.js",
            input: "{}",
            handlers: &[],
            timeout_promise: true, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("timedOut"),
                Check::Eq("value", || json!(null)),
            ],
        },

        // ---- retry (4) ----
        TestDef {
            name: "default-retry", category: "retry",
            js_file: "retry/default-retry.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: Some("eventually-succeeds"), retry_max: 10,
            crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("message", || json!("recovered")),
                Check::Eq("attempts", || json!(3)),
            ],
        },
        TestDef {
            name: "custom-retry-policy", category: "retry",
            js_file: "retry/custom-retry-policy.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: Some("custom-backoff-step"), retry_max: 12,
            crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("ok"),
                Check::Eq("attempts", || json!(5)),
            ],
        },
        TestDef {
            name: "retry-exhaustion", category: "retry",
            js_file: "retry/retry-exhaustion.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::NotNull("errorName"),
                Check::Contains("message", "persistent transient"),
            ],
        },
        TestDef {
            name: "terminal-error-no-retry", category: "retry",
            js_file: "retry/terminal-error-no-retry.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("terminalInvocations", || json!(1)),
            ],
        },

        // ---- shared-handlers (4) ----
        TestDef {
            name: "resolve-promise", category: "shared_handlers",
            js_file: "shared-handlers/resolve-promise.js",
            input: "{}",
            handlers: &[H { name: "approve", input: r#"{"token":"test-token"}"# }],
            timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("approval", || json!("test-token")),
            ],
        },
        TestDef {
            name: "handler-before-run-starts", category: "shared_handlers",
            js_file: "shared-handlers/handler-before-run-starts.js",
            input: "{}",
            handlers: &[H { name: "allow", input: "{}" }],
            timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("phase", || json!("main-work")),
            ],
        },
        TestDef {
            name: "multiple-handlers", category: "shared_handlers",
            js_file: "shared-handlers/multiple-handlers.js",
            input: "{}",
            handlers: &[
                H { name: "resolveA", input: "{}" },
                H { name: "resolveB", input: "{}" },
            ],
            timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("order", || json!(["first", "second"])),
            ],
        },
        TestDef {
            name: "query-status", category: "shared_handlers",
            js_file: "shared-handlers/query-status.js",
            input: "{}",
            handlers: &[
                H { name: "status", input: "{}" },
                H { name: "release", input: "{}" },
            ],
            timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("done"),
                Check::Eq("status.phase", || json!("running")),
                Check::Eq("status.counter", || json!(1)),
            ],
        },

        // ---- sleep (5) ----
        TestDef {
            name: "sleep-zero", category: "sleep",
            js_file: "sleep/sleep-zero.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("edgeCase", || json!("sleep-zero")),
                Check::NotNull("before"),
                Check::NotNull("after"),
            ],
        },
        TestDef {
            name: "basic-sleep", category: "sleep",
            js_file: "sleep/basic-sleep.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("ok"),
                Check::Eq("slept", || json!(["sleep-ms-number", "sleep-ms-obj", "sleep-seconds", "sleep-mixed"])),
            ],
        },
        TestDef {
            name: "multiple-sleeps", category: "sleep",
            js_file: "sleep/multiple-sleeps.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("ok"),
                Check::Eq("total", || json!(3)),
                Check::Eq("sequence", || json!(["first", "second", "third"])),
            ],
        },
        TestDef {
            name: "sleep-resume", category: "sleep",
            js_file: "sleep/sleep-resume.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("prePhase", || json!("pre")),
                Check::True("post.resumed"),
                Check::Eq("message", || json!("completed-after-sleep")),
            ],
        },
        TestDef {
            name: "sleep-survives-restart", category: "sleep",
            js_file: "sleep/sleep-survives-restart.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("survived"),
                Check::NotNull("after.continuedFrom"),
                Check::NotNull("boundary.marker"),
            ],
        },

        // ---- state (4) ----
        TestDef {
            name: "set-get-basic", category: "state",
            js_file: "state/set-get-basic.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("ok"),
                Check::Eq("value", || json!("hello")),
            ],
        },
        TestDef {
            name: "state-types", category: "state",
            js_file: "state/state-types.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("str", || json!("text")),
                Check::Eq("num", || json!(7)),
                Check::Eq("obj.a", || json!(1)),
                Check::Eq("obj.nested.b", || json!(2)),
                Check::Eq("arr.0", || json!(1)),
                Check::Eq("nil", || json!(null)),
            ],
        },
        TestDef {
            name: "state-across-steps", category: "state",
            js_file: "state/state-across-steps.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("ok"),
                Check::Eq("marker", || json!("from-step-1")),
            ],
        },
        TestDef {
            name: "state-from-shared-handler", category: "state",
            js_file: "state/state-from-shared-handler.js",
            input: "{}",
            handlers: &[
                H { name: "peek", input: "{}" },
                H { name: "finish", input: "{}" },
            ],
            timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("finished"),
                Check::Eq("payload.by", || json!("run")),
                Check::Eq("payload.n", || json!(42)),
            ],
        },

        // ---- crash-recovery (3) ----
        TestDef {
            name: "resume-after-step", category: "crash_recovery",
            js_file: "crash-recovery/resume-after-step.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0,
            crash_clear_steps: &["step-3"],
            replay: false, dedup: false,
            checks: &[
                Check::Eq("steps.0.index", || json!(1)),
                Check::Eq("steps.1.index", || json!(2)),
                Check::Eq("steps.2.index", || json!(3)),
                Check::Eq("steps.2.builtFromCache", || json!([1, 2])),
            ],
        },
        TestDef {
            name: "resume-after-sleep", category: "crash_recovery",
            js_file: "crash-recovery/resume-after-sleep.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::NotNull("beforeSleep.token"),
                Check::True("afterSleep.resumed"),
            ],
        },
        TestDef {
            name: "resume-after-promise", category: "crash_recovery",
            js_file: "crash-recovery/resume-after-promise.js",
            input: "{}",
            handlers: &[H { name: "approve", input: r#"{"secret":"test-secret"}"# }],
            timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("finalized"),
                Check::NotNull("staged.batch"),
                Check::Eq("approval", || json!("test-secret")),
            ],
        },

        // ---- lifecycle (3) ----
        TestDef {
            name: "workflow-completion", category: "lifecycle",
            js_file: "lifecycle/workflow-completion.js",
            input: r#"{"label":"test-label"}"#,
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("status", || json!("completed")),
                Check::Eq("label", || json!("test-label")),
                Check::NotNull("digest"),
                Check::NotNull("completedAt"),
            ],
        },
        TestDef {
            name: "workflow-deduplication", category: "lifecycle",
            js_file: "lifecycle/workflow-deduplication.js",
            input: r#"{"salt":"first-call"}"#,
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false,
            dedup: true,
            checks: &[
                Check::NotNull("instanceKey"),
                Check::NotNull("once.nonce"),
            ],
        },
        TestDef {
            name: "workflow-cancellation", category: "lifecycle",
            js_file: "lifecycle/workflow-cancellation.js",
            input: "{}",
            handlers: &[], timeout_promise: false,
            cancel_on_suspend: true,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[],
        },

        // ---- integration (2) ----
        TestDef {
            name: "sdk-call-unsupported-type", category: "integration",
            js_file: "integration/sdk-call-unsupported-type.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::True("ok"),
                Check::Contains("errorMessage", "not supported"),
            ],
        },
        TestDef {
            name: "attach-to-result", category: "integration",
            js_file: "integration/attach-to-result.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::NotNull("resultToken"),
                Check::Contains("checksum", "ck:"),
                Check::NotNull("completedAt"),
            ],
        },

        // ---- isolation (1) ----
        TestDef {
            name: "cross-project-steps", category: "isolation",
            js_file: "isolation/cross-project-steps.js",
            input: "{}",
            handlers: &[], timeout_promise: false, cancel_on_suspend: false,
            retry_step: None, retry_max: 0, crash_clear_steps: &[], replay: false, dedup: false,
            checks: &[
                Check::Eq("projectA", || json!("00000000-0000-0000-0000-000000000001")),
                Check::NotNull("stepSecret"),
                Check::NotNull("instance"),
            ],
        },
    ]
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

fn build_report(results: &[TestResult]) -> Value {
    let total = results.len();
    let passed = results.iter().filter(|r| r.pass).count();
    let failed = total - passed;
    let healthy = failed == 0;

    let mut sections_map: HashMap<String, Vec<&TestResult>> = HashMap::new();
    for r in results {
        sections_map.entry(r.category.clone()).or_default().push(r);
    }

    let mut section_summaries = json!({});
    let mut section_details = json!({});
    let mut flat_tests = vec![];

    let mut cats: Vec<_> = sections_map.keys().cloned().collect();
    cats.sort();

    for cat in &cats {
        let tests = &sections_map[cat];
        let cat_passed = tests.iter().filter(|t| t.pass).count();
        let cat_failed = tests.len() - cat_passed;
        let cat_pass = cat_failed == 0;

        section_summaries[cat] = json!({
            "pass": cat_pass,
            "passed": cat_passed,
            "failed": cat_failed,
            "total": tests.len(),
        });

        let test_details: Vec<Value> = tests.iter().map(|t| {
            let mut obj = json!({
                "name": t.name,
                "pass": t.pass,
            });
            if let Some(ref d) = t.detail {
                obj["detail"] = json!(d);
            }
            if let Some(ref e) = t.error {
                obj["error"] = json!(e);
            }
            obj
        }).collect();

        section_details[cat] = json!({
            "pass": cat_pass,
            "tests": test_details,
        });

        for t in tests {
            flat_tests.push(json!({
                "name": format!("{}: {}", t.category, t.name),
                "pass": t.pass,
            }));
        }
    }

    json!({
        "summary": {
            "healthy": healthy,
            "total_tests": total,
            "total_passed": passed,
            "total_failed": failed,
            "sections": section_summaries,
        },
        "sections": section_details,
        "tests": flat_tests,
    })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    baal_runtime_actix::init_tracing();

    let redis_url = std::env::var("WF_REDIS_URL")
        .unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());
    let dist_dir = PathBuf::from(
        std::env::var("WORKFLOW_DIST")
            .unwrap_or_else(|_| "units/workflow-tests/dist".to_string()),
    );

    eprintln!("==> Connecting to Redis at {redis_url}");
    let client = redis::Client::open(redis_url.as_str())
        .expect("invalid redis URL");
    let conn = client
        .get_multiplexed_async_connection()
        .await
        .expect("cannot connect to Redis");
    let redis: SharedRedis = Arc::new(Mutex::new(conn));

    eprintln!("==> Loading tests from {}", dist_dir.display());
    let tests = all_tests();
    eprintln!("==> Running {} workflow tests", tests.len());

    let mut results: Vec<TestResult> = Vec::new();

    for (i, test) in tests.iter().enumerate() {
        eprint!("  [{:>2}/{}] {}/{} ... ", i + 1, tests.len(), test.category, test.name);
        let result = run_test(&redis, &dist_dir, test).await;
        if result.pass {
            eprintln!("PASS");
        } else {
            eprintln!("FAIL: {}", result.error.as_deref().unwrap_or("?"));
        }
        results.push(result);
    }

    let report = build_report(&results);
    let pretty = serde_json::to_string_pretty(&report).expect("serialize report");
    println!("{pretty}");

    let passed = results.iter().filter(|r| r.pass).count();
    let failed = results.len() - passed;
    eprintln!("\n==> {passed}/{} passed, {failed} failed", results.len());

    if failed > 0 {
        std::process::exit(1);
    }
}
