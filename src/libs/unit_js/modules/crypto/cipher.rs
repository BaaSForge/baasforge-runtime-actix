use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
use rquickjs::{Ctx, Exception, Object, Value};

use crate::libs::unit_js::modules::helpers;

pub fn cipher_process_js<'js>(
    ctx: Ctx<'js>,
    algorithm: String,
    key: Vec<u8>,
    iv: Vec<u8>,
    data: Vec<u8>,
    is_encrypt: bool,
    auth_tag: Vec<u8>,
) -> rquickjs::Result<Value<'js>> {
    let alg = algorithm.to_lowercase();
    let obj = Object::new(ctx.clone())?;

    match alg.as_str() {
        "aes-256-cbc" => {
            let result = if is_encrypt {
                aes_cbc_encrypt::<aes::Aes256>(&key, &iv, &data, &ctx)?
            } else {
                aes_cbc_decrypt::<aes::Aes256>(&key, &iv, &data, &ctx)?
            };
            obj.set("data", helpers::new_buffer_from_bytes(&ctx, &result)?)?;
        }
        "aes-128-cbc" => {
            let result = if is_encrypt {
                aes_cbc_encrypt::<aes::Aes128>(&key, &iv, &data, &ctx)?
            } else {
                aes_cbc_decrypt::<aes::Aes128>(&key, &iv, &data, &ctx)?
            };
            obj.set("data", helpers::new_buffer_from_bytes(&ctx, &result)?)?;
        }
        "aes-256-gcm" => {
            if is_encrypt {
                let (ct, tag) =
                    aes_gcm_encrypt::<aes_gcm::Aes256Gcm>(&key, &iv, &data, &ctx)?;
                obj.set("data", helpers::new_buffer_from_bytes(&ctx, &ct)?)?;
                obj.set("authTag", helpers::new_buffer_from_bytes(&ctx, &tag)?)?;
            } else {
                let pt = aes_gcm_decrypt::<aes_gcm::Aes256Gcm>(
                    &key, &iv, &data, &auth_tag, &ctx,
                )?;
                obj.set("data", helpers::new_buffer_from_bytes(&ctx, &pt)?)?;
            }
        }
        "aes-128-gcm" => {
            if is_encrypt {
                let (ct, tag) =
                    aes_gcm_encrypt::<aes_gcm::Aes128Gcm>(&key, &iv, &data, &ctx)?;
                obj.set("data", helpers::new_buffer_from_bytes(&ctx, &ct)?)?;
                obj.set("authTag", helpers::new_buffer_from_bytes(&ctx, &tag)?)?;
            } else {
                let pt = aes_gcm_decrypt::<aes_gcm::Aes128Gcm>(
                    &key, &iv, &data, &auth_tag, &ctx,
                )?;
                obj.set("data", helpers::new_buffer_from_bytes(&ctx, &pt)?)?;
            }
        }
        other => {
            return Err(Exception::throw_message(
                &ctx,
                &format!("Unsupported cipher: {other}"),
            ));
        }
    }

    Ok(obj.into_value())
}

fn pkcs7_pad(data: &[u8]) -> Vec<u8> {
    let block_size = 16;
    let padding_len = block_size - (data.len() % block_size);
    let mut padded = data.to_vec();
    padded.extend(vec![padding_len as u8; padding_len]);
    padded
}

fn pkcs7_unpad(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.is_empty() {
        return Err("empty data".into());
    }
    let padding_len = *data.last().unwrap() as usize;
    if padding_len == 0 || padding_len > 16 || padding_len > data.len() {
        return Err("invalid PKCS7 padding".into());
    }
    for &byte in &data[data.len() - padding_len..] {
        if byte as usize != padding_len {
            return Err("invalid PKCS7 padding".into());
        }
    }
    Ok(data[..data.len() - padding_len].to_vec())
}

fn aes_cbc_encrypt<C>(
    key: &[u8],
    iv: &[u8],
    plaintext: &[u8],
    _ctx: &Ctx<'_>,
) -> rquickjs::Result<Vec<u8>>
where
    C: BlockEncrypt + KeyInit,
{
    let cipher = C::new(GenericArray::from_slice(key));
    let padded = pkcs7_pad(plaintext);
    let mut prev = GenericArray::clone_from_slice(iv);
    let mut ciphertext = Vec::with_capacity(padded.len());

    for chunk in padded.chunks(16) {
        let mut block = GenericArray::clone_from_slice(chunk);
        for (a, b) in block.iter_mut().zip(prev.iter()) {
            *a ^= *b;
        }
        cipher.encrypt_block(&mut block);
        ciphertext.extend_from_slice(&block);
        prev = block;
    }
    Ok(ciphertext)
}

fn aes_cbc_decrypt<C>(
    key: &[u8],
    iv: &[u8],
    ciphertext: &[u8],
    ctx: &Ctx<'_>,
) -> rquickjs::Result<Vec<u8>>
where
    C: BlockDecrypt + KeyInit,
{
    let cipher = C::new(GenericArray::from_slice(key));
    let mut prev = iv.to_vec();
    let mut plaintext = Vec::with_capacity(ciphertext.len());

    for chunk in ciphertext.chunks(16) {
        let mut block = GenericArray::clone_from_slice(chunk);
        cipher.decrypt_block(&mut block);
        for (a, b) in block.iter_mut().zip(prev.iter()) {
            *a ^= *b;
        }
        plaintext.extend_from_slice(&block);
        prev = chunk.to_vec();
    }

    pkcs7_unpad(&plaintext).map_err(|e| Exception::throw_message(ctx, &e))
}

fn aes_gcm_encrypt<C>(
    key: &[u8],
    iv: &[u8],
    plaintext: &[u8],
    ctx: &Ctx<'_>,
) -> rquickjs::Result<(Vec<u8>, Vec<u8>)>
where
    C: aes_gcm::aead::KeyInit + aes_gcm::aead::Aead,
{
    let cipher =
        C::new_from_slice(key).map_err(|e| Exception::throw_message(ctx, &e.to_string()))?;
    let nonce = aes_gcm::Nonce::from_slice(iv);
    let ciphertext_with_tag = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| Exception::throw_message(ctx, &e.to_string()))?;

    let tag_start = ciphertext_with_tag.len() - 16;
    let ct = ciphertext_with_tag[..tag_start].to_vec();
    let tag = ciphertext_with_tag[tag_start..].to_vec();
    Ok((ct, tag))
}

fn aes_gcm_decrypt<C>(
    key: &[u8],
    iv: &[u8],
    ciphertext: &[u8],
    tag: &[u8],
    ctx: &Ctx<'_>,
) -> rquickjs::Result<Vec<u8>>
where
    C: aes_gcm::aead::KeyInit + aes_gcm::aead::Aead,
{
    let cipher =
        C::new_from_slice(key).map_err(|e| Exception::throw_message(ctx, &e.to_string()))?;
    let nonce = aes_gcm::Nonce::from_slice(iv);

    let mut ct_with_tag = ciphertext.to_vec();
    ct_with_tag.extend_from_slice(tag);

    cipher
        .decrypt(nonce, ct_with_tag.as_ref())
        .map_err(|_| Exception::throw_message(ctx, "decryption failed (bad auth tag or data)"))
}
