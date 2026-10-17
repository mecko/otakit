// Deploys the tinybird/ project to Tinybird Local the way `tb deploy` does,
// with the workspace token Tinybird Local was started with. The ingest service
// runs this on every start; an unchanged project is a no-op.
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const host = process.env.TINYBIRD_LOCAL_URL ?? 'http://tinybird:7181';
const projectDir = process.env.TINYBIRD_PROJECT_DIR ?? '/app/tinybird';
const DATAFILE_EXTENSIONS = new Set(['.datasource', '.pipe', '.connection']);
const TIMEOUT_MS = 300_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function untilReady(what, check) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    let reason;
    try {
      if (await check()) return;
    } catch (error) {
      if (error.fatal) throw error;
      reason = error.message;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}${reason ? `: ${reason}` : ''}`);
    await sleep(3000);
  }
}

export async function deployTinybirdProject(token) {
  async function api(path, init = {}) {
    const response = await fetch(`${host}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${text}`);
    return JSON.parse(text);
  }

  await untilReady('Tinybird Local', async () => (await fetch(`${host}/tokens`)).ok);

  const form = new FormData();
  form.append('context://', new Blob(['1.0.0'], { type: 'text/plain' }), 'cli-version');
  const entries = await readdir(projectDir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile() || !DATAFILE_EXTENSIONS.has(extname(entry.name))) continue;
    const file = join(entry.parentPath, entry.name);
    const name = relative(projectDir, file).split('\\').join('/');
    form.append('data_project://', new Blob([await readFile(file)], { type: 'text/plain' }), name);
  }

  const result = await api('/v1/deploy?auto_promote=true', { method: 'POST', body: form });
  const deployment = result.deployment ?? {};
  if (deployment.errors?.length) throw new Error(`Deployment rejected: ${JSON.stringify(deployment.errors)}`);
  if (result.result === 'no_changes') {
    console.log('[Ingest] Tinybird project already deployed');
    return;
  }

  console.log(`[Ingest] Waiting for Tinybird deployment ${deployment.id}`);
  await untilReady(`deployment ${deployment.id}`, async () => {
    const { deployment: current } = await api(`/v1/deployments/${deployment.id}`);
    if (['deleting', 'deleted'].includes(current.status)) {
      const errors = JSON.stringify(current.errors ?? current);
      throw Object.assign(new Error(`Deployment failed: ${errors}`), { fatal: true });
    }
    return current.status === 'data_ready' && current.live;
  });
  console.log(`[Ingest] Tinybird deployment ${deployment.id} is live`);
}
