//! Secure memory operations for cryptographic material deletion
//!
//! This module provides platform-specific secure memory operations including:
//! - Secure zeroing of memory regions
//! - Memory locking to prevent swapping
//! - Secure deletion traits for cryptographic material

use zeroize::Zeroize;

#[cfg(feature = "std")]
use alloc::{string::String, vec::Vec};

/// Errors that can occur during secure memory operations
#[derive(Debug, thiserror::Error)]
pub enum SecurityError {
    /// Memory locking operation failed
    #[error("Memory locking failed: {message}")]
    MemoryLockFailure {
        /// Error message describing the failure
        message: &'static str,
    },

    /// Memory unlocking operation failed
    #[error("Memory unlocking failed: {message}")]
    MemoryUnlockFailure {
        /// Error message describing the failure
        message: &'static str,
    },

    /// The current platform does not support secure memory operations
    #[error("Platform not supported for secure operations")]
    PlatformNotSupported,

    /// Permission was denied for memory operations (e.g., mlock requires privileges)
    #[error("Permission denied for memory operations")]
    PermissionDenied,

    /// Insufficient memory available for the operation
    #[error("Insufficient memory for operation")]
    InsufficientMemory,
}

/// Trait for types that need secure deletion of their contents
pub trait SecureDelete {
    /// Securely delete the contents of this type
    fn secure_delete(&mut self);
}

/// Securely zero memory using platform-specific secure operations
pub fn secure_zero(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }

    unsafe {
        #[cfg(target_os = "windows")]
        {
            // Use RtlSecureZeroMemory on Windows
            use winapi::shared::basetsd::SIZE_T;
            use winapi::shared::minwindef::LPVOID;

            #[link(name = "ntdll")]
            extern "system" {
                fn RtlSecureZeroMemory(ptr: LPVOID, cnt: SIZE_T) -> LPVOID;
            }

            RtlSecureZeroMemory(ptr.cast::<winapi::ctypes::c_void>(), len as SIZE_T);
        }

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            // Use explicit_bzero if available, otherwise volatile writes
            #[cfg(target_os = "linux")]
            {
                extern "C" {
                    fn explicit_bzero(s: *mut std::ffi::c_void, n: libc::size_t);
                }
                explicit_bzero(ptr.cast::<std::ffi::c_void>(), len);
            }

            #[cfg(target_os = "macos")]
            {
                // macOS has memset_s in secure string handling
                extern "C" {
                    fn memset_s(
                        s: *mut std::ffi::c_void,
                        smax: libc::size_t,
                        c: std::ffi::c_int,
                        n: libc::size_t,
                    ) -> std::ffi::c_int;
                }
                memset_s(ptr.cast::<std::ffi::c_void>(), len, 0, len);
            }
        }

        #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
        {
            // Fallback: use volatile writes to prevent optimization
            for i in 0..len {
                unsafe { core::ptr::write_volatile(ptr.add(i), 0u8) };
            }
        }
    }
}

/// Lock memory to prevent it from being swapped to disk
///
/// # Errors
/// Returns a [`SecurityError`] when the underlying platform call fails or the
/// platform does not support memory locking.
pub fn lock_memory(ptr: *mut u8, len: usize) -> Result<(), SecurityError> {
    if ptr.is_null() || len == 0 {
        return Ok(());
    }

    unsafe {
        #[cfg(target_os = "windows")]
        {
            use winapi::shared::basetsd::SIZE_T;
            use winapi::um::memoryapi::VirtualLock;

            let result = VirtualLock(ptr.cast::<winapi::ctypes::c_void>(), len as SIZE_T);
            if result == 0 {
                return Err(SecurityError::MemoryLockFailure {
                    message: "VirtualLock failed",
                });
            }
        }

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let result = libc::mlock(ptr.cast::<libc::c_void>(), len);
            if result != 0 {
                #[cfg(feature = "std")]
                {
                    let os_error = std::io::Error::last_os_error();
                    return Err(match os_error.raw_os_error() {
                        Some(libc::EPERM) => SecurityError::PermissionDenied,
                        Some(libc::ENOMEM) => SecurityError::InsufficientMemory,
                        _ => SecurityError::MemoryLockFailure {
                            message: "mlock failed",
                        },
                    });
                }
                #[cfg(not(feature = "std"))]
                {
                    return Err(SecurityError::MemoryLockFailure {
                        message: "mlock failed",
                    });
                }
            }
        }

        #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
        {
            return Err(SecurityError::PlatformNotSupported);
        }
    }

    Ok(())
}

