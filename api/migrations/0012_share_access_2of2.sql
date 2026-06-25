-- 2-of-2 key split for shared codes. shared_codes.encrypted_secret already holds
-- AES-GCM(totp_secret, K) and sharing_key_iv its IV. Per recipient:
--   server_share          = K2 = K XOR K1   (only the server ever sees this)
--   encrypted_user_share  = K1 wrapped to the recipient's public key (server can't read)
-- TOTP generation needs both halves: client sends K1, server reconstructs K = K1 XOR K2.
ALTER TABLE share_access ADD COLUMN server_share         TEXT NOT NULL DEFAULT '';
ALTER TABLE share_access ADD COLUMN encrypted_user_share TEXT NOT NULL DEFAULT '';
