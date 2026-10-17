// Entry point of the ingest service. With TINYBIRD_TOKEN set (the `events`
// profile) it runs the ingest Worker; without it, a sink that answers event
// posts and logs them, so devices pointed at this stack drop their events
// instead of retrying them for days.
await import(process.env.TINYBIRD_TOKEN ? './server.mjs' : './sink.mjs');
