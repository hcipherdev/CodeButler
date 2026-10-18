//! Butler's signed trust chain and hybrid encrypted key packages.
use crate::custody::{self, Custody};
use crate::*;
use hybridcipher_crypto::hybridkem::{
    self, Context, HybridCiphertext, HybridKeyPair, HybridPublicKey, HybridSecretKey,
};
use sha2::{Digest, Sha256};

const ID_DOMAIN: &[u8] = b"code-butler/identity/v1\0";
// Account profiles stay entirely inside the existing OS-encrypted custody blob.
// Switching credentials retains trust, keys and journals, but never cached lists
// or a previous account's tokens in the newly active profile.
fn select_account(state: &mut Value, account: &Value) -> Result<()> {
    let requested = account.as_str().ok_or("authentication-required")?;
    let previous = state["descriptor"]["accountId"]
        .as_str()
        .or_else(|| state["identityAccountId"].as_str())
        .or_else(|| state["tokens"]["accountId"].as_str())
        .map(str::to_owned);
    if let Some(previous) = previous {
        if previous != requested {
            let mut profiles = state["accountProfiles"]
                .as_object()
                .cloned()
                .unwrap_or_default();
            let mut saved = state.clone();
            saved
                .as_object_mut()
                .ok_or("verification-failed")?
                .remove("accountProfiles");
            saved["tokens"] = Value::Null;
            saved["catalogCache"] = Value::Null;
            profiles.insert(previous, saved);
            let mut restored = profiles
                .remove(requested)
                .unwrap_or_else(|| json!({"version":1,"projects":{},"pins":{},"records":[]}));
            restored["tokens"] = Value::Null;
            restored["catalogCache"] = Value::Null;
            restored["sessionRevision"] = state["sessionRevision"].clone();
            restored["sessionEpoch"] = state["sessionEpoch"].clone();
            restored["accountProfiles"] = Value::Object(profiles);
            *state = restored;
        }
    }
    Ok(())
}
pub fn project_catalog_id(vault_id: &str) -> String {
    let mut bytes = Sha256::digest(
        format!("code-butler/project-catalog\0{}", vault_id.to_lowercase()).as_bytes(),
    )
    .to_vec();
    bytes[6] = (bytes[6] & 15) | 128;
    bytes[8] = (bytes[8] & 63) | 128;
    let h: String = bytes[..16].iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}
pub fn project_secrets_id(parent_id: &str) -> String {
    let mut bytes = Sha256::digest(format!("code-butler/project-secrets\0{}", parent_id.to_lowercase()).as_bytes()).to_vec();
    bytes[6] = (bytes[6] & 15) | 128;
    bytes[8] = (bytes[8] & 63) | 128;
    let h: String = bytes[..16].iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}
