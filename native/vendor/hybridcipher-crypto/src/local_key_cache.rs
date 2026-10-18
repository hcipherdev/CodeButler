//! Account-key cache shared by the desktop and CLI.
//!
//! Windows caches are bound to the logged-on user by DPAPI. Legacy Base64 caches
//! are migrated before returning a key. This does not protect against malicious
//! code running as that user, or undo exposure of previously copied raw caches.

use alloc::{format, vec::Vec};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{fs, io, path::Path};
use zeroize::Zeroizing;

#[cfg(windows)]
const PREFIX: &str = "hybridcipher-dpapi-v1:";

/// Save an account key using the platform's persistent-unlock policy.
pub fn save(path: &Path, key: &[u8; 32]) -> io::Result<()> {
    #[cfg(windows)]
    let encoded = format!("{}{}", PREFIX, STANDARD.encode(dpapi(key, false)?));
    #[cfg(not(windows))]
    let encoded = Zeroizing::new(STANDARD.encode(key));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let temporary = path.with_file_name(format!(".account-key-{:016x}.tmp", rand::random::<u64>()));
    let mut file = options.open(&temporary)?;
    let result = (|| {
        file.write_all(encoded.as_bytes())?;
        file.sync_all()?;
        drop(file);
        // Replace the cache entry atomically, rather than following a possible
        // link or exposing a partially written cache to another process.
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Load a key, migrating legacy Windows raw caches before allowing their use.
pub fn load(path: &Path) -> io::Result<[u8; 32]> {
    let encoded = Zeroizing::new(fs::read_to_string(path)?);
    #[cfg(windows)]
    if let Some(blob) = encoded.trim().strip_prefix(PREFIX) {
        let blob = STANDARD.decode(blob).map_err(invalid)?;
        let bytes = dpapi(&blob, true)?;
        return bytes.as_slice().try_into().map_err(invalid);
    }
    let bytes = Zeroizing::new(STANDARD.decode(encoded.trim()).map_err(invalid)?);
    let key: [u8; 32] = bytes.as_slice().try_into().map_err(invalid)?;
    #[cfg(windows)]
    save(path, &key)?;
    Ok(key)
}

fn invalid(error: impl core::fmt::Display) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("Invalid account-key cache: {error}"),
    )
}

/// Migrate all legacy Windows caches, including accounts not currently selected.
/// Protected entries are left alone. Unusable legacy caches are removed so the
/// user can log in again; inability to migrate/remove a cache fails visibly.
#[cfg(windows)]
pub fn migrate_users_directory(users: &Path) -> io::Result<()> {
    for entry in fs::read_dir(users)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let path = entry.path().join(".account_key_cache");
        if !path.is_file() {
            continue;
        }
        let encoded = Zeroizing::new(fs::read_to_string(&path)?);
        if !encoded.trim().starts_with(PREFIX) {
            let decoded = STANDARD.decode(encoded.trim()).map(Zeroizing::new);
            match decoded {
                Ok(key) if key.len() == 32 => {
                    let key: Zeroizing<[u8; 32]> =
                        Zeroizing::new(key.as_slice().try_into().map_err(invalid)?);
                    save(&path, &key)?;
                }
                _ => fs::remove_file(&path)?,
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn dpapi(bytes: &[u8], decrypt: bool) -> io::Result<Zeroizing<Vec<u8>>> {
    use core::ptr::{null, null_mut};
    use winapi::um::{
        dpapi::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN},
        winbase::LocalFree,
        wincrypt::DATA_BLOB,
    };
    let mut input = DATA_BLOB {
        cbData: bytes.len().try_into().map_err(invalid)?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = DATA_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    // The input slice remains alive throughout the call. DPAPI allocates output
    // with LocalAlloc; copy it, zero plaintext, then release with LocalFree.
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
            return Err(io::Error::last_os_error());
        }
        let result = Zeroizing::new(
            core::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec(),
        );
        if decrypt {
            use zeroize::Zeroize;
            core::slice::from_raw_parts_mut(output.pbData, output.cbData as usize).zeroize();
        }
        LocalFree(output.pbData.cast());
        Ok(result)
    }
}

#[cfg(all(test, windows))]
mod security_regression {
    use super::*;
    #[test]
    fn windows_account_cache_round_trip_migration_and_tamper() {
        let root = std::env::temp_dir().join(format!(
            "hybridcipher-cache-test-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let account = root.join("inactive-account");
        fs::create_dir_all(&account).unwrap();
        let path = account.join(".account_key_cache");
        let invalid_account = root.join("invalid-account");
        fs::create_dir(&invalid_account).unwrap();
        let invalid_path = invalid_account.join(".account_key_cache");
        fs::write(&invalid_path, "corrupt cache").unwrap();
        let key = [0x37; 32];
        fs::write(&path, STANDARD.encode(key)).unwrap();
        migrate_users_directory(&root).unwrap();
        assert!(!invalid_path.exists());
        assert_eq!(load(&path).unwrap(), key);
        let encoded = fs::read_to_string(&path).unwrap();
        assert!(encoded.starts_with(PREFIX));
        assert!(!encoded.contains(&STANDARD.encode(key)));
        assert_eq!(load(&path).unwrap(), key);
        let mut blob = STANDARD
            .decode(encoded.strip_prefix(PREFIX).unwrap())
            .unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 1;
        fs::write(&path, format!("{}{}", PREFIX, STANDARD.encode(blob))).unwrap();
        assert!(load(&path).is_err());
        fs::remove_file(&path).unwrap();
        fs::remove_dir(account).unwrap();
        fs::remove_dir(invalid_account).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
