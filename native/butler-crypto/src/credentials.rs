//! AI provider API keys in the OS credential store (macOS Keychain, Windows Credential Manager).
//! Independent of security-state custody: no enrollment is needed, and keys never touch disk here.
use serde_json::Value;
#[cfg(any(target_os = "macos", windows))]
use serde_json::json;
#[cfg(any(target_os = "macos", windows))]
use zeroize::Zeroizing;

#[cfg(any(target_os = "macos", windows))]
const SERVICE: &str = "org.code-butler.ai-credentials.v1";

pub fn handles(operation: &str) -> bool {
    matches!(operation, "credential-get" | "credential-set" | "credential-delete")
}

/// Connection ids only: lowercase letters, digits and hyphens, so an account name cannot address other items.
fn account(value: &Value) -> crate::Result<String> {
    let id = value["account"].as_str().ok_or("incompatible-format")?;
    let valid = !id.is_empty()
        && id.len() <= 40
        && !id.starts_with('-')
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !valid {
        return Err("incompatible-format".into());
    }
    Ok(id.to_string())
}

#[cfg(any(target_os = "macos", windows))]
pub fn process(value: &Value) -> crate::Result<Value> {
    let entry = keyring::Entry::new(SERVICE, &account(value)?).map_err(|_| "locked")?;
    match value["operation"].as_str().unwrap_or_default() {
        "credential-set" => {
            let secret = Zeroizing::new(value["secret"].as_str().ok_or("incompatible-format")?.to_string());
            if secret.is_empty() || secret.len() > 4096 {
                return Err("incompatible-format".into());
            }
            entry.set_password(&secret).map_err(|_| "locked")?;
            Ok(Value::Null)
        }
        "credential-get" => match entry.get_password() {
            Ok(secret) => {
                let secret = Zeroizing::new(secret);
                Ok(json!(secret.as_str()))
            }
            Err(keyring::Error::NoEntry) => Ok(Value::Null),
            Err(_) => Err("locked".into()),
        },
        "credential-delete" => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(Value::Null),
            Err(_) => Err("locked".into()),
        },
        _ => Err("incompatible-format".into()),
    }
}

/// No credential store on this platform; callers fall back to environment variables.
#[cfg(not(any(target_os = "macos", windows)))]
pub fn process(value: &Value) -> crate::Result<Value> {
    account(value)?;
    Err("locked".into())
}
