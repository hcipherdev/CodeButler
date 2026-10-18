//! OS-bound local state. No file-key or environment-key fallback exists.
use crate::*;
use fs2::FileExt;
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_extension(format!("{:016x}.tmp", rand::random::<u64>()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary, path)?;
    #[cfg(unix)]
    File::open(path.parent().ok_or("locked")?)?.sync_all()?;
    Ok(())
}

#[cfg(windows)]
fn protect(bytes: &[u8], decrypt: bool) -> Result<Zeroizing<Vec<u8>>> {
    use std::ptr::{null, null_mut};
    use winapi::um::{
        dpapi::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN},
        winbase::LocalFree,
        wincrypt::DATA_BLOB,
    };
    let mut input = DATA_BLOB {
        cbData: bytes.len().try_into()?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = DATA_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    // Current-user scope, UI forbidden; never CRYPTPROTECT_LOCAL_MACHINE.
    unsafe {
        let ok = if decrypt {
            CryptUnprotectData(
                &mut input,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &mut input,
                null(),
                null_mut(),
                null_mut(),
                null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("locked".into());
        }
        let raw = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let result = Zeroizing::new(raw.to_vec());
        raw.zeroize();
        LocalFree(output.pbData.cast());
        Ok(result)
    }
}
fn wrapping_key(directory: &Path, create: bool) -> Result<Zeroizing<Vec<u8>>> {
    #[cfg(windows)]
    {
        let path = directory.join("wrapping.dpapi");
        if !path.exists() && create {
            let key = Zeroizing::new(random_key());
            atomic(&path, &protect(&key, false)?)?;
            let readback = protect(&fs::read(&path)?, true)?;
            if readback.as_slice() != key.as_slice() {
                return Err("locked".into());
            }
        }
        let key = protect(&fs::read(path)?, true)?;
        if key.len() != 32 {
            return Err("locked".into());
        }
        return Ok(key);
    }
    #[cfg(target_os = "macos")]
    {
        let account = crate::identity::hash(directory.to_string_lossy().as_bytes());
        let entry = keyring::Entry::new("org.code-butler.security-state.v1", &account)?;
        match entry.get_secret() {
            Ok(key) if key.len() == 32 => return Ok(Zeroizing::new(key)),
            Err(keyring::Error::NoEntry) if create => {
                let key = Zeroizing::new(random_key());
                entry.set_secret(&key)?;
                let readback = Zeroizing::new(entry.get_secret()?);
                if readback.as_slice() != key.as_slice() {
                    return Err("locked".into());
                }
                return Ok(readback);
            }
            _ => return Err("locked".into()),
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (directory, create);
        Err("locked".into())
    }
}
pub fn random_key() -> Vec<u8> {
    let mut key = vec![0; 32];
    OsRng.fill_bytes(&mut key);
    key
}
pub fn seal(key: &[u8], aad: &[u8], plain: &[u8]) -> Result<Vec<u8>> {
    let nonce = Nonce::generate_os()?;
    let mut bytes = nonce.as_bytes().to_vec();
    bytes.extend(seal_with_aad(&Key::from_bytes(key)?, &nonce, aad, plain)?);
    Ok(bytes)
}
pub fn open(key: &[u8], aad: &[u8], bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if bytes.len() < 28 {
        return Err("verification-failed".into());
    }
    Ok(Zeroizing::new(open_with_aad(
        &Key::from_bytes(key)?,
        &Nonce::from_bytes(&bytes[..12])?,
        aad,
        &bytes[12..],
    )?))
}
pub struct Custody {
    pub state: Value,
    path: PathBuf,
    key: Zeroizing<Vec<u8>>,
    _lock: File,
}
impl Custody {
    pub fn load(directory: &str, create: bool) -> Result<Self> {
        let directory = Path::new(directory);
        if !directory.is_absolute() {
            return Err("locked".into());
        }
        fs::create_dir_all(directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        }
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(directory.join("state.lock"))?;
        lock.try_lock_exclusive().map_err(|_| "locked")?;
        let path = directory.join("state.enc");
        // Never create a replacement wrapping key when encrypted state already exists.
        let key = wrapping_key(directory, create && !path.exists()).map_err(|_| "locked")?;
        let state = if path.exists() {
            serde_json::from_slice(&open(
                &key,
                b"code-butler/security-state/v1",
                &fs::read(&path)?,
            )?)?
        } else if create {
            json!({"version":1,"projects":{},"pins":{},"records":[]})
        } else {
            return Err("enrollment-required".into());
        };
        Ok(Self {
            state,
            path,
            key,
            _lock: lock,
        })
    }
    pub fn save(&self) -> Result<()> {
        let plain = Zeroizing::new(serde_json::to_vec(&self.state)?);
        let bytes = seal(&self.key, b"code-butler/security-state/v1", &plain)?;
        atomic(&self.path, &bytes)?;
        if open(
            &self.key,
            b"code-butler/security-state/v1",
            &fs::read(&self.path)?,
        )?
        .as_slice()
            != plain.as_slice()
        {
            return Err("locked".into());
        }
        Ok(())
    }
}
impl Drop for Custody {
    fn drop(&mut self) {
        wipe(&mut self.state);
    }
}
pub fn wipe(value: &mut Value) {
    match value {
        Value::String(s) => s.zeroize(),
        Value::Array(a) => a.iter_mut().for_each(wipe),
        Value::Object(o) => o.values_mut().for_each(wipe),
        _ => {}
    }
}
