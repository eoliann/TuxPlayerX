//! Credentials at rest (security audit S10).
//!
//! On Windows, subscription addresses, user names, passwords, MAC addresses and the cached channel lists
//! (whose stream URLs embed credentials) are encrypted with the Data Protection API: only the same Windows
//! account on the same computer can decrypt them, so a copied database or a synced/backed-up profile folder
//! does not reveal them. On Linux the database file is readable by its owner only, and on Android the app's
//! private storage is sandboxed (and excluded from cloud backups).

#[cfg(windows)]
const PREFIX: &str = "dpapi:";

/// Encrypts a value for storage (unchanged on platforms without DPAPI).
pub fn protect(plain: &str) -> String {
    #[cfg(windows)]
    {
        use base64::Engine;
        if plain.is_empty() || plain.starts_with(PREFIX) {
            return plain.to_string();
        }
        if let Some(sealed) = dpapi::protect(plain.as_bytes()) {
            return format!("{PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(sealed));
        }
    }
    plain.to_string()
}

/// Decrypts a stored value. Plain values (older databases, other platforms) are returned unchanged;
/// a value that cannot be decrypted (database copied from another account) reads as empty.
pub fn unprotect(stored: &str) -> String {
    #[cfg(windows)]
    {
        use base64::Engine;
        if let Some(encoded) = stored.strip_prefix(PREFIX) {
            return base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .ok()
                .and_then(|sealed| dpapi::unprotect(&sealed))
                .and_then(|plain| String::from_utf8(plain).ok())
                .unwrap_or_default();
        }
    }
    stored.to_string()
}

pub fn protect_opt(value: &Option<String>) -> Option<String> {
    value.as_deref().map(protect)
}

pub fn unprotect_opt(value: Option<String>) -> Option<String> {
    value.map(|stored| unprotect(&stored))
}

/// True when a stored value is in the form this platform writes (encrypted on Windows).
pub fn is_protected(stored: &str) -> bool {
    #[cfg(windows)]
    {
        stored.is_empty() || stored.starts_with(PREFIX)
    }
    #[cfg(not(windows))]
    {
        let _ = stored;
        true
    }
}

/// Makes the database file and its folder private to the current user (Unix).
pub fn restrict_permissions(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Some(parent) = path.parent() {
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let file = std::path::PathBuf::from(format!("{}{suffix}", path.display()));
            if file.exists() {
                let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600));
            }
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

#[cfg(windows)]
mod dpapi {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

    /// Ties the encrypted values to this application (another program using DPAPI cannot open them by accident).
    const ENTROPY: &[u8] = b"TuxPlayerX credentials v1";

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
    }

    fn take(output: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: on success DPAPI returns a buffer of `cbData` bytes allocated with LocalAlloc.
        let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        unsafe { LocalFree(output.pbData as _) };
        bytes
    }

    pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
        let input = blob(data);
        let entropy = blob(ENTROPY);
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: input/entropy point to live buffers for the duration of the call; output is written by DPAPI.
        let ok = unsafe {
            CryptProtectData(&input, std::ptr::null(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        };
        (ok != 0).then(|| take(output))
    }

    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        let input = blob(data);
        let entropy = blob(ENTROPY);
        let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: as above.
        let ok = unsafe {
            CryptUnprotectData(&input, std::ptr::null_mut(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        };
        (ok != 0).then(|| take(output))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_round_trip() {
        for value in ["", "s3cr3t", "http://h/get.php?username=u&password=p", "ăîșț 🎬"] {
            let stored = protect(value);
            assert_eq!(unprotect(&stored), value);
            assert!(is_protected(&stored));
            #[cfg(windows)]
            if !value.is_empty() {
                assert!(stored.starts_with("dpapi:") && !stored.contains(value), "{stored}");
            }
        }
        // Older plain values are still readable.
        assert_eq!(unprotect("plain"), "plain");
        #[cfg(windows)]
        assert_eq!(unprotect("dpapi:bm90IHZhbGlk"), "");
    }
}