fn is_secrets_resource(project: &str, projects: &serde_json::Map<String, Value>) -> bool {
    projects.keys().any(|parent| parent.as_bytes().get(14) == Some(&b'4') && project_secrets_id(parent) == project)
}
pub fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub fn canonical(value: &Value) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(value)?)
}
pub fn digest(value: &Value) -> Result<String> {
    Ok(hash(&canonical(value)?))
}
pub fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| "verification-failed".into())
}
fn number(value: &Value, key: &str) -> Result<u64> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| "verification-failed".into())
}
fn bytes(value: &Value, key: &str) -> Result<Zeroizing<Vec<u8>>> {
    Ok(Zeroizing::new(B64.decode(string(value, key)?)?))
}
fn sign(seed: &str, record: Value) -> Result<Value> {
    let key = SigningKey::from_bytes(&Zeroizing::new(B64.decode(seed)?))?;
    let mut msg = ID_DOMAIN.to_vec();
    msg.extend(canonical(&record)?);
    Ok(json!({"record":record,"signature":B64.encode(key.sign(&msg)?.as_bytes())}))
}
pub fn verify(signed: &Value, public: &str) -> Result<()> {
    let mut msg = ID_DOMAIN.to_vec();
    msg.extend(canonical(
        signed.get("record").ok_or("verification-failed")?,
    )?);
    VerifyingKey::from_bytes(&B64.decode(public)?)?.verify(
        &msg,
        &Signature::from_bytes(&B64.decode(string(signed, "signature")?)?)?,
    )?;
    Ok(())
}
fn identity(id: &str, installation: &str, label: &str) -> Result<Value> {
    let seed = Zeroizing::new(custody::random_key());
    let signing = SigningKey::from_bytes(&seed)?;
    let kem = HybridKeyPair::generate(&mut OsRng)?;
    Ok(
        json!({"seed":B64.encode(&seed),"secret":B64.encode(Zeroizing::new(kem.secret.to_bytes()).as_slice()),"public":{"id":id,"installationId":installation,"label":label,"signingKey":B64.encode(signing.verifying_key().as_bytes()),"kemKey":B64.encode(kem.public.to_bytes())}}),
    )
}
fn wrap(public: &str, aad: &Value, plain: &Value) -> Result<Value> {
    let (encapsulation, secret) = hybridkem::encap(
        &HybridPublicKey::from_bytes(&B64.decode(public)?)?,
        Context::Welcome,
        &mut OsRng,
    )?;
    let plain = Zeroizing::new(canonical(plain)?);
    Ok(
        json!({"kem":B64.encode(encapsulation.to_bytes()),"ciphertext":B64.encode(custody::seal(secret.as_bytes(), &canonical(aad)?, &plain)?)}),
    )
}
fn unwrap(secret: &str, aad: &Value, package: &Value) -> Result<Value> {
    let secret = HybridSecretKey::from_bytes(&Zeroizing::new(B64.decode(secret)?))?;
    let shared = hybridkem::decap(
        &secret,
        &HybridCiphertext::from_bytes(&B64.decode(string(package, "kem")?)?)?,
        Context::Welcome,
    )?;
    Ok(serde_json::from_slice(&custody::open(
        shared.as_bytes(),
        &canonical(aad)?,
        &B64.decode(string(package, "ciphertext")?)?,
    )?)?)
}
fn descriptor(state: &Value) -> Result<&Value> {
    state
        .get("descriptor")
        .filter(|v| v.is_object())
        .ok_or_else(|| "enrollment-required".into())
}
fn history(state: &Value) -> Result<&Vec<Value>> {
    state
        .get("records")
        .and_then(Value::as_array)
        .ok_or_else(|| "enrollment-required".into())
}
fn latest(state: &Value) -> Result<&Value> {
    history(state)?
        .last()
        .map(|v| &v["record"])
        .ok_or_else(|| "enrollment-required".into())
}
fn device(state: &Value) -> Result<&Value> {
    state
        .get("device")
        .filter(|v| v.is_object())
        .ok_or_else(|| "enrollment-required".into())
}
fn active(state: &Value) -> Result<()> {
    let id = string(&device(state)?["public"], "id")?;
    if !latest(state)?["devices"]
        .as_array()
        .ok_or("verification-failed")?
        .iter()
        .any(|d| d["id"] == id)
    {
        return Err("revoked".into());
    }
    Ok(())
}
pub fn verify_chain(descriptor: &Value, records: &[Value]) -> Result<()> {
    if records.is_empty() || records.len() > 10000 {
        return Err("verification-failed".into());
    }
    let mut previous: Option<&Value> = None;
    let desc_hash = digest(descriptor)?;
    for (index, signed) in records.iter().enumerate() {
        let record = &signed["record"];
        if record["kind"] != "vault"
            || record["version"] != 1
            || record["descriptor"] != desc_hash
            || record["vaultId"] != descriptor["vaultId"]
            || record["accountId"] != descriptor["accountId"]
            || number(record, "sequence")? != (index + 1) as u64
        {
            return Err("verification-failed".into());
        }
        let issuer = string(record, "issuer")?;
        let devices = record["devices"].as_array().ok_or("verification-failed")?;
        if devices.is_empty() || devices.len() > 10 {
            return Err("verification-failed".into());
        }
        for (i, d) in devices.iter().enumerate() {
            if devices[..i].iter().any(|x| {
                x["id"] == d["id"]
                    || x["signingKey"] == d["signingKey"]
                    || x["kemKey"] == d["kemKey"]
            }) {
                return Err("verification-failed".into());
            }
            VerifyingKey::from_bytes(&B64.decode(string(d, "signingKey")?)?)?;
            HybridPublicKey::from_bytes(&B64.decode(string(d, "kemKey")?)?)?;
        }
        if let Some(prev) = previous {
            if record["parent"] != digest(prev)? {
                return Err("verification-failed".into());
            }
            if record["action"] == "recover" {
                if issuer != string(descriptor, "recoverySigning")? || devices.len() != 1 {
                    return Err("verification-failed".into());
                }
            } else if !prev["record"]["devices"]
                .as_array()
                .ok_or("verification-failed")?
                .iter()
                .any(|d| d["signingKey"] == issuer)
            {
                return Err("verification-failed".into());
            }
        } else if !record["parent"].is_null()
            || record["action"] != "init"
            || (descriptor["rosterSource"].is_null()
                && devices.as_slice() != [descriptor["firstDevice"].clone()])
            || (descriptor["rosterSource"].is_object()
                && !devices.iter().any(|d| *d == descriptor["firstDevice"]))
            || descriptor["firstDevice"]["signingKey"] != issuer
        {
            return Err("verification-failed".into());
        }
        verify(signed, issuer)?;
        previous = Some(signed);
    }
    Ok(())
}
fn accept(state: &mut Value, records: &Value) -> Result<()> {
    let incoming = records.as_array().ok_or("verification-failed")?;
    verify_chain(descriptor(state)?, incoming)?;
    let local = history(state)?;
    if incoming.len() < local.len() || !local.iter().zip(incoming).all(|(a, b)| a == b) {
        return Err("verification-failed".into());
    }
    state["records"] = records.clone();
    Ok(())
}
fn package_aad(record: &Value, state: &Value) -> Value {
    json!([
        if state["domain"] == "secrets" {
            "code-butler/secrets-key-delivery/v1"
        } else {
            "code-butler/key-delivery/v1"
        },
        record["vaultId"],
        record["sequence"],
        record["parent"],
        record["action"],
        record["requestHash"]
    ])
}
fn key_payload(state: &Value) -> Value {
    json!({"projects":state["projects"],"pins":state["pins"],"kit":state["recoveryKit"]})
}
fn new_record(
    state: &Value,
    devices: Value,
    action: &str,
    request_hash: Value,
    recovery_seed: Option<&str>,
) -> Result<Value> {
    let desc = descriptor(state)?;
    let records = history(state)?;
    let d = device(state)?;
    let issuer = if recovery_seed.is_some() {
        string(desc, "recoverySigning")?
    } else {
        string(&d["public"], "signingKey")?
    };
    let projects: serde_json::Map<String, Value> = state["projects"]
        .as_object()
        .ok_or("verification-failed")?
        .iter()
        .map(|(id, p)| (id.clone(), p["epoch"].clone()))
        .collect();
    let mut record = json!({"version":1,"kind":"vault","vaultId":desc["vaultId"],"accountId":desc["accountId"],"descriptor":digest(desc)?,"sequence":records.len()+1,"parent":records.last().map(digest).transpose()?,"issuer":issuer,"devices":devices,"projects":projects,"action":action,"requestHash":request_hash,"packages":{}});
    let aad = package_aad(&record, state);
    let payload = key_payload(state);
    for recipient in devices.as_array().ok_or("verification-failed")? {
        record["packages"][string(recipient, "id")?] =
            wrap(string(recipient, "kemKey")?, &aad, &payload)?;
    }
    record["recovery"] = wrap(string(desc, "recoveryKem")?, &aad, &payload)?;
    sign(recovery_seed.unwrap_or(string(d, "seed")?), record)
}
fn import_keys(state: &mut Value, signed: &Value, recovery_secret: Option<&str>) -> Result<()> {
    let record = &signed["record"];
    let d = device(state)?;
    let package = if recovery_secret.is_some() {
        &record["recovery"]
    } else {
        &record["packages"][string(&d["public"], "id")?]
    };
    let payload = unwrap(
        recovery_secret.unwrap_or(string(d, "secret")?),
        &package_aad(record, state),
        package,
    )?;
    if payload["projects"]
        .as_object()
        .ok_or("verification-failed")?
        .len()
        != record["projects"]
            .as_object()
            .ok_or("verification-failed")?
            .len()
    {
        return Err("verification-failed".into());
    }
    for (id, p) in payload["projects"]
        .as_object()
        .ok_or("verification-failed")?
    {
        if p["epoch"] != record["projects"][id] || !p["keys"].is_object() {
            return Err("verification-failed".into());
        }
    }
    state["projects"] = payload["projects"].clone();
    if !payload["kit"].is_null() {
        state["recoveryKit"] = payload["kit"].clone();
    }
    // A key package cannot roll back an already accepted project pin.
    for (id, pin) in payload["pins"].as_object().ok_or("verification-failed")? {
        let old = &state["pins"][id];
        if old.is_null() || number(pin, "revision")? > number(old, "revision")? {
            state["pins"][id] = pin.clone();
        } else if pin["revision"] == old["revision"] && pin["commitment"] != old["commitment"] {
            return Err("verification-failed".into());
        }
    }
    Ok(())
}
fn public_status(state: &Value) -> Result<Value> {
    let pending_request = if state["request"].is_null() {
        Value::Null
    } else {
        json!({"requestId":state["request"]["record"]["requestId"],
            "accountId":state["request"]["record"]["accountId"],
            "vaultId":state["request"]["record"]["vaultId"],
            "expiresAt":state["request"]["record"]["expiresAt"],
            "kind":state["request"]["record"]["kind"],"version":state["request"]["record"]["version"],
            "fingerprint":digest(&state["request"])?})
    };
    Ok(
        json!({"device":state["device"]["public"],"descriptor":state["descriptor"],"records":state["records"],"pins":state["pins"],"staged":state["staged"]["record"],"projects":state["projects"].as_object().map(|p| p.iter().map(|(id,v)| (id.clone(),v["epoch"].clone())).collect::<serde_json::Map<String,Value>>()),"recoveryReady":state["recoveryPending"].is_null(),"recoveryLoaded":!state["recoveryWorking"].is_null(),"pendingRequest":pending_request}),
    )
}

