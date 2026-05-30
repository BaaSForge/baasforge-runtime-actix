//! Shared QuickJS bootstrap included before every unit runtime script.

/// `unit_js_runtime!("scripts/api-runtime.js")` — shared bootstrap + one script path.
#[macro_export]
macro_rules! unit_js_runtime {
    ($unit_script:literal) => {
        concat!(
            include_str!("scripts/runtime-shared.js"),
            "\n",
            include_str!("scripts/platform-patches.js"),
            "\n",
            include_str!("scripts/fetch-node-parity.js"),
            "\n",
            include_str!($unit_script)
        )
    };
}

pub const SHARED_RUNTIME_JS: &str = concat!(
    include_str!("scripts/runtime-shared.js"),
    "\n",
    include_str!("scripts/platform-patches.js"),
    "\n",
    include_str!("scripts/fetch-node-parity.js")
);
