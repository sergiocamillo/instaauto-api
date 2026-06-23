import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'crypto';

/**
 * Cifragem AES-256-GCM para segredos de integração (tokens da Meta).
 *
 * A chave é derivada de uma passphrase (env INTEGRATION_ENC_KEY) via scrypt.
 * O payload final é `iv | authTag | ciphertext` em base64url. Tokens nunca são
 * armazenados em texto puro nem expostos ao frontend.
 */

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SALT = 'instauto-integrations-v1';

export function deriveKey(passphrase: string): Buffer {
  return scryptSync(passphrase, SALT, KEY_LENGTH);
}

export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

export function decryptSecret(payloadB64: string, key: Buffer): string {
  const buf = Buffer.from(payloadB64, 'base64url');
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const data = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8',
  );
}