pub fn process(input: &Value) -> Result<Value> {
    let op = string(input, "operation")?;
    if op == "capabilities" {
        return Ok(json!({"projectCatalog":1,"deviceEnrollment":2,"accountSecrets":1,"sessionWrites":1}));
    }
    let mut store = Custody::load(
        string(input, "directory")?,
        matches!(
            op,
            "device-create"
                | "device-clone"
                | "identity-adopt"
                | "initialize"
                | "provision-complete"
                | "tokens-save"
                | "session-read"
                | "recovery-load"
        ),
    )?;
    let s = &mut store.state;
    let domain = input["domain"].as_str().unwrap_or("memory");
    if !matches!(domain, "memory" | "secrets")
        || (s["domain"] == "secrets" && domain != "secrets")
        || (s["domain"] == "memory" && domain != "memory")
        || (s["domain"].is_null()
            && domain == "secrets"
            && (!s["device"].is_null() || !s["descriptor"].is_null() || !s["tokens"].is_null()))
    {
        return Err("verification-failed".into());
    }
    let result = match op {
        "status" => public_status(s)?,
        "catalog-cache-read" => {
            active(s)?;
            if s["catalogCache"]["vaultId"] == s["descriptor"]["vaultId"] {
                s["catalogCache"].clone()
            } else {
                Value::Null
            }
        }
        "catalog-cache-save" => {
            active(s)?;
            if input["vaultId"] != s["descriptor"]["vaultId"]
                || canonical(&input["value"])?.len() > 1024 * 1024
            {
                return Err("verification-failed".into());
            }
            s["catalogCache"] = json!({"vaultId":input["vaultId"],"value":input["value"],"checkedAt":input["checkedAt"]});
            json!({"saved":true})
        }
        "device-create" => {
            if !input["accountId"].is_null() {
                select_account(s, &input["accountId"])?;
            }
            if input["domain"] == "secrets" {
                s["domain"] = json!("secrets");
            }
            if !input["accountId"].is_null() {
                if !s["identityAccountId"].is_null() && s["identityAccountId"] != input["accountId"]
                {
                    return Err("verification-failed".into());
                }
                s["identityAccountId"] = input["accountId"].clone();
            }
            if s["device"].is_null() {
                s["device"] = identity(
                    string(input, "deviceId")?,
                    string(input, "installationId")?,
                    string(input, "label")?,
                )?;
            }
            s["device"]["public"].clone()
        }
        "device-clone" => {
            s["domain"] = json!("secrets");
            let source = Custody::load(string(input, "identityDirectory")?, false)?;
            if source.state["identityAccountId"] != input["accountId"]
                || source.state["device"]["public"]["id"] != input["deviceId"]
            {
                return Err("verification-failed".into());
            }
            if !s["device"].is_null() && s["device"]["public"] != source.state["device"]["public"] {
                return Err("verification-failed".into());
            }
            s["device"] = source.state["device"].clone();
            s["device"]["public"].clone()
        }
        "identity-adopt" => {
            s["domain"] = json!("secrets");
            let source = Custody::load(string(input, "sourceDirectory")?, false)?;
            let desc = descriptor(&source.state)?;
            verify_chain(desc, history(&source.state)?)?;
            active(&source.state)?;
            if desc["accountId"] != input["accountId"]
                || source.state["device"]["public"]["id"] != input["deviceId"]
                || (!s["identityAccountId"].is_null()
                    && s["identityAccountId"] != input["accountId"])
            {
                return Err("verification-failed".into());
            }
            s["device"] = source.state["device"].clone();
            s["identityAccountId"] = input["accountId"].clone();
            s["device"]["public"].clone()
        }
        "tokens-save" => {
            if input["refresh"] == true
                && (s["tokens"].is_null() || s["tokens"]["accountId"] != input["tokens"]["accountId"])
            {
                return Err("authentication-required".into());
            }
            if !input["expectedRevision"].is_null()
                && input["expectedRevision"].as_u64() != Some(s["sessionRevision"].as_u64().unwrap_or(0))
            {
                return Err("authentication-required".into());
            }
            if !input["expectedEpoch"].is_null()
                && input["expectedEpoch"].as_u64() != Some(s["sessionEpoch"].as_u64().unwrap_or(0))
            {
                return Err("authentication-required".into());
            }
            select_account(s, &input["tokens"]["accountId"])?;
            if s["tokens"]["accountId"] != input["tokens"]["accountId"] {
                s["catalogCache"] = Value::Null;
            }
            s["tokens"] = input["tokens"].clone();
            s["sessionRevision"] = json!(s["sessionRevision"].as_u64().unwrap_or(0).checked_add(1).ok_or("verification-failed")?);
            if input["refresh"] != true {
                s["sessionEpoch"] = json!(s["sessionEpoch"].as_u64().unwrap_or(0).checked_add(1).ok_or("verification-failed")?);
            }
            json!({"saved":true})
        }
        "tokens-read" => s["tokens"].clone(),
        "session-read" => json!({"tokens":s["tokens"],"revision":s["sessionRevision"].as_u64().unwrap_or(0),"epoch":s["sessionEpoch"].as_u64().unwrap_or(0)}),
        "kit-read" => s["recoveryKit"].clone(),
        "logout" => {
            if !input["expectedRevision"].is_null()
                && input["expectedRevision"].as_u64() != Some(s["sessionRevision"].as_u64().unwrap_or(0))
            {
                return Err("authentication-required".into());
            }
            s["tokens"] = Value::Null;
            s["catalogCache"] = Value::Null;
            s["sessionRevision"] = json!(s["sessionRevision"].as_u64().unwrap_or(0).checked_add(1).ok_or("verification-failed")?);
            s["sessionEpoch"] = json!(s["sessionEpoch"].as_u64().unwrap_or(0).checked_add(1).ok_or("verification-failed")?);
            json!({"saved":true})
        }
        "initialize" => {
            if !s["descriptor"].is_null() {
                return Ok(public_status(s)?);
            }
            if input["domain"] == "secrets" {
                s["domain"] = json!("secrets");
            }
            if input["identityDirectory"].is_string() {
                let source = Custody::load(string(input, "identityDirectory")?, false)?;
                if source.state["identityAccountId"] != input["accountId"]
                    || source.state["device"]["public"]["id"] != input["deviceId"]
                {
                    return Err("verification-failed".into());
                }
                s["device"] = source.state["device"].clone();
            } else {
                s["device"] = identity(
                    string(input, "deviceId")?,
                    string(input, "installationId")?,
                    string(input, "label")?,
                )?;
            }
            let mut devices = json!([s["device"]["public"]]);
            let mut roster_source = Value::Null;
            if input["rosterDirectory"].is_string() {
                let roster = Custody::load(string(input, "rosterDirectory")?, false)?;
                let desc = descriptor(&roster.state)?;
                verify_chain(desc, history(&roster.state)?)?;
                active(&roster.state)?;
                if desc["accountId"] != input["accountId"]
                    || roster.state["device"]["public"] != s["device"]["public"]
                {
                    return Err("verification-failed".into());
                }
                devices = latest(&roster.state)?["devices"].clone();
                roster_source = json!({"vaultId":desc["vaultId"],"commitment":digest(history(&roster.state)?.last().ok_or("verification-failed")?)?});
            }
            let recovery = identity("recovery", "recovery", "recovery")?;
            s["descriptor"] = json!({"version":1,"vaultId":string(input,"vaultId")?,"accountId":string(input,"accountId")?,"firstDevice":s["device"]["public"],"recoverySigning":recovery["public"]["signingKey"],"recoveryKem":recovery["public"]["kemKey"]});
            if !roster_source.is_null() {
                s["descriptor"]["rosterSource"] = roster_source;
            }
            let record = new_record(s, devices, "init", Value::Null, None)?;
            s["records"] = json!([record]);
            s["recoveryPending"] = recovery;
            public_status(s)?
        }
        "provision-complete" => {
            if !s["descriptor"].is_null() {
                return Err("conflict".into());
            }
            s["domain"] = json!("secrets");
            let identity_store = Custody::load(string(input, "identityDirectory")?, false)?;
            let roster = Custody::load(string(input, "rosterDirectory")?, false)?;
            let desc = &input["descriptor"];
            let records = input["records"].as_array().ok_or("verification-failed")?;
            let roster_desc = descriptor(&roster.state)?;
            verify_chain(roster_desc, history(&roster.state)?)?;
            active(&roster.state)?;
            if identity_store.state["identityAccountId"] != desc["accountId"]
                || roster_desc["accountId"] != desc["accountId"]
                || roster_desc["vaultId"] != desc["rosterSource"]["vaultId"]
                || identity_store.state["device"]["public"] != roster.state["device"]["public"]
            {
                return Err("verification-failed".into());
            }
            let source = history(&roster.state)?
                .iter()
                .find(|r| digest(r).ok().as_deref() == desc["rosterSource"]["commitment"].as_str())
                .ok_or("verification-failed")?;
            if source["record"]["devices"]
                != records.first().ok_or("verification-failed")?["record"]["devices"]
            {
                return Err("verification-failed".into());
            }
            verify_chain(desc, records)?;
            s["device"] = identity_store.state["device"].clone();
            s["descriptor"] = desc.clone();
            s["records"] = input["records"].clone();
            active(s)?;
            import_keys(s, records.last().ok_or("verification-failed")?, None)?;
            public_status(s)?
        }
        "recovery-export" => {
            if s["recoveryPending"].is_null() {
                return Err("recovery-required".into());
            }
            if s["recoveryCode"].is_null() {
                s["recoveryCode"] = Value::String(B64.encode(custody::random_key()));
                let payload = json!({"descriptor":descriptor(s)?,"records":history(s)?,"recovery":s["recoveryPending"]});
                let aad = if s["domain"] == "secrets" {
                    b"code-butler/secrets-recovery-kit/v1".as_slice()
                } else {
                    b"code-butler/recovery-kit/v1".as_slice()
                };
                s["recoveryKit"] = json!({"version":1,"ciphertext":B64.encode(custody::seal(&bytes(s,"recoveryCode")?,aad,&Zeroizing::new(canonical(&payload)?))?)});
            }
            json!({"kit":s["recoveryKit"],"code":s["recoveryCode"]})
        }
        "recovery-confirm" | "recovery-verify" => {
            let kit = &input["kit"];
            let decoded: Value = serde_json::from_slice(&custody::open(
                &bytes(input, "code")?,
                if s["domain"] == "secrets" {
                    b"code-butler/secrets-recovery-kit/v1".as_slice()
                } else {
                    b"code-butler/recovery-kit/v1".as_slice()
                },
                &B64.decode(string(kit, "ciphertext")?)?,
            )?)?;
            if !s["descriptor"].is_null() && decoded["descriptor"] != *descriptor(s)? {
                return Err("verification-failed".into());
            }
            verify_chain(
                &decoded["descriptor"],
                decoded["records"].as_array().ok_or("verification-failed")?,
            )?;
            if op == "recovery-confirm" {
                custody::wipe(&mut s["recoveryPending"]);
                custody::wipe(&mut s["recoveryCode"]);
                s["recoveryPending"] = Value::Null;
                s["recoveryCode"] = Value::Null;
            }
            json!({"verified":true,"fingerprint":digest(&decoded["descriptor"])?})
        }
        "request" => {
            let d = device(s)?;
            let record = json!({"kind":"enrollment","version":1,"accountId":input["accountId"],"vaultId":input["vaultId"],"device":d["public"],"requestId":input["requestId"],"expiresAt":input["expiresAt"]});
            let signed = sign(string(d, "seed")?, record)?;
            s["request"] = signed.clone();
            json!({"request":signed,"fingerprint":digest(&signed)?})
        }
        "request-v2" => {
            let desc = &input["descriptor"];
            if desc["accountId"] != input["accountId"] || desc["vaultId"] != input["vaultId"] {
                return Err("verification-failed".into());
            }
            verify_chain(desc, input["records"].as_array().ok_or("verification-failed")?)?;
            let d = device(s)?;
            let record = json!({"kind":"enrollment-v2","version":2,"accountId":input["accountId"],"vaultId":input["vaultId"],"device":d["public"],"requestId":input["requestId"],"expiresAt":input["expiresAt"],"descriptorHash":digest(desc)?});
            let signed = sign(string(d, "seed")?, record)?;
            s["request"] = signed.clone();
            json!({"request":signed,"fingerprint":digest(&signed)?})
        }
        "request-read" => s["request"].clone(),
        "request-clear" => {
            if s["request"]["record"]["requestId"] == input["requestId"] {
                s["request"] = Value::Null;
            }
            json!({"cleared":true})
        }
        "accept" => {
            accept(s, &input["records"])?;
            active(s)?;
            let signed = history(s)?.last().ok_or("verification-failed")?.clone();
            import_keys(s, &signed, None)?;
            public_status(s)?
        }
        "approve" => {
            active(s)?;
            let request = &input["request"];
            if digest(request)? != string(input, "fingerprint")?
                || !((request["record"]["kind"] == "enrollment" && request["record"]["version"] == 1)
                    || (request["record"]["kind"] == "enrollment-v2" && request["record"]["version"] == 2
                        && request["record"]["descriptorHash"] == digest(descriptor(s)?)?))
                || request["record"]["vaultId"] != descriptor(s)?["vaultId"]
                || request["record"]["accountId"] != descriptor(s)?["accountId"]
            {
                return Err("verification-failed".into());
            }
            let request_hash = digest(request)?;
            let newcomer = &request["record"]["device"];
            verify(request, string(newcomer, "signingKey")?)?;
            if let Some(existing) = history(s)?.iter().find(|r| r["record"]["action"] == "enroll" && r["record"]["requestHash"] == request_hash) {
                if !latest(s)?["devices"].as_array().ok_or("verification-failed")?.iter().any(|d| d == newcomer) {
                    return Err("revoked".into());
                }
                return Ok(json!({"record":existing,"fingerprint":digest(descriptor(s)?)?}));
            }
            let cached = &s["approvals"][&request_hash];
            if !cached.is_null()
                && (cached["record"]["parent"]
                    == digest(history(s)?.last().ok_or("verification-failed")?)?
                    || history(s)?.iter().any(|r| r == cached))
            {
                return Ok(
                    json!({"record":s["approvals"][&request_hash],"fingerprint":digest(descriptor(s)?)?}),
                );
            }
            if number(&request["record"], "expiresAt")? <= number(input, "now")? {
                return Err("verification-failed".into());
            }
            let mut devices = latest(s)?["devices"]
                .as_array()
                .ok_or("verification-failed")?
                .clone();
            if devices.len() >= 10
                || devices
                    .iter()
                    .any(|d| d["id"] == newcomer["id"] || d["signingKey"] == newcomer["signingKey"])
            {
                return Err("conflict".into());
            }
            devices.push(newcomer.clone());
            let record = new_record(s, json!(devices), "enroll", json!(digest(request)?), None)?;
            if s["approvals"].is_null() {
                s["approvals"] = json!({});
            }
            s["approvals"][request_hash] = record.clone();
            json!({"record":record,"fingerprint":digest(descriptor(s)?)?})
        }
        "complete" => {
            let desc = &input["descriptor"];
            if digest(desc)? != string(input, "fingerprint")?
                || desc["vaultId"] != s["request"]["record"]["vaultId"]
                || desc["accountId"] != s["request"]["record"]["accountId"]
            {
                return Err("verification-failed".into());
            }
            let records = input["records"].as_array().ok_or("verification-failed")?;
            verify_chain(desc, records)?;
            let approval = records
                .iter()
                .find(|r| r["record"]["requestHash"] == digest(&s["request"]).unwrap_or_default())
                .ok_or("verification-failed")?;
            if approval["record"]["action"] != "enroll" {
                return Err("verification-failed".into());
            }
            s["descriptor"] = desc.clone();
            s["records"] = input["records"].clone();
            active(s)?;
            import_keys(s, records.last().ok_or("verification-failed")?, None)?;
            public_status(s)?
        }
        "complete-v2" => {
            let request = s["request"].clone();
            let desc = &input["descriptor"];
            if request["record"]["kind"] != "enrollment-v2" || request["record"]["version"] != 2
                || request["record"]["requestId"] != input["requestId"]
                || request["record"]["descriptorHash"] != digest(desc)?
                || desc["vaultId"] != request["record"]["vaultId"] || desc["accountId"] != request["record"]["accountId"]
                || request["record"]["device"] != device(s)?["public"] {
                return Err("verification-failed".into());
            }
            verify(&request, string(&request["record"]["device"], "signingKey")?)?;
            let records = input["records"].as_array().ok_or("verification-failed")?;
            verify_chain(desc, records)?;
            let request_hash = digest(&request)?;
            let approval = records.iter().find(|r| r["record"]["action"] == "enroll" && r["record"]["requestHash"] == request_hash).ok_or("verification-failed")?;
            if !approval["record"]["devices"].as_array().ok_or("verification-failed")?.iter().any(|d| d == &request["record"]["device"]) {
                return Err("verification-failed".into());
            }
            if s["descriptor"].is_null() {
                s["descriptor"] = desc.clone();
                s["records"] = input["records"].clone();
            } else {
                if s["descriptor"] != *desc { return Err("verification-failed".into()); }
                accept(s, &input["records"])?;
            }
            active(s)?;
            if !latest(s)?["devices"].as_array().ok_or("verification-failed")?.iter().any(|d| d == &request["record"]["device"]) {
                return Err("verification-failed".into());
            }
            import_keys(s, records.last().ok_or("verification-failed")?, None)?;
            public_status(s)?
        }
        "project-stage" => {
            active(s)?;
            let id = string(input, "projectId")?;
            if !s["staged"].is_null() {
                return Ok(json!({"record":s["staged"]["record"]}));
            }
            if !s["projects"][id].is_null()
                || s["projects"]
                    .as_object()
                    .ok_or("verification-failed")?
                    .keys()
                    .filter(|project| {
                        **project
                            != project_catalog_id(s["descriptor"]["vaultId"].as_str().unwrap_or(""))
                            && !is_secrets_resource(project, s["projects"].as_object().unwrap())
                    })
                    .count()
                    >= 10
                    && id != project_catalog_id(s["descriptor"]["vaultId"].as_str().unwrap_or(""))
                    && !is_secrets_resource(id, s["projects"].as_object().unwrap())
            {
                return Err("conflict".into());
            }
            let mut staged = s.clone();
            staged["projects"][id] =
                json!({"epoch":1,"keys":{"1":B64.encode(custody::random_key())}});
            let record = new_record(
                &staged,
                latest(s)?["devices"].clone(),
                "project",
                Value::Null,
                None,
            )?;
            s["staged"] = json!({"record":record,"projects":staged["projects"]});
            json!({"record":record})
        }
        "rotation-stage" => {
            let recovering = !s["recoveryWorking"].is_null();
            if !recovering {
                active(s)?;
            }
            if !s["staged"].is_null() {
                return Ok(s["staged"]["record"].clone());
            }
            let devices = if recovering {
                json!([s["device"]["public"]])
            } else {
                json!(latest(s)?["devices"]
                    .as_array()
                    .ok_or("verification-failed")?
                    .iter()
                    .filter(|d| d["id"] != input["removeDeviceId"])
                    .cloned()
                    .collect::<Vec<_>>())
            };
            if devices.as_array().ok_or("verification-failed")?.is_empty() {
                return Err("recovery-required".into());
            }
            let mut staged = s.clone();
            for project in staged["projects"]
                .as_object_mut()
                .ok_or("verification-failed")?
                .values_mut()
            {
                let epoch = number(project, "epoch")? + 1;
                project["epoch"] = json!(epoch);
                project["keys"][epoch.to_string()] = json!(B64.encode(custody::random_key()));
            }
            let record = new_record(
                &staged,
                devices,
                if recovering { "recover" } else { "revoke" },
                Value::Null,
                if recovering {
                    Some(string(&s["recoveryWorking"], "seed")?)
                } else {
                    None
                },
            )?;
            s["staged"] = json!({"record":record,"projects":staged["projects"]});
            record
        }
        "stage-commit" => {
            let record = s["staged"]["record"].clone();
            if digest(&record)? != string(input, "commitment")? {
                return Err("verification-failed".into());
            }
            s["records"]
                .as_array_mut()
                .ok_or("verification-failed")?
                .push(record);
            verify_chain(descriptor(s)?, history(s)?)?;
            s["projects"] = s["staged"]["projects"].clone();
            custody::wipe(&mut s["staged"]);
            s["staged"] = Value::Null;
            custody::wipe(&mut s["recoveryWorking"]);
            s["recoveryWorking"] = Value::Null;
            public_status(s)?
        }
        "stage-abandon" => {
            custody::wipe(&mut s["staged"]);
            s["staged"] = Value::Null;
            json!({"saved":true})
        }
        "recovery-load" => {
            let decoded: Value = serde_json::from_slice(&custody::open(
                &bytes(input, "code")?,
                if input["domain"] == "secrets" {
                    b"code-butler/secrets-recovery-kit/v1".as_slice()
                } else {
                    b"code-butler/recovery-kit/v1".as_slice()
                },
                &B64.decode(string(&input["kit"], "ciphertext")?)?,
            )?)?;
            if decoded["descriptor"]["accountId"] != input["accountId"] {
                return Err("verification-failed".into());
            }
            if !s["descriptor"].is_null() && s["descriptor"] != decoded["descriptor"] {
                return Err("verification-failed".into());
            }
            if input["domain"] == "secrets" {
                s["domain"] = json!("secrets");
            }
            if s["staged"]["record"]["record"]["action"] == "recover"
                && !s["recoveryWorking"].is_null()
            {
                return Ok(public_status(s)?);
            }
            s["descriptor"] = decoded["descriptor"].clone();
            if history(s)?.is_empty() {
                s["records"] = decoded["records"].clone();
            }
            accept(s, &input["records"])?;
            s["device"] = identity(
                string(input, "deviceId")?,
                string(input, "installationId")?,
                string(input, "label")?,
            )?;
            let record = history(s)?.last().ok_or("verification-failed")?.clone();
            import_keys(s, &record, Some(string(&decoded["recovery"], "secret")?))?;
            s["recoveryKit"] = input["kit"].clone();
            s["recoveryWorking"] = decoded["recovery"].clone();
            public_status(s)?
        }
        "proof" => {
            let d = device(s)?;
            let recovery = !s["recoveryWorking"].is_null();
            sign(
                if recovery {
                    string(&s["recoveryWorking"], "seed")?
                } else {
                    string(d, "seed")?
                },
                json!({"kind":"proof","accountId":input["accountId"],"deviceId":if recovery {json!("recovery")} else {d["public"]["id"].clone()},"nonce":input["nonce"],"method":input["method"],"path":input["path"],"bodyHash":input["bodyHash"]}),
            )?
        }
        "recovery-accept" => {
            if s["domain"] != "secrets" || s["recoveryWorking"].is_null() {
                return Err("recovery-required".into());
            }
            accept(s, &input["records"])?;
            let signed = history(s)?.last().ok_or("verification-failed")?.clone();
            let secret = string(&s["recoveryWorking"], "secret")?.to_owned();
            import_keys(s, &signed, Some(&secret))?;
            public_status(s)?
        }
        "recovery-document-sign" => {
            if s["domain"] != "secrets" || s["recoveryWorking"].is_null() {
                return Err("recovery-required".into());
            }
            let record = &input["record"];
            let desc = descriptor(s)?;
            let parent = string(record, "parentProjectId")?;
            if record["kind"] != "secrets-migration" || record["version"] != 1
                || record["accountId"] != desc["accountId"] || record["legacyVaultId"] != desc["vaultId"]
                || record["writer"] != desc["recoverySigning"] || parent.as_bytes().get(14) != Some(&b'4')
                || record["resourceId"] != project_secrets_id(parent) || !record["sourcePin"].is_object() {
                return Err("verification-failed".into());
            }
            sign(string(&s["recoveryWorking"], "seed")?, record.clone())?
        }
        "document-sign" => {
            if s["recoveryWorking"].is_null() {
                active(s)?;
            }
            sign(string(device(s)?, "seed")?, input["record"].clone())?
        }
        "document-verify" => {
            verify(&input["signed"], string(input, "publicKey")?)?;
            json!({"verified":true})
        }
        "pin" => {
            let id = string(input, "projectId")?;
            let pin = &input["pin"];
            let old = &s["pins"][id];
            if !old.is_null()
                && (number(pin, "revision")? < number(old, "revision")?
                    || (pin["revision"] == old["revision"]
                        && pin["commitment"] != old["commitment"]))
            {
                return Err("verification-failed".into());
            }
            s["pins"][id] = pin.clone();
            json!({"saved":true})
        }
        "sync-read" => s["sync"][string(input, "checkoutId")?].clone(),
        "sync-list-cache-refs" => {
            let profiles = std::iter::once(&*s).chain(
                s["accountProfiles"]
                    .as_object()
                    .into_iter()
                    .flat_map(|profiles| profiles.values()),
            );
            let hashes: Vec<String> = profiles
                .flat_map(|profile| {
                    profile["sync"]
                        .as_object()
                        .into_iter()
                        .flat_map(|entries| entries.values())
                })
                .flat_map(|journal| {
                    ["applied", "remote", "pending"]
                        .into_iter()
                        .filter_map(move |slot| journal[slot]["hash"].as_str().map(str::to_owned))
                })
                .collect();
            json!(hashes)
        }
        "sync-save" => {
            let id = string(input, "projectId")?;
            let pin = &input["pin"];
            let old = &s["pins"][id];
            if !old.is_null()
                && (number(pin, "revision")? < number(old, "revision")?
                    || (pin["revision"] == old["revision"]
                        && pin["commitment"] != old["commitment"]))
            {
                return Err("verification-failed".into());
            }
            if s["sync"].is_null() {
                s["sync"] = json!({});
            }
            s["sync"][string(input, "checkoutId")?] = input["value"].clone();
            s["pins"][id] = pin.clone();
            json!({"saved":true})
        }
        "crypto" | "secrets-crypto" => {
            let project = string(input, "projectId")?;
            let epoch = number(input, "epoch")?;
            let mode = string(input, "mode")?;
            if matches!(mode, "seal" | "sign") && s["recoveryWorking"].is_null() {
                active(s)?;
            }
            let projects = if input["staged"] == true {
                &s["staged"]["projects"]
            } else {
                &s["projects"]
            };
            let account_projects = projects.as_object().ok_or("verification-failed")?;
            if op == "secrets-crypto" {
                let parent = string(input, "parentProjectId")?;
                if s["domain"] == "secrets" || parent.as_bytes().get(14) != Some(&b'4')
                    || project_secrets_id(parent) != project || !account_projects.contains_key(parent)
                    || !account_projects.contains_key(project) {
                    return Err("verification-failed".into());
                }
            } else if s["domain"] != "secrets" && is_secrets_resource(project, account_projects) {
                return Err("verification-failed".into());
            }
            let key = if mode == "sign" {
                string(device(s)?, "seed")?
            } else if mode == "verify" {
                string(input, "publicKey")?
            } else {
                projects[project]["keys"][epoch.to_string()]
                    .as_str()
                    .ok_or("enrollment-required")?
            };
            let request: crate::Request = serde_json::from_value(
                json!({"version":1,"operation":mode,"projectId":project,"epoch":epoch,"purpose":input["purpose"],"domain":if op == "secrets-crypto" { json!("secrets") } else { input["domain"].clone() },"key":key,"items":input["items"],"signature":input["signature"]}),
            )?;
            crate::process(&request)?
        }
        _ => return Err("incompatible-format".into()),
    };
    if !matches!(
        op,
        "status"
            | "request-read"
            | "catalog-cache-read"
            | "tokens-read"
            | "kit-read"
            | "recovery-verify"
            | "proof"
            | "document-sign"
            | "recovery-document-sign"
            | "document-verify"
            | "sync-read"
            | "sync-list-cache-refs"
            | "crypto"
            | "secrets-crypto"
    ) {
        store.save()?;
    }
    Ok(result)
}
