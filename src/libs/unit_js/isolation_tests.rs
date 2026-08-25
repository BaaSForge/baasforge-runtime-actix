use super::api_runner::run_unit_handler;
use super::cold_start_fixtures;
use super::js_pool;
use super::types::TriggerHttpSnapshot;

fn set_env(key: &str, value: &str) {
    // SAFETY: test-only process env; these tests do not share the process with production.
    unsafe { std::env::set_var(key, value) }
}

fn unset_env(key: &str) {
    // SAFETY: test-only process env; these tests do not share the process with production.
    unsafe { std::env::remove_var(key) }
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

#[tokio::test]
async fn sequential_invokes_do_not_leak_prototype_or_globals() {
    set_env("BAAL_JS_RUNTIME_POOL", "1");
    js_pool::drain_pool();
    let snap = empty_snapshot();

    let polluted = run_unit_handler(cold_start_fixtures::POLLUTE, &snap, None, Some("pollute.js"))
        .await
        .expect("pollute invoke");
    assert_eq!(polluted.status, 200);

    let observed = run_unit_handler(cold_start_fixtures::OBSERVE, &snap, None, Some("observe.js"))
        .await
        .expect("observe invoke");
    assert_eq!(observed.status, 200, "observe body={}", observed.body);
    assert!(
        observed.body.contains("\"proto\":\"clean\""),
        "prototype leaked: {}",
        observed.body
    );
    assert!(
        observed.body.contains("\"secret\":\"clean\""),
        "globalThis leaked: {}",
        observed.body
    );
    assert!(
        observed.body.contains("\"fired\":\"clean\""),
        "timer leaked: {}",
        observed.body
    );

    unset_env("BAAL_JS_RUNTIME_POOL");
    js_pool::drain_pool();
}

#[tokio::test]
async fn concurrent_invokes_do_not_cross_talk() {
    set_env("BAAL_JS_RUNTIME_POOL", "1");
    js_pool::drain_pool();
    let snap = empty_snapshot();

    let (a, b) = tokio::join!(
        run_unit_handler(cold_start_fixtures::HELLO, &snap, None, Some("hello-a.js")),
        run_unit_handler(cold_start_fixtures::OBSERVE, &snap, None, Some("hello-b.js")),
    );
    let a = a.expect("tenant a");
    let b = b.expect("tenant b");
    assert_eq!(a.status, 200);
    assert_eq!(b.status, 200);
    assert!(a.body.contains("\"ok\":true"), "{}", a.body);
    assert!(b.body.contains("\"proto\":\"clean\""), "{}", b.body);

    unset_env("BAAL_JS_RUNTIME_POOL");
    js_pool::drain_pool();
}

#[tokio::test]
async fn pool_does_not_grow_past_cap_on_short_soak() {
    set_env("BAAL_JS_RUNTIME_POOL", "1");
    set_env("BAAL_JS_POOL_SIZE", "2");
    js_pool::drain_pool();
    let snap = empty_snapshot();
    for _ in 0..12 {
        let res = run_unit_handler(cold_start_fixtures::HELLO, &snap, None, Some("soak.js"))
            .await
            .expect("soak invoke");
        assert_eq!(res.status, 200);
    }
    assert!(
        js_pool::pool_len() <= 2,
        "pool grew past cap: {}",
        js_pool::pool_len()
    );
    unset_env("BAAL_JS_RUNTIME_POOL");
    unset_env("BAAL_JS_POOL_SIZE");
    js_pool::drain_pool();
}
