//! One bounded request on stdin, one response on stdout; never log input or keys.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use hybridcipher_crypto::{
    aead::{open_with_aad, seal_with_aad, Key, Nonce},
    kdf::{hkdf_expand_with_info, hkdf_extract},
    Signature, SigningKey, VerifyingKey,
};
use rand::{rngs::OsRng, RngCore};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use zeroize::{Zeroize, Zeroizing};
mod custody;
mod identity;

const LIMIT: usize = 32 * 1024 * 1024;
const MEMORY_DOMAIN: &str = "code-butler/memory-sync/v1";
const SECRETS_DOMAIN: &str = "code-butler/secrets-sync/v1";

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Request {
    version: u32,
    operation: String,
    project_id: String,
    epoch: u32,
    purpose: String,
    domain: Option<String>,
    key: String,
    items: Vec<String>,
    signature: Option<String>,
}
impl Drop for Request {
    fn drop(&mut self) {
        self.key.zeroize();
        self.items.zeroize();
    }
}
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn context(request: &Request) -> Result<Vec<u8>> {
    // UUIDs use a single spelling; do not allow caller-controlled domains or AAD.
    let id = request.project_id.as_bytes();
    if request.version != 1
        || request.epoch < 1
        || id.len() != 36
        || !id.iter().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                *b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(b)
            }
        })
        || !["block", "manifest"].contains(&request.purpose.as_str())
        || request.items.is_empty()
        || request.items.len() > 128
    {
        return Err("invalid request".into());
    }
    let domain = match request.domain.as_deref().unwrap_or("memory") {
        "memory" => MEMORY_DOMAIN,
        "secrets" => SECRETS_DOMAIN,
        _ => return Err("invalid request".into()),
    };
    Ok(serde_json::to_vec(&(
        domain,
        &request.project_id,
        request.epoch,
        &request.purpose,
    ))?)
}

fn process(request: &Request) -> Result<Value> {
    let aad = context(request)?;
    let secret = Zeroizing::new(B64.decode(&request.key)?);
    if secret.len() != 32 {
        return Err("invalid key".into());
    }
    if request.operation == "sign" || request.operation == "verify" {
        if request.purpose != "manifest" || request.items.len() != 1 {
            return Err("invalid request".into());
        }
        let mut message = aad;
        message.extend_from_slice(&B64.decode(&request.items[0])?);
        if request.operation == "sign" {
            let key = SigningKey::from_bytes(&secret)?;
            return Ok(
                json!({"version":1, "signature":B64.encode(key.sign(&message)?.as_bytes()), "publicKey":B64.encode(key.verifying_key().as_bytes())}),
            );
        }
        let signature = Signature::from_bytes(
            &B64.decode(request.signature.as_ref().ok_or("missing signature")?)?,
        )?;
        VerifyingKey::from_bytes(&secret)?.verify(&message, &signature)?;
        return Ok(json!({"version":1, "verified":true}));
    }
    if !["seal", "open"].contains(&request.operation.as_str()) {
        return Err("invalid operation".into());
    }
    let mut result = Vec::new();
    for item in &request.items {
        let input = Zeroizing::new(B64.decode(item)?);
        let max = if request.purpose == "block" {
            65536 + 1024
        } else {
            16 * 1024 * 1024
        };
        if input.len() > max {
            return Err("object too large".into());
        }
        let (salt, nonce, body) = if request.operation == "seal" {
            let mut salt = [0u8; 32];
            OsRng.try_fill_bytes(&mut salt)?;
            (salt, Nonce::generate_os()?, input.as_slice())
        } else {
            if input.len() < 60 {
                return Err("truncated object".into());
            }
            (
                input[..32].try_into()?,
                Nonce::from_bytes(&input[32..44])?,
                &input[44..],
            )
        };
        // A random salt gives every object a separate key, including repeated plaintext.
        let prk = Zeroizing::new(hkdf_extract(Some(&salt), &secret));
        let derived = Zeroizing::new(hkdf_expand_with_info(&prk, &aad, 32)?);
        let key = Key::from_bytes(&derived)?;
        let output = if request.operation == "seal" {
            let mut output = salt.to_vec();
            output.extend_from_slice(nonce.as_bytes());
            output.extend_from_slice(&seal_with_aad(&key, &nonce, &aad, body)?);
            output
        } else {
            open_with_aad(&key, &nonce, &aad, body)?
        };
        let output = Zeroizing::new(output);
        result.push(B64.encode(&output));
    }
    Ok(json!({"version":1, "items":result}))
}

fn run() -> Result<()> {
    let mut input = Zeroizing::new(Vec::new());
    std::io::stdin()
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut input)?;
    if input.len() > LIMIT {
        return Err("request too large".into());
    }
    let mut value: Value = serde_json::from_slice(&input)?;
    if value["version"] != 1 || value.get("directory").is_none() {
        return Err("incompatible-format".into());
    }
    let result = identity::process(&value);
    custody::wipe(&mut value);
    let mut output = json!({"version":1,"result":result?});
    let encoded = Zeroizing::new(serde_json::to_vec(&output)?);
    custody::wipe(&mut output);
    std::io::stdout().write_all(&encoded)?;
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        // Do not reflect parse errors, crypto errors, plaintext, paths, or key material.
        let state = match error.to_string().as_str() {
            "authentication-required" => "authentication-required",
            "locked" => "locked",
            "enrollment-required" => "enrollment-required",
            "revoked" => "revoked",
            "recovery-required" => "recovery-required",
            "conflict" => "conflict",
            "incompatible-format" => "incompatible-format",
            _ => "verification-failed",
        };
        let _ = std::io::stdout()
            .write_all(format!("{{\"version\":1,\"error\":\"{state}\"}}").as_bytes());
        std::process::exit(1);
    }
}
