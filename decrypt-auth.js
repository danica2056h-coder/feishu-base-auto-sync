const crypto = require('node:crypto');
const { mkdir, readFile, writeFile } = require('node:fs/promises');

const ENCRYPTED_FILE = 'feishu-auth.enc';
const AUTH_DIR = 'playwright/.auth';
const AUTH_FILE = `${AUTH_DIR}/feishu.json`;

const encodedKey = process.env.FEISHU_AUTH_KEY;

if (!encodedKey) {
  console.error('AUTH_KEY_MISSING');
  process.exitCode = 1;
} else {
  (async () => {
    const normalizedKey = encodedKey.trim();
    const key = Buffer.from(normalizedKey, 'base64');
    if (key.length !== 32 || key.toString('base64') !== normalizedKey) {
      throw new Error('invalid key');
    }

    const envelope = JSON.parse(await readFile(ENCRYPTED_FILE, 'utf8'));
    const iv = Buffer.from(envelope.iv, 'base64');
    const authTag = Buffer.from(envelope.authTag, 'base64');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64');

    if (iv.length !== 12 || authTag.length !== 16) {
      throw new Error('invalid envelope');
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    await mkdir(AUTH_DIR, { recursive: true });
    await writeFile(AUTH_FILE, plaintext, { mode: 0o600 });
    console.log('AUTH_DECRYPTED');
  })().catch(() => {
    console.error('AUTH_DECRYPT_FAILED');
    process.exitCode = 1;
  });
}
