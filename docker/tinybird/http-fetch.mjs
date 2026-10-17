// Preloaded with `--import` by the console and the ingest service. Tinybird
// Local only speaks HTTP and stays on the internal network, but both clients
// refuse a TINYBIRD_API_HOST that isn't https://. They're configured with
// https://tinybird:7181, and this sends requests for that origin over HTTP.
const HTTPS_ORIGIN = 'https://tinybird:7181';
const HTTP_ORIGIN = 'http://tinybird:7181';

const originalFetch = globalThis.fetch;

function toHttp(url) {
  return url.startsWith(`${HTTPS_ORIGIN}/`) ? HTTP_ORIGIN + url.slice(HTTPS_ORIGIN.length) : null;
}

globalThis.fetch = function fetch(input, init) {
  if (input instanceof Request) {
    const url = toHttp(input.url);
    return originalFetch(url ? new Request(url, input) : input, init);
  }
  const url = toHttp(String(input));
  return originalFetch(url ?? input, init);
};
