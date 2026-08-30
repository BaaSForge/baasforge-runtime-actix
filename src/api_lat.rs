//! Wall-clock bottleneck trace for **API unit** HTTP triggers.
//!
//! Enable with `BAAL_API_LAT=1`. Each request logs one `api_lat` line and sets
//! a `Server-Timing` response header so you can see the split without guessing.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

pub fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| match std::env::var("BAAL_API_LAT") {
        Ok(raw) => matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => false,
    })
}

struct Inner {
    t0: Instant,
    last: Mutex<Instant>,
    steps: Mutex<Vec<(String, u64)>>,
    extras: Mutex<BTreeMap<String, u64>>,
    unit_path: Mutex<String>,
}

#[derive(Clone)]
pub struct ApiLat(Arc<Inner>);

impl ApiLat {
    pub fn start() -> Self {
        let now = Instant::now();
        Self(Arc::new(Inner {
            t0: now,
            last: Mutex::new(now),
            steps: Mutex::new(Vec::with_capacity(24)),
            extras: Mutex::new(BTreeMap::new()),
            unit_path: Mutex::new(String::new()),
        }))
    }

    pub fn set_unit_path(&self, path: &str) {
        if let Ok(mut g) = self.0.unit_path.lock() {
            *g = path.to_string();
        }
    }

    pub fn mark(&self, name: &str) {
        let now = Instant::now();
        let Ok(mut last) = self.0.last.lock() else {
            return;
        };
        let dt = now.saturating_duration_since(*last).as_micros() as u64;
        *last = now;
        if let Ok(mut steps) = self.0.steps.lock() {
            steps.push((name.to_string(), dt));
        }
    }

    pub fn add(&self, name: &str, value: u64) {
        if let Ok(mut extras) = self.0.extras.lock() {
            *extras.entry(name.to_string()).or_insert(0) += value;
        }
    }

    pub fn total_us(&self) -> u64 {
        self.0.t0.elapsed().as_micros() as u64
    }

    fn timing_token(name: &str) -> String {
        name.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '-'
                }
            })
            .collect()
    }

    pub fn server_timing(&self) -> String {
        let total_ms = self.total_us() as f64 / 1000.0;
        let mut parts = vec![format!("total;dur={total_ms:.3}")];
        if let Ok(steps) = self.0.steps.lock() {
            for (name, us) in steps.iter() {
                parts.push(format!(
                    "{};dur={:.3}",
                    Self::timing_token(name),
                    *us as f64 / 1000.0
                ));
            }
        }
        if let Ok(extras) = self.0.extras.lock() {
            for (name, v) in extras.iter() {
                let dur = if name.ends_with("_us") {
                    *v as f64 / 1000.0
                } else {
                    *v as f64
                };
                parts.push(format!("{};dur={:.3}", Self::timing_token(name), dur));
            }
        }
        parts.join(", ")
    }

    pub fn finish(&self, status: u16) {
        let total_us = self.total_us();
        let unit_path = self
            .0
            .unit_path
            .lock()
            .ok()
            .map(|g| g.clone())
            .unwrap_or_default();
        let mut step_s = String::new();
        if let Ok(steps) = self.0.steps.lock() {
            for (i, (name, us)) in steps.iter().enumerate() {
                if i > 0 {
                    step_s.push(' ');
                }
                step_s.push_str(name);
                step_s.push('=');
                step_s.push_str(&format!("{us}"));
            }
        }
        let mut extra_s = String::new();
        if let Ok(extras) = self.0.extras.lock() {
            for (i, (name, v)) in extras.iter().enumerate() {
                if i > 0 {
                    extra_s.push(' ');
                }
                extra_s.push_str(name);
                extra_s.push('=');
                extra_s.push_str(&format!("{v}"));
            }
        }
        tracing::info!(
            target: "api_lat",
            unit_path = unit_path.as_str(),
            status,
            total_us,
            total_ms = total_us as f64 / 1000.0,
            steps = step_s.as_str(),
            extras = extra_s.as_str(),
            "api unit bottleneck split (us since previous mark)"
        );
    }
}

thread_local! {
    static CURRENT: RefCell<Option<ApiLat>> = const { RefCell::new(None) };
}

pub struct TlsGuard;

impl TlsGuard {
    pub fn install(lat: ApiLat) -> Self {
        CURRENT.with(|c| *c.borrow_mut() = Some(lat));
        Self
    }
}

impl Drop for TlsGuard {
    fn drop(&mut self) {
        CURRENT.with(|c| *c.borrow_mut() = None);
    }
}

pub fn current() -> Option<ApiLat> {
    CURRENT.with(|c| c.borrow().clone())
}

pub fn mark_opt(lat: &Option<ApiLat>, name: &str) {
    if let Some(l) = lat {
        l.mark(name);
    }
}

pub fn from_request(req: &actix_web::HttpRequest) -> Option<ApiLat> {
    use actix_web::HttpMessage;
    req.extensions().get::<ApiLat>().cloned()
}
