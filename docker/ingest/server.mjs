// Runs the ingest Worker (packages/ingest, unmodified) under Node for the
// `events` profile, after deploying the tinybird/ project to Tinybird Local.
// Stands in for the Worker's Cloudflare bindings with the limits from its
// wrangler.jsonc: an in-memory queue that hands batches to the Worker's queue
// consumer, and a per-app fixed-window rate limiter. Queued events live in
// memory only; SIGTERM flushes them, a crash loses at most a few seconds.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import worker from '../../packages/ingest/src/index.ts';
import { deployTinybirdProject } from '../tinybird/deploy.mjs';
// The Worker only accepts an https:// Tinybird host; this sends
// https://tinybird:7181 over HTTP on the internal network.
import '../tinybird/http-fetch.mjs';

// Not $PORT: the console image sets PORT=3000 for Next.js.
const PORT = 8787;
const MAX_BATCH_SIZE = 100;
const MAX_BATCH_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 5;
const MAX_QUEUED = 10_000;
const RATE_LIMIT = 5_000;
const RATE_PERIOD_MS = 60_000;
const MAX_BODY_BYTES = 64 * 1024;

const queued = [];
let flushing = null;

const queue = {
  async send(body) {
    // The Worker answers 503 and the plugin retries later.
    if (queued.length >= MAX_QUEUED) throw new Error('Ingest queue is full');
    queued.push({ id: randomUUID(), body, attempts: 0, notBefore: 0 });
    if (queued.length >= MAX_BATCH_SIZE) flush();
  },
};

const windows = new Map();
const rateLimiter = {
  async limit({ key }) {
    const now = Date.now();
    let window = windows.get(key);
    if (!window || now - window.start >= RATE_PERIOD_MS) {
      window = { start: now, count: 0 };
      windows.set(key, window);
    }
    window.count += 1;
    return { success: window.count <= RATE_LIMIT };
  },
};

const token = process.env.TINYBIRD_TOKEN;
if (!token) {
  console.error('[Ingest] TINYBIRD_TOKEN is empty; run init-env.mjs --events (see README).');
  process.exit(1);
}

const env = {
  EVENTS_QUEUE: queue,
  EVENTS_RATE_LIMITER: rateLimiter,
  TINYBIRD_API_HOST: process.env.TINYBIRD_API_HOST ?? 'https://tinybird:7181',
  TINYBIRD_EVENTS_DATASOURCE: 'device_events_raw',
  TINYBIRD_EVENTS_TOKEN: token,
};

async function deliver(messages) {
  const acked = new Set();
  const retried = new Map();
  const batch = {
    queue: 'otakit-events',
    messages: messages.map((message) => ({
      id: message.id,
      body: message.body,
      attempts: message.attempts,
      ack: () => acked.add(message),
      retry: (options = {}) => retried.set(message, options),
    })),
    ackAll: () => messages.forEach((message) => acked.add(message)),
    retryAll: (options = {}) => messages.forEach((message) => retried.set(message, options)),
  };

  try {
    await worker.queue(batch, env);
  } catch (error) {
    console.error('[Ingest] Queue consumer threw, retrying batch', error);
    messages.forEach((message) => retried.set(message, { delaySeconds: 5 }));
  }

  for (const [message, { delaySeconds = 0 }] of retried) {
    if (message.attempts > MAX_RETRIES) {
      console.error('[Ingest] Dropping event after retries', { eventId: message.body.event_id });
      continue;
    }
    message.notBefore = Date.now() + delaySeconds * 1000;
    queued.push(message);
  }
}

async function drain() {
  for (;;) {
    const now = Date.now();
    const ready = queued.filter((message) => message.notBefore <= now).slice(0, MAX_BATCH_SIZE);
    if (ready.length === 0) return;
    for (const message of ready) {
      queued.splice(queued.indexOf(message), 1);
      message.attempts += 1;
    }
    await deliver(ready);
  }
}

// One drain at a time; .finally runs after the assignment even when drain()
// finds nothing to do.
function flush() {
  flushing ??= drain().finally(() => {
    flushing = null;
  });
  return flushing;
}

const flushTimer = setInterval(() => {
  flush();
  const now = Date.now();
  for (const [key, window] of windows) {
    if (now - window.start >= RATE_PERIOD_MS) windows.delete(key);
  }
}, MAX_BATCH_TIMEOUT_MS);

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  try {
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const body = hasBody ? await readBody(request) : undefined;
    if (body === null) {
      response.writeHead(413).end();
      return;
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const result = await worker.fetch(
      new Request(new URL(request.url, 'http://ingest'), { method: request.method, headers, body }),
      env,
    );
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    console.error('[Ingest] Request failed', error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});

// Exits on failure, and compose restarts the service.
await deployTinybirdProject(token);
server.listen(PORT, '0.0.0.0', () => console.log(`[Ingest] Listening on :${PORT}`));

process.on('SIGTERM', () => {
  clearInterval(flushTimer);
  server.close();
  // Delivers what is ready; events waiting on a retry delay are dropped.
  flush().finally(() => process.exit(0));
});
