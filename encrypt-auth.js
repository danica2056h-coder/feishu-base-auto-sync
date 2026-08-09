const crypto = require('node:crypto');
const { readFile, writeFile } = require('node:fs/promises');

const AUTH_FILE = 'playwright/.auth/feishu.json';
const ENCRYPTED_FILE = 'feishu-auth.enc';
const KEY_FILE = 'FEISHU_AUTH_KEY.txt';

(async () => {
  const plaintext = await readFile(AUTH_FILE);
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const envelope = JSON.stringify({
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  });

  await writeFile(ENCRYPTED_FILE, envelope, { mode: 0o600 });
  await writeFile(KEY_FILE, key.toString('base64'), { mode: 0o600 });

  console.log('AUTH_ENCRYPTED');
  console.log('KEY_FILE_CREATED');
})().catch(() => {
  console.error('AUTH_ENCRYPT_FAILED');
  process.exitCode = 1;
});
