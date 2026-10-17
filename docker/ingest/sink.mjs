// Stands in for the ingest Worker while device events are off (TINYBIRD_TOKEN
// empty). Serves the Worker's routes, answers each event with 200 so the plugin
// removes it from its on-device queue, logs one line per event and stores
// nothing.
import { createServer } from 'node:http';

const PORT = 8787;
const MAX_BODY_BYTES = 64 * 1024;
const HEALTH_PATHS = new Set(['/healthz', '/v1/healthz']);
const LOGGED_FIELDS = [
  'platform',
  'action',
  'bundleVersion',
  'releaseId',
  'channel',
  'runtimeVersion',
  'nativeBuild',
  'phase',
  'detail',
];

// JSON.stringify keeps device-supplied text on one log line.
function summarize(appId, body, tooLarge) {
  const summary = { appId: appId?.slice(0, 64) ?? null };
  if (tooLarge) return { ...summary, tooLarge: true };
  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return { ...summary, invalid: true };
  }
  if (!event || typeof event !== 'object') return { ...summary, invalid: true };
  for (const field of LOGGED_FIELDS) {
    if (typeof event[field] === 'string') summary[field] = event[field].slice(0, 500);
  }
  return summary;
}

const server = createServer((request, response) => {
  const { pathname } = new URL(request.url, 'http://ingest');
  if (request.method === 'GET' && HEALTH_PATHS.has(pathname)) {
    response.writeHead(200).end('ok');
    return;
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }
  if (request.method !== 'POST' || pathname !== '/v1/events') {
    response.writeHead(404).end();
    return;
  }

  const chunks = [];
  let size = 0;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  });
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const summary = summarize(request.headers['x-app-id'], body, size > MAX_BODY_BYTES);
    console.log(`[Ingest] Event discarded ${JSON.stringify(summary)}`);
    response.writeHead(200).end();
  });
  request.on('error', () => response.destroy());
});

server.listen(PORT, '0.0.0.0', () =>
  console.log(`[Ingest] Device events are off; logging and discarding events on :${PORT}`),
);

// Node as PID 1 doesn't exit on SIGTERM by itself.
process.on('SIGTERM', () => process.exit(0));
