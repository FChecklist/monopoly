# Rotating secrets

Two secrets protect personal data and keys. Both must be 32 or more characters; the server refuses to start with shorter ones.

* `SEAL_KEY` seals names, e-mails, work ids and key secrets (AES-GCM). New values are written as `s2.<key id>.<label>.<iv>.<ciphertext>`.
  The label (`table.column:row id`) is also authenticated data, so a sealed value cannot be moved to another row unnoticed.
  Older `s1` values are still readable.
* `MASTER_SECRET` makes the lookup hashes (login e-mail, work id, sign-in codes, dice). It also derived the signing secret of keys made
  before secrets were stored sealed. Keys made now have a random secret, stored sealed.

## Rotate SEAL_KEY

1. Choose a new key id (`SEAL_KEY_ID`, for example `k2`). Set `SEAL_KEY` to the new secret.
2. Put the old one in `SEAL_KEYS_OLD` as `k1:<old secret>` (comma separated for more). Values are tried by their key id, then the old keys.
3. Deploy. Everything still reads.
4. Run once: `POST /api/platform/reseal` with the platform token. It re-seals every person field and key secret with the new key and label.
5. Remove `SEAL_KEYS_OLD`.

## Rotate MASTER_SECRET

1. Set the new `MASTER_SECRET`; put the old one in `MASTER_SECRET_OLD` (only needed to read keys made before sealed secrets).
2. Deploy, then run `POST /api/platform/reseal`. It rebuilds the e-mail and work-id hashes from the sealed values and seals the old derived key secrets.
3. Remove `MASTER_SECRET_OLD`. Outstanding sign-in codes stop working; admins issue new ones.

## Older keys (no stored secret)

Keys made before secrets were stored sealed have no sealed secret; their secret is derived from `MASTER_SECRET`. Re-issue each once (admin screen, Connections, or `POST /api/admin/keys/:id/reissue`):
a new random secret is made and shown once, the old one stops working at once. After that `MASTER_SECRET_OLD` is no longer needed for keys.

## Leak of one key

Revoke it in the admin screen (`POST /api/admin/keys/:id/revoke`) and make a new one. A revoked key stops working at once.
