use base64::Engine;
use bcrypt::{hash, hash_with_salt, verify, BcryptError, BcryptResult, Version};
use rquickjs::{Ctx, Exception, Value, function::Func};

const DEFAULT_COST: u32 = 10;

pub fn register(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    ctx.globals()
        .set("__baal_bcrypt_compare_sync", Func::from(host_bcrypt_compare_sync))?;
    ctx.globals()
        .set("__baal_bcrypt_hash_sync", Func::from(host_bcrypt_hash_sync))?;
    Ok(())
}

fn host_bcrypt_compare_sync(ctx: Ctx<'_>, password: String, hash: String) -> rquickjs::Result<bool> {
    if hash.len() != 60 {
        return Ok(false);
    }
    match verify(&password, &hash) {
        Ok(ok) => Ok(ok),
        Err(e) => Err(Exception::throw_message(&ctx, &e.to_string())),
    }
}

fn host_bcrypt_hash_sync<'js>(
    ctx: Ctx<'js>,
    password: String,
    salt_or_rounds: Option<Value<'js>>,
) -> rquickjs::Result<String> {
    let (salt, rounds) = decode_salt_or_rounds(&ctx, salt_or_rounds)?;
    match hash_password(password, salt, rounds) {
        Ok(hash) => Ok(hash),
        Err(e) => Err(Exception::throw_message(&ctx, &e.to_string())),
    }
}

fn decode_salt_or_rounds<'js>(
    ctx: &Ctx<'js>,
    value: Option<Value<'js>>,
) -> rquickjs::Result<(Option<String>, Option<u32>)> {
    let Some(value) = value else {
        return Ok((None, None));
    };
    if value.is_null() || value.is_undefined() {
        return Ok((None, None));
    }
    if let Some(n) = value.as_number() {
        if !n.is_finite() || n < 0.0 || n.fract() != 0.0 {
            return Err(Exception::throw_message(
                ctx,
                "bcrypt rounds must be a non-negative integer",
            ));
        }
        return Ok((None, Some(n as u32)));
    }
    if let Some(s) = value.as_string() {
        return Ok((Some(s.to_string()?), None));
    }
    Err(Exception::throw_message(
        ctx,
        "bcrypt salt must be a string or rounds number",
    ))
}

fn hash_password(
    password: String,
    salt: Option<String>,
    rounds: Option<u32>,
) -> BcryptResult<String> {
    if let Some(cost) = rounds {
        return hash(password, cost);
    }
    if let Some(salt_str) = salt {
        let parsed = parse_bcryptjs_salt(&salt_str)?;
        let parts = hash_with_salt(password, parsed.cost, parsed.salt_bytes)?;
        return Ok(parts.format_for_version(parsed.version));
    }
    hash(password, DEFAULT_COST)
}

struct ParsedBcryptjsSalt {
    cost: u32,
    salt_bytes: [u8; 16],
    version: Version,
}

fn parse_bcryptjs_salt(salt: &str) -> BcryptResult<ParsedBcryptjsSalt> {
    let bytes = salt.as_bytes();
    if salt.len() < 7 || bytes[0] != b'$' || bytes[1] != b'2' {
        return Err(BcryptError::InvalidHash("invalid salt version"));
    }

    let (minor, offset) = if bytes[2] == b'$' {
        ('\0', 3usize)
    } else {
        let minor = salt.chars().nth(2).ok_or(BcryptError::InvalidHash(
            "invalid salt revision",
        ))?;
        if minor != 'a' && minor != 'b' && minor != 'y' {
            return Err(BcryptError::InvalidHash("invalid salt revision"));
        }
        if bytes.get(3) != Some(&b'$') {
            return Err(BcryptError::InvalidHash("invalid salt revision"));
        }
        (minor, 4usize)
    };

    if salt.len() < offset + 25 || bytes.get(offset + 2) > Some(&b'$') {
        return Err(BcryptError::InvalidHash("missing salt rounds"));
    }

    let cost = salt[offset..offset + 2]
        .parse::<u32>()
        .map_err(|_| BcryptError::InvalidHash("invalid salt rounds"))?;
    let real_salt = &salt[offset + 3..offset + 25];
    let mut salt_bytes = [0u8; 16];
    bcrypt::BASE_64
        .decode_slice(real_salt, &mut salt_bytes)
        .map_err(|_| BcryptError::InvalidHash("invalid salt base64"))?;

    Ok(ParsedBcryptjsSalt {
        cost,
        salt_bytes,
        version: version_from_minor(minor),
    })
}

