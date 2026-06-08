pub const MAX_BODY_LOG_CHARS: usize = 100;

pub fn truncate_chars_for_log(text: &str) -> String {
    if text.chars().count() <= MAX_BODY_LOG_CHARS {
        return text.to_string();
    }
    let mut out: String = text.chars().take(MAX_BODY_LOG_CHARS).collect();
    out.push_str("…(truncated)");
    out
}

pub fn sanitize_json_value_for_log(v: &serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::String(s) => serde_json::Value::String(truncate_chars_for_log(s)),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(sanitize_json_value_for_log).collect())
        }
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, val) in map {
                out.insert(k.clone(), sanitize_json_value_for_log(val));
            }
            serde_json::Value::Object(out)
        }
        other => other.clone(),
    }
}

pub fn json_value_preview_for_log(v: &serde_json::Value) -> String {
    truncate_chars_for_log(&sanitize_json_value_for_log(v).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_large_nested_json_strings_for_log() {
        let huge = "x".repeat(1024 * 1024);
        let v = serde_json::json!({
            "actorId": "a1",
            "handler": "setLargeState",
            "payload": { "data": huge },
        });
        let preview = json_value_preview_for_log(&v);
        assert!(preview.chars().count() <= MAX_BODY_LOG_CHARS + "…(truncated)".chars().count());
        assert!(!preview.contains(&"x".repeat(200)));
    }
}

pub fn truncate_by_words<S: AsRef<str>>(text: S, max_words: usize) -> Option<String> {
    let words: Vec<&str> = text
        .as_ref()
        .split_whitespace()
        .take(max_words)
        .collect();

    if words.is_empty() {
        None
    } else {
        Some(words.join(" "))
    }
}