mod aes_gcm;

pub use self::aes_gcm::AesGcmCipher;

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("ciphertext is too short")]
    TooShort,
    #[error("ciphertext failed authentication")]
    Authentication,
}

/// Symmetric encryption for evidence at rest. Repositories encrypt/decrypt in
/// their row mapping; domain structs hold plaintext.
pub trait Cipher: Send + Sync {
    fn encrypt(&self, plain: &[u8]) -> Vec<u8>;
    fn decrypt(&self, blob: &[u8]) -> Result<Vec<u8>, CryptoError>;
}
