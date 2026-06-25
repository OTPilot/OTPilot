-- Per-user ECDH P-256 public key (SPKI base64), uploaded by the extension on
-- first login. Used to wrap each recipient's user share (K1) when sharing a code,
-- so the server only transports an opaque blob it can't read.
ALTER TABLE users ADD COLUMN public_key TEXT;