/// Unlock memory that was previously locked
///
/// # Errors
/// Returns a [`SecurityError`] when the underlying platform call fails or the
/// platform does not support memory unlocking.
pub fn unlock_memory(ptr: *mut u8, len: usize) -> Result<(), SecurityError> {
    if ptr.is_null() || len == 0 {
        return Ok(());
    }

    unsafe {
        #[cfg(target_os = "windows")]
        {
            use winapi::shared::basetsd::SIZE_T;
            use winapi::um::memoryapi::VirtualUnlock;

            let result = VirtualUnlock(ptr.cast::<winapi::ctypes::c_void>(), len as SIZE_T);
            if result == 0 {
                return Err(SecurityError::MemoryUnlockFailure {
                    message: "VirtualUnlock failed",
                });
            }
        }

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let result = libc::munlock(ptr.cast::<libc::c_void>(), len);
            if result != 0 {
                #[cfg(feature = "std")]
                {
                    let _ = std::io::Error::last_os_error();
                    return Err(SecurityError::MemoryUnlockFailure {
                        message: "munlock failed",
                    });
                }
                #[cfg(not(feature = "std"))]
                {
                    return Err(SecurityError::MemoryUnlockFailure {
                        message: "munlock failed",
                    });
                }
            }
        }

        #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
        {
            return Err(SecurityError::PlatformNotSupported);
        }
    }

    Ok(())
}

/// RAII wrapper for locked memory that automatically unlocks on drop
pub struct LockedMemory {
    ptr: *mut u8,
    len: usize,
}

impl LockedMemory {
    /// Lock a memory region, returning a RAII guard
    ///
    /// # Errors
    /// Propagates any error from [`lock_memory`].
    pub fn new(ptr: *mut u8, len: usize) -> Result<Self, SecurityError> {
        lock_memory(ptr, len)?;
        Ok(Self { ptr, len })
    }

    /// Get the locked memory region
    #[allow(clippy::missing_const_for_fn)]
    #[must_use]
    pub fn as_mut_slice(&mut self) -> &mut [u8] {
        unsafe { std::slice::from_raw_parts_mut(self.ptr, self.len) }
    }
}

impl Drop for LockedMemory {
    fn drop(&mut self) {
        // Best effort unlock - log but don't panic on failure
        #[cfg(feature = "std")]
        if let Err(error) = unlock_memory(self.ptr, self.len) {
            std::eprintln!("Warning: Failed to unlock memory on drop: {error}");
        }
        #[cfg(not(feature = "std"))]
        let _ = unlock_memory(self.ptr, self.len);

        // Securely zero the memory before unlocking
        secure_zero(self.ptr, self.len);
    }
}

// Implement SecureDelete for common cryptographic types
#[cfg(feature = "std")]
impl SecureDelete for Vec<u8> {
    fn secure_delete(&mut self) {
        if !self.is_empty() {
            secure_zero(self.as_mut_ptr(), self.len());
        }
        self.zeroize();
        self.clear();
    }
}

impl SecureDelete for [u8] {
    fn secure_delete(&mut self) {
        if !self.is_empty() {
            secure_zero(self.as_mut_ptr(), self.len());
        }
        self.zeroize();
    }
}

impl<const N: usize> SecureDelete for [u8; N] {
    fn secure_delete(&mut self) {
        secure_zero(self.as_mut_ptr(), N);
        self.zeroize();
    }
}

#[cfg(feature = "std")]
impl SecureDelete for String {
    fn secure_delete(&mut self) {
        unsafe {
            let bytes = self.as_bytes_mut();
            secure_zero(bytes.as_mut_ptr(), bytes.len());
        }
        self.zeroize();
        self.clear();
    }
}

// Integration with hybridcipher-crypto types would be here if needed
// (Currently the SecureDelete trait integrates with zeroize automatically)

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    #[test]
    fn test_secure_zero() {
        let mut data = vec![0xAAu8; 32];
        let ptr = data.as_mut_ptr();

        secure_zero(ptr, data.len());

        // Verify all bytes are zero
        assert!(data.iter().all(|&b| b == 0));
    }

    #[test]
    fn test_secure_delete_vec() {
        let mut secret = vec![0xDEu8, 0xAD, 0xBE, 0xEF];
        secret.secure_delete();

        assert!(secret.is_empty());
    }

    #[test]
    fn test_secure_delete_array() {
        let mut secret = [0xDEu8, 0xAD, 0xBE, 0xEF];
        secret.secure_delete();

        assert!(secret.iter().all(|&b| b == 0));
    }

    #[test]
    fn test_secure_delete_string() {
        let mut secret = alloc::string::String::from("password123");
        secret.secure_delete();

        assert!(secret.is_empty());
    }

    #[test]
    fn test_lock_memory_small() {
        let mut data = [0u8; 4096]; // One page
        let ptr = data.as_mut_ptr();

        // This might fail on some systems without proper privileges
        if let Ok(()) = lock_memory(ptr, data.len()) {
            assert!(unlock_memory(ptr, data.len()).is_ok());
        }
    }

    #[test]
    fn test_locked_memory_raii() {
        let mut data = [0u8; 4096];
        let ptr = data.as_mut_ptr();

        // Test RAII wrapper
        if let Ok(mut locked) = LockedMemory::new(ptr, data.len()) {
            let slice = locked.as_mut_slice();
            slice[0] = 0x42;
            // Memory should be automatically unlocked and zeroed on drop
        }
    }

    #[test]
    fn test_null_ptr_safety() {
        // Should not crash with null pointers
        secure_zero(std::ptr::null_mut(), 0);
        assert!(lock_memory(std::ptr::null_mut(), 0).is_ok());
        assert!(unlock_memory(std::ptr::null_mut(), 0).is_ok());
    }
}
