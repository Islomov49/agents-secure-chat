//! The only cryptography the server does: roomId derivation and request signature checks (PROTOCOL §3, §6.1).

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

pub const ROOM_LABEL: &[u8] = b"lincor/v1/room";
pub const REQUEST_LABEL: &[u8] = b"lincor/v1/req";

pub fn b64u(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decodes canonical, unpadded base64url.
pub fn b64u_decode(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s).ok()
}

/// Decodes canonical base64url that must be exactly `N` bytes long.
pub fn b64u_decode_array<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != (N * 4).div_ceil(3) {
        return None;
    }
    b64u_decode(s)?.try_into().ok()
}

/// True for base64url text that decodes cleanly (the `data` field of events).
pub fn is_b64u(s: &str) -> bool {
    URL_SAFE_NO_PAD.decode(s).is_ok()
}

/// `roomId = b64u(SHA256("lincor/v1/room" ‖ auth_pub))`.
pub fn room_id_for(auth_pub: &[u8; 32]) -> String {
    let mut h = Sha256::new();
    h.update(ROOM_LABEL);
    h.update(auth_pub);
    b64u(&h.finalize())
}

/// A roomId: 32 bytes of base64url (43 characters).
pub fn is_room_id(s: &str) -> bool {
    b64u_decode_array::<32>(s).is_some()
}

/// A 16-byte base64url id (22 characters): event cids, participant ids, blob ids.
pub fn is_id16(s: &str) -> bool {
    b64u_decode_array::<16>(s).is_some()
}

/// The signed message of PROTOCOL §6.1:
/// `"lincor/v1/req" ‖ LF ‖ METHOD ‖ LF ‖ target ‖ LF ‖ hex(SHA256(body)) ‖ LF ‖ ts ‖ LF ‖ nonce`.
pub fn request_message(method: &str, target: &str, body: &[u8], ts: &str, nonce: &str) -> Vec<u8> {
    let body_hash = hex::encode(Sha256::digest(body));
    let mut m = Vec::with_capacity(
        REQUEST_LABEL.len() + method.len() + target.len() + body_hash.len() + ts.len() + nonce.len() + 5,
    );
    for (i, part) in
        [REQUEST_LABEL, method.as_bytes(), target.as_bytes(), body_hash.as_bytes(), ts.as_bytes(), nonce.as_bytes()]
            .into_iter()
            .enumerate()
    {
        if i > 0 {
            m.push(b'\n');
        }
        m.extend_from_slice(part);
    }
    m
}

/// Strict Ed25519 verification (rejects small-order keys and non-canonical signatures).
pub fn verify(key: &VerifyingKey, message: &[u8], signature: &[u8; 64]) -> bool {
    key.verify_strict(message, &Signature::from_bytes(signature)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn message_layout() {
        let m = request_message("GET", "/api/v1/rooms/x/events?after=3", b"", "1700000000000", "bm9uY2U");
        let expected = "lincor/v1/req\nGET\n/api/v1/rooms/x/events?after=3\n\
             e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n1700000000000\nbm9uY2U";
        assert_eq!(String::from_utf8(m).unwrap(), expected);
    }

    #[test]
    fn sign_and_verify() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk = sk.verifying_key();
        let room = room_id_for(pk.as_bytes());
        assert_eq!(room.len(), 43);
        assert!(is_room_id(&room));
        let m = request_message("POST", &format!("/api/v1/rooms/{room}/events"), b"{}", "1", "n");
        let sig = sk.sign(&m).to_bytes();
        assert!(verify(&pk, &m, &sig));
        let mut bad = sig;
        bad[0] ^= 1;
        assert!(!verify(&pk, &m, &bad));
    }

    #[test]
    fn ids() {
        assert!(is_id16(&b64u(&[1u8; 16])));
        assert!(!is_id16(&b64u(&[1u8; 17])));
        assert!(!is_id16("AAAAAAAAAAAAAAAAAAAAAB")); // non-canonical trailing bits
        assert!(!is_id16("AAAAAAAAAAAAAAAAAAAA+A"));
        assert!(is_b64u("AQID"));
        assert!(!is_b64u("AQID="));
        assert!(!is_b64u("A"));
    }
}
