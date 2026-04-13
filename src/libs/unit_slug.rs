use regex::Regex;
use std::sync::LazyLock;

pub static SLUG_PATTERN: &str = r"^[a-z]+(-[a-z]+)*$";

static SLUG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(SLUG_PATTERN).expect("static slug regex"));

pub fn is_valid_slug(s: &str) -> bool {
    !s.is_empty() && SLUG_RE.is_match(s)
}

const DIGIT_WORD: [&str; 10] = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
];

/// Converts a filename stem (e.g. workflow JS basename without `.js`) into a slug that satisfies
/// [`is_valid_slug`]. Separators `_`/`-`/`.`/space split letter groups; each digit becomes a
/// spelled-out segment so names like `rand-uuidv4` become `rand-uuidv-four`.
pub fn normalize_filename_stem_to_slug(stem: &str) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut letters = String::new();
    let mut digits = String::new();

    let flush_letters = |buf: &mut String, parts: &mut Vec<String>| {
        if !buf.is_empty() {
            parts.push(buf.clone());
            buf.clear();
        }
    };

    let flush_digits = |buf: &mut String, parts: &mut Vec<String>| {
        if buf.is_empty() {
            return;
        }
        for ch in buf.chars() {
            let idx = (ch as u8).saturating_sub(b'0') as usize;
            if idx < 10 {
                parts.push(DIGIT_WORD[idx].to_string());
            }
        }
        buf.clear();
    };

    for c in stem.to_lowercase().chars() {
        match c {
            'a'..='z' => {
                flush_digits(&mut digits, &mut parts);
                letters.push(c);
            }
            '0'..='9' => {
                flush_letters(&mut letters, &mut parts);
                digits.push(c);
            }
            '_' | '-' | ' ' | '.' => {
                flush_digits(&mut digits, &mut parts);
                flush_letters(&mut letters, &mut parts);
            }
            _ => {
                flush_digits(&mut digits, &mut parts);
                flush_letters(&mut letters, &mut parts);
            }
        }
    }
    flush_digits(&mut digits, &mut parts);
    flush_letters(&mut letters, &mut parts);

    if parts.is_empty() {
        return None;
    }
    let out = parts.join("-");
    is_valid_slug(&out).then_some(out)
}

/// Builds the canonical **full unit id** (five segments). The four-segment *unit path* is
/// [`UnitPath`] / everything here except `revision`; see [`crate::models::projects::ProjectUnitRow::id`].
pub fn compose_unit_id(
    context_slug: &str,
    module_slug: &str,
    unit_type_slug: &str,
    unit_name_slug: &str,
    revision: i32,
) -> String {
    format!(
        "{}.{}.{}.{}.{}",
        context_slug,
        module_slug,
        unit_type_slug,
        unit_name_slug,
        revision
    )
}

/// Dot-separated path to a logical unit: `context.module.unit_type.unit_name` (everything in a
/// stored unit id except the final revision segment).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitPath {
    pub context_slug: String,
    pub module_slug: String,
    pub unit_type: String, // TODO: replace with ProjectUnitType
    pub unit_name_slug: String,
}

/// Parses a [`UnitPath`] from a string.
///
/// - **Full unit id** — five segments, last segment a positive integer revision: same path as the
///   first four segments (revision is ignored for lookup).
/// - **Path only** — four segments: `context.module.unit_type.unit_name`.
pub fn parse_unit_path(s: &str) -> Result<UnitPath, &'static str> {
    let parts: Vec<&str> = s.split('.').filter(|p| !p.is_empty()).collect();
    let (a, b, c, d) = match parts.len() {
        5 => {
            let rev: i32 = parts[4]
                .parse()
                .map_err(|_| "invalid unit path: revision must be a positive integer")?;
            if rev < 1 {
                return Err("invalid unit path: revision must be >= 1");
            }
            (parts[0], parts[1], parts[2], parts[3])
        }
        4 => (parts[0], parts[1], parts[2], parts[3]),
        _ => {
            return Err(
                "invalid unit path: expected four segments (context.module.unit_type.unit_name) or five with a revision",
            );
        }
    };
    for p in [a, b, c, d] {
        if !is_valid_slug(p) {
            return Err("invalid unit path: each segment must be a valid slug");
        }
    }
    let unit_type = c.to_string(); // TODO: replace with ProjectUnitType::from_slug(c).ok_or("invalid unit path: unknown unit_type")?;
    Ok(UnitPath {
        context_slug: a.to_string(),
        module_slug: b.to_string(),
        unit_type,
        unit_name_slug: d.to_string(),
    })
}
