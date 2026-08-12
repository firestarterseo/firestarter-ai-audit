// Encrypts/decrypts the WordPress Application Password a strategist pastes
// in to connect a client's site (see SchemaGenerator.js / the publish
// route). This is a real, if scoped and revocable, site credential -- it
// never sits in the database in plaintext, same principle as
// SUPABASE_SERVICE_ROLE_KEY never touching disk in this project
// (supabaseServer.js), just applied to a secret this tool itself has to
// round-trip rather than one it only ever reads from an env var.
//
// WP_CREDENTIALS_ENCRYPTION_KEY must be a 32-byte key, base64-encoded, set
// in Vercel's Environment Variables (never committed) -- generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// Losing/rotating this key makes every already-stored Application Password
// permanently undecryptable -- reconnecting a client's WordPress site just
// means pasting the token in again, exactly like reconnecting any other
// third-party integration after a lost secret.

const crypto = require('crypto')

function getKey() {
  const raw = process.env.WP_CREDENTIALS_ENCRYPTION_KEY
  if (!raw) {
    throw new Error('WP_CREDENTIALS_ENCRYPTION_KEY must be set (32-byte key, base64-encoded) to connect or publish to a WordPress site.')
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error('WP_CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes -- generate a fresh one rather than hand-editing this value.')
  }
  return key
}

// encrypt(plaintext) -> string safe to store in a text column.
// AES-256-GCM, not just AES-256-CBC -- GCM's auth tag means a tampered or
// corrupted stored value fails loudly on decrypt instead of silently
// producing garbage bytes that look like a real (wrong) password.
// Format: base64(iv) : base64(authTag) : base64(ciphertext)
function encrypt(plaintext) {
  const key = getKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':')
}

// decrypt(stored) -> plaintext string | null (null if nothing was stored --
// "not connected yet" is a normal state, not an error).
function decrypt(stored) {
  if (!stored) return null
  const key = getKey()
  const parts = stored.split(':')
  if (parts.length !== 3) throw new Error('Malformed encrypted WordPress credential -- expected iv:authTag:ciphertext.')
  const [ivB64, tagB64, dataB64] = parts
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()])
  return plaintext.toString('utf8')
}

module.exports = { encrypt, decrypt }
