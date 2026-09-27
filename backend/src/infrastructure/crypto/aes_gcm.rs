use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use sha2::{Digest, Sha256};

use super::{Cipher, CryptoError};

const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
pub const DEV_FALLBACK_KEY: &str = "glyph-dev-encryption-key-not-secret-000";

/// AES-256-GCM; blob layout is `nonce(12) ‖ ciphertext ‖ tag(16)`.
pub struct AesGcmCipher {
    cipher: Aes256Gcm,
}

impl AesGcmCipher {
    pub fn new(key: [u8; 32]) -> Self {
        Self {
            cipher: Aes256Gcm::new(&Key::<Aes256Gcm>::from(key)),
        }
    }

    /// `GLYPH_ENCRYPTION_KEY` is base64 of 32 bytes. Without it, a constant dev
    /// key is derived (and a warning logged) — like Rails' dev fallback.
    pub fn from_config(encoded: Option<&str>) -> Result<Self, String> {
        match encoded {
            Some(encoded) => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded.trim())
                    .map_err(|e| format!("GLYPH_ENCRYPTION_KEY is not base64: {e}"))?;
                let key: [u8; 32] = bytes
                    .try_into()
                    .map_err(|_| "GLYPH_ENCRYPTION_KEY must decode to 32 bytes".to_string())?;
                Ok(Self::new(key))
            }
            None => {
                tracing::warn!(
                    "GLYPH_ENCRYPTION_KEY is not set; using the insecure development key"
                );
                Ok(Self::dev())
            }
        }
    }

    pub fn dev() -> Self {
        Self::new(Sha256::digest(DEV_FALLBACK_KEY.as_bytes()).into())
    }
}

impl Cipher for AesGcmCipher {
    fn encrypt(&self, plain: &[u8]) -> Vec<u8> {
        let mut nonce = [0u8; NONCE_LEN];
        getrandom::fill(&mut nonce).expect("the OS random source is available");
        let sealed = self
            .cipher
            .encrypt(&Nonce::from(nonce), plain)
            .expect("AES-GCM encryption cannot fail for in-memory buffers");
        let mut blob = Vec::with_capacity(NONCE_LEN + sealed.len());
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&sealed);
        blob
    }

    fn decrypt(&self, blob: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if blob.len() < NONCE_LEN + TAG_LEN {
            return Err(CryptoError::TooShort);
        }
        let (nonce, sealed) = blob.split_at(NONCE_LEN);
        self.cipher
            .decrypt(
                &Nonce::try_from(nonce).map_err(|_| CryptoError::TooShort)?,
                sealed,
            )
            .map_err(|_| CryptoError::Authentication)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let cipher = AesGcmCipher::dev();
        let blob = cipher.encrypt(b"secret evidence");
        assert_ne!(&blob[NONCE_LEN..], b"secret evidence");
        assert_eq!(cipher.decrypt(&blob).unwrap(), b"secret evidence");
    }

    #[test]
    fn tampering_fails() {
        let cipher = AesGcmCipher::dev();
        let mut blob = cipher.encrypt(b"secret");
        let last = blob.len() - 1;
        blob[last] ^= 1;
        assert!(matches!(cipher.decrypt(&blob), Err(CryptoError::Authentication)));
        assert!(matches!(cipher.decrypt(b"short"), Err(CryptoError::TooShort)));
    }

    #[test]
    fn nonces_are_distinct() {
        let cipher = AesGcmCipher::dev();
        assert_ne!(cipher.encrypt(b"x")[..NONCE_LEN], cipher.encrypt(b"x")[..NONCE_LEN]);
    }

    #[test]
    fn different_keys_cannot_decrypt() {
        let a = AesGcmCipher::new([1; 32]);
        let b = AesGcmCipher::new([2; 32]);
        assert!(b.decrypt(&a.encrypt(b"x")).is_err());
    }

    #[test]
    fn config_key_parsing() {
        let encoded = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
        assert!(AesGcmCipher::from_config(Some(&encoded)).is_ok());
        assert!(AesGcmCipher::from_config(Some("not base64!!")).is_err());
        let short = base64::engine::general_purpose::STANDARD.encode([7u8; 8]);
        assert!(AesGcmCipher::from_config(Some(&short)).is_err());
        assert!(AesGcmCipher::from_config(None).is_ok());
    }
}