fn version_from_minor(minor: char) -> Version {
    match minor {
        'a' => Version::TwoA,
        'y' => Version::TwoY,
        'b' | '\0' => Version::TwoB,
        _ => Version::TwoB,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_from_minor_maps_revisions() {
        assert!(matches!(version_from_minor('a'), Version::TwoA));
        assert!(matches!(version_from_minor('y'), Version::TwoY));
        assert!(matches!(version_from_minor('b'), Version::TwoB));
        assert!(matches!(version_from_minor('\0'), Version::TwoB));
        assert!(matches!(version_from_minor('x'), Version::TwoB));
    }

    #[test]
    fn parse_bcryptjs_salt_parses_2b_prefix() {
        let salt = "$2b$10$L6Bc/AlTQHyd9liGgGEZyO";
        let parsed = parse_bcryptjs_salt(salt).expect("valid 2b salt");
        assert_eq!(parsed.cost, 10);
        assert!(matches!(parsed.version, Version::TwoB));
        assert_eq!(parsed.salt_bytes.len(), 16);
        assert_ne!(parsed.salt_bytes, [0u8; 16]);
    }

    #[test]
    fn parse_bcryptjs_salt_parses_2y_and_2a_prefixes() {
        let y = "$2y$04$L6Bc/AlTQHyd9liGgGEZyO";
        let a = "$2a$12$L6Bc/AlTQHyd9liGgGEZyO";
        let parsed_y = parse_bcryptjs_salt(y).expect("2y salt");
        let parsed_a = parse_bcryptjs_salt(a).expect("2a salt");
        assert!(matches!(parsed_y.version, Version::TwoY));
        assert_eq!(parsed_y.cost, 4);
        assert!(matches!(parsed_a.version, Version::TwoA));
        assert_eq!(parsed_a.cost, 12);
    }

    #[test]
    fn parse_bcryptjs_salt_parses_legacy_2_prefix() {
        let salt = "$2$10$L6Bc/AlTQHyd9liGgGEZyO";
        let parsed = parse_bcryptjs_salt(salt).expect("valid legacy salt");
        assert_eq!(parsed.cost, 10);
        assert!(matches!(parsed.version, Version::TwoB));
    }

    #[test]
    fn parse_bcryptjs_salt_rejects_invalid_prefix() {
        assert!(parse_bcryptjs_salt("$1b$10$L6Bc/AlTQHyd9liGgGEZyO").is_err());
        assert!(parse_bcryptjs_salt("$2z$10$L6Bc/AlTQHyd9liGgGEZyO").is_err());
        assert!(parse_bcryptjs_salt("not-a-salt").is_err());
    }

    #[test]
    fn parse_bcryptjs_salt_rejects_truncated_input() {
        assert!(parse_bcryptjs_salt("$2b$10$short").is_err());
    }

    #[test]
    fn hash_password_round_trip_with_parsed_salt() {
        let salt = bcrypt::hash("pw", 4).expect("hash");
        let prefix = &salt[..29];
        let hashed = hash_password("pw".into(), Some(prefix.to_string()), None).expect("hash");
        assert!(verify("pw", &hashed).expect("verify"));
    }

    mod decode_salt_or_rounds_tests {
        use super::*;
        use rquickjs::{Context, Runtime};

        fn decode_js(expr: &str) -> rquickjs::Result<(Option<String>, Option<u32>)> {
            let rt = Runtime::new().expect("runtime");
            let context = Context::full(&rt).expect("context");
            context.with(|ctx| {
                let value: Value = ctx.eval(expr).expect("eval");
                decode_salt_or_rounds(&ctx, Some(value))
            })
        }

        fn decode_missing() -> rquickjs::Result<(Option<String>, Option<u32>)> {
            let rt = Runtime::new().expect("runtime");
            let context = Context::full(&rt).expect("context");
            context.with(|ctx| decode_salt_or_rounds(&ctx, None))
        }

        #[test]
        fn accepts_missing_null_and_undefined() {
            assert_eq!(decode_missing().expect("missing"), (None, None));
            assert_eq!(decode_js("null").expect("null"), (None, None));
            assert_eq!(decode_js("undefined").expect("undefined"), (None, None));
        }

        #[test]
        fn accepts_rounds_number() {
            assert_eq!(decode_js("10").expect("10"), (None, Some(10)));
            assert_eq!(decode_js("0").expect("0"), (None, Some(0)));
            assert_eq!(decode_js("4").expect("4"), (None, Some(4)));
        }

        #[test]
        fn accepts_salt_string() {
            let salt = "$2b$10$L6Bc/AlTQHyd9liGgGEZyO";
            let (parsed_salt, rounds) = decode_js(&format!("{salt:?}")).expect("salt string");
            assert_eq!(rounds, None);
            assert_eq!(parsed_salt.as_deref(), Some(salt));
        }

        #[test]
        fn rejects_non_integer_rounds() {
            assert!(decode_js("10.5").is_err());
            assert!(decode_js("-1").is_err());
            assert!(decode_js("NaN").is_err());
            assert!(decode_js("Infinity").is_err());
        }

        #[test]
        fn rejects_non_string_non_number_values() {
            assert!(decode_js("true").is_err());
            assert!(decode_js("({})").is_err());
            assert!(decode_js("[]").is_err());
        }
    }
}
