pub const MAX_BODY_LOG_CHARS: usize = 100;

pub fn truncate_chars_for_log(text: &str) -> String {
    if text.chars().count() <= MAX_BODY_LOG_CHARS {
        return text.to_string();
    }
    let mut out: String = text.chars().take(MAX_BODY_LOG_CHARS).collect();
    out.push_str("…(truncated)");
    out
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