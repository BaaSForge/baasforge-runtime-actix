use base64::{Engine as _, engine::general_purpose::STANDARD};
use rquickjs::{Ctx, Exception, function::Func};

const BUFFER_JS: &str = include_str!("../scripts/buffer.js");

pub fn register(ctx: &Ctx<'_>) -> rquickjs::Result<()> {
    let globals = ctx.globals();
    globals.set("__buf_str_to_bytes", Func::from(buf_str_to_bytes))?;
    globals.set("__buf_bytes_to_str", Func::from(buf_bytes_to_str))?;
    globals.set("__buf_byte_length", Func::from(buf_byte_length))?;
    ctx.eval::<(), _>(BUFFER_JS)?;
    ctx.eval::<(), _>(
        "delete globalThis.__buf_str_to_bytes;\
         delete globalThis.__buf_bytes_to_str;\
         delete globalThis.__buf_byte_length;",
    )?;
    Ok(())
}

fn buf_str_to_bytes(ctx: Ctx<'_>, input: String, encoding: String) -> rquickjs::Result<Vec<u8>> {
    match encoding.to_lowercase().as_str() {
        "utf-8" | "utf8" => Ok(input.into_bytes()),
        "latin1" | "binary" => input
            .chars()
            .map(|c| {
                if (c as u32) > 255 {
                    Err(Exception::throw_message(
                        &ctx,
                        "character out of range for latin1",
                    ))
                } else {
                    Ok(c as u8)
                }
            })
            .collect(),
        "ascii" => Ok(input.bytes().map(|b| b & 0x7F).collect()),
        "base64" => STANDARD
            .decode(&input)
            .map_err(|e| Exception::throw_message(&ctx, &format!("Invalid base64: {e}"))),
        "hex" => hex::decode(&input)
            .map_err(|e| Exception::throw_message(&ctx, &format!("Invalid hex: {e}"))),
        other => Err(Exception::throw_message(
            &ctx,
            &format!("Unknown encoding: {other}"),
        )),
    }
}

fn buf_bytes_to_str(ctx: Ctx<'_>, bytes: Vec<u8>, encoding: String) -> rquickjs::Result<String> {
    match encoding.to_lowercase().as_str() {
        "utf-8" | "utf8" => String::from_utf8(bytes)
            .map_err(|e| Exception::throw_message(&ctx, &format!("Invalid UTF-8: {e}"))),
        "latin1" | "binary" => Ok(bytes.into_iter().map(|b| b as char).collect()),
        "ascii" => Ok(bytes.into_iter().map(|b| (b & 0x7F) as char).collect()),
        "base64" => Ok(STANDARD.encode(&bytes)),
        "hex" => Ok(hex::encode(&bytes)),
        other => Err(Exception::throw_message(
            &ctx,
            &format!("Unknown encoding: {other}"),
        )),
    }
}

fn buf_byte_length(ctx: Ctx<'_>, input: String, encoding: String) -> rquickjs::Result<usize> {
    match encoding.to_lowercase().as_str() {
        "utf-8" | "utf8" => Ok(input.len()),
        "latin1" | "binary" | "ascii" => Ok(input.chars().count()),
        "base64" => {
            let clean: String = input.chars().filter(|&c| c != '=' && c != '\n' && c != '\r').collect();
            Ok(clean.len() * 3 / 4)
        }
        "hex" => Ok(input.len() / 2),
        other => Err(Exception::throw_message(
            &ctx,
            &format!("Unknown encoding: {other}"),
        )),
    }
}
