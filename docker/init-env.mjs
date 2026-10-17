// Writes .env from .env.example with fresh random secrets and a new manifest
// signing key pair. Ships in the console image, so self-hosters need neither
// the repository nor openssl:
//
//   docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/work" \
//     ghcr.io/mecko/otakit-console node /app/docker/init-env.mjs
//
// Refuses to overwrite an existing .env, because rotating these would lock you
// out of the database, storage, and sessions.
//
// With --events, instead turns on the `events` profile in an existing .env:
// adds the Tinybird Local tokens and `events` to COMPOSE_PROFILES.
import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith('--')) ?? '/work/.env';

// A static token Tinybird Local accepts at startup (TB_LOCAL_*_TOKEN), in the
// format of `tb local generate-tokens`. Tinybird Local signs these with the
// fixed key "abcd", so the random IDs inside are what keep a token secret.
function tinybirdLocalToken() {
  const payload = Buffer.from(
    `{"u": "${randomUUID()}", "id": "${randomUUID()}", "host": null}`,
  ).toString('base64url');
  const signature = createHmac('sha256', 'abcd').update(payload).digest('base64url');
  return `p.${payload}.${signature}`;
}

function setVariable(env, name, value) {
  const line = `${name}=${value}`;
  const existing = new RegExp(`^${name}=.*$`, 'm');
  return existing.test(env) ? env.replace(existing, line) : `${env.replace(/\n?$/, '\n')}${line}\n`;
}

if (args.includes('--events')) {
  let env = readFileSync(target, 'utf8');
  // Existing tokens stay: Tinybird Local only takes them on its first start.
  if (!/^TINYBIRD_TOKEN=\S/m.test(env)) {
    env = setVariable(env, 'TINYBIRD_TOKEN', tinybirdLocalToken());
    env = setVariable(env, 'TINYBIRD_USER_TOKEN', tinybirdLocalToken());
  }
  const profiles = (env.match(/^COMPOSE_PROFILES=(.*)$/m)?.[1] ?? '')
    .split(',')
    .map((profile) => profile.trim())
    .filter(Boolean);
  if (!profiles.includes('events')) profiles.push('events');
  env = setVariable(env, 'COMPOSE_PROFILES', profiles.join(','));
  writeFileSync(target, env);
  console.log(`Turned on device events in .env (COMPOSE_PROFILES=${profiles.join(',')}).

Next: docker compose up -d, and set ingestUrl in the app (see README).`);
  process.exit(0);
}
const template = readFileSync(join(import.meta.dirname, '.env.example'), 'utf8');

const hex = () => randomBytes(32).toString('hex');
const today = new Date().toISOString().slice(0, 10);
const kid = `key-${today}-${randomBytes(4).toString('hex')}`;
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const signingKey = privateKey
  .export({ type: 'pkcs8', format: 'pem' })
  .split('\n')
  .filter(Boolean)
  .map((line) => `${line}\\n`)
  .join('');
const verificationKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const generated = {
  POSTGRES_PASSWORD: hex,
  S3_SECRET_KEY: hex,
  BETTER_AUTH_SECRET: hex,
  SECRET_KEY: hex,
  CRON_SECRET: hex,
  DATA_ENCRYPTION_KEY: () => randomBytes(32).toString('base64'),
  MANIFEST_SIGNING_KID: () => kid,
  MANIFEST_SIGNING_KEY: () => `"${signingKey}"`,
};

const values = {};
const output = template
  .split(/\r?\n/)
  .map((line) => {
    if (line.startsWith('#') || !line.includes('=')) return line;
    const name = line.slice(0, line.indexOf('='));
    if (Object.hasOwn(generated, name)) return `${name}=${generated[name]()}`;
    values[name] = line.slice(name.length + 1);
    return line;
  })
  .join('\n');

try {
  writeFileSync(target, output, { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.error(
    '.env already exists; leaving it alone. Delete it first to regenerate (this also needs fresh volumes).',
  );
  process.exit(1);
}

console.log(`Wrote .env (mode 600). Keep it private and back it up with your volumes.

Add the manifest verification key to your app's capacitor.config.ts:

  plugins: {
    OtaKit: {
      appId: "YOUR_APP_ID",
      cdnUrl: "${values.OTAKIT_S3_URL}/${values.S3_BUCKET}",
      serverUrl: "${values.OTAKIT_URL}",
      manifestKeys: [{ kid: "${kid}", key: "${verificationKey}" }],
    },
  },

Edit OTAKIT_URL / OTAKIT_S3_URL in .env (and the URLs above) for a server
deployment. Next: docker compose up -d`);
