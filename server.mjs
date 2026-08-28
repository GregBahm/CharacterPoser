import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.resolve(process.env.CHARACTER_POSER_DATA_DIR ?? path.join(root, 'data'));
const poseRoot = path.join(dataRoot, 'poses');
const sessionRoot = path.join(dataRoot, 'sessions');
const host = '127.0.0.1';
const port = Number(process.env.PORT ?? 5173);
const MAX_BODY_BYTES = 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const POSE_SCOPES = new Set(['body', 'leftHand', 'rightHand', 'face']);
const allowedHosts = new Set([`${host}:${port}`, `localhost:${port}`]);

await Promise.all([
  ...[...POSE_SCOPES].map((scope) => mkdir(path.join(poseRoot, scope), { recursive: true })),
  mkdir(sessionRoot, { recursive: true }),
]);

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function requireId(value, label) {
  if (!value || !ID_PATTERN.test(value)) {
    const error = new Error(`${label} must match ${ID_PATTERN}`);
    error.status = 400;
    throw error;
  }
  return value;
}

function requireScope(value) {
  if (!value || !POSE_SCOPES.has(value)) {
    const error = new Error('scope must be body, leftHand, rightHand, or face');
    error.status = 400;
    throw error;
  }
  return value;
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    const error = new Error('Path contains invalid URL encoding');
    error.status = 400;
    throw error;
  }
}

async function readJsonBody(request) {
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    const error = new Error('Request body exceeds 1 MiB');
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) {
      const error = new Error('Request body exceeds 1 MiB');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    const error = new Error('Request body must be a JSON object');
    error.status = 400;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporaryPath, filePath);
        break;
      } catch (cause) {
        const retryable = cause && typeof cause === 'object' &&
          (cause.code === 'EPERM' || cause.code === 'EBUSY' || cause.code === 'EACCES');
        if (!retryable || attempt === 2) throw cause;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readStoredJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (cause) {
    if (cause && typeof cause === 'object' && cause.code === 'ENOENT') {
      const error = new Error('Document not found');
      error.status = 404;
      throw error;
    }
    throw new Error(`Stored document is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

async function listDocuments(directory, kind) {
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  const entries = await Promise.all(files.map(async (entry) => {
    const id = entry.name.slice(0, -5);
    const filePath = path.join(directory, entry.name);
    const fileStat = await stat(filePath);
    try {
      const value = JSON.parse(await readFile(filePath, 'utf8'));
      if (!value || typeof value !== 'object' || value.kind !== kind) {
        throw new Error(`Expected kind "${kind}"`);
      }
      return {
        id,
        name: typeof value.name === 'string' ? value.name : id,
        scope: typeof value.scope === 'string' ? value.scope : undefined,
        updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : fileStat.mtime.toISOString(),
        invalid: false,
      };
    } catch (cause) {
      return {
        id,
        name: id,
        updatedAt: fileStat.mtime.toISOString(),
        invalid: true,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }));
  return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function handleApi(request, response, url) {
  if (!url.pathname.startsWith('/api/')) return false;
  if (!allowedHosts.has((request.headers.host ?? '').toLowerCase())) {
    sendJson(response, 403, { error: 'Host is not allowed' });
    return true;
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true });
    return true;
  }

  if (url.pathname === '/api/poses') {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Method not allowed' });
      return true;
    }
    const scope = requireScope(url.searchParams.get('scope'));
    sendJson(response, 200, await listDocuments(path.join(poseRoot, scope), 'character-poser-pose'));
    return true;
  }

  const poseMatch = url.pathname.match(/^\/api\/poses\/([^/]+)\/([^/]+)$/);
  if (poseMatch) {
    const scope = requireScope(decodePathSegment(poseMatch[1]));
    const id = requireId(decodePathSegment(poseMatch[2]), 'pose id');
    const filePath = path.join(poseRoot, scope, `${id}.json`);
    if (request.method === 'GET') {
      sendJson(response, 200, await readStoredJson(filePath));
      return true;
    }
    if (request.method === 'PUT') {
      const value = await readJsonBody(request);
      if (value.kind !== 'character-poser-pose' || value.id !== id || value.scope !== scope) {
        const error = new Error('Pose kind, id, and scope must match the request path');
        error.status = 400;
        throw error;
      }
      await writeJsonAtomic(filePath, value);
      sendJson(response, 200, { ok: true });
      return true;
    }
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }

  if (url.pathname === '/api/sessions') {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Method not allowed' });
      return true;
    }
    sendJson(response, 200, await listDocuments(sessionRoot, 'character-poser-scene'));
    return true;
  }

  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const id = requireId(decodePathSegment(sessionMatch[1]), 'session id');
    const filePath = path.join(sessionRoot, `${id}.json`);
    if (request.method === 'GET') {
      sendJson(response, 200, await readStoredJson(filePath));
      return true;
    }
    if (request.method === 'PUT') {
      const value = await readJsonBody(request);
      if (value.kind !== 'character-poser-scene' || value.id !== id) {
        const error = new Error('Scene kind and id must match the request path');
        error.status = 400;
        throw error;
      }
      await writeJsonAtomic(filePath, value);
      sendJson(response, 200, { ok: true });
      return true;
    }
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }

  sendJson(response, 404, { error: 'API route not found' });
  return true;
}

let vite;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`);
    if (await handleApi(request, response, url)) return;
    vite.middlewares(request, response, (error) => {
      if (error) {
        console.error(error);
        if (!response.headersSent) sendJson(response, 500, { error: 'Vite middleware failed' });
      }
    });
  } catch (cause) {
    const status = cause && typeof cause === 'object' && typeof cause.status === 'number' ? cause.status : 500;
    const message = cause instanceof Error ? cause.message : String(cause);
    if (status >= 500) console.error(cause);
    if (!response.headersSent) sendJson(response, status, { error: message });
  }
});

vite = await createViteServer({
  root,
  appType: 'spa',
  server: {
    middlewareMode: true,
    hmr: { server },
  },
});

server.listen(port, host, () => {
  console.log(`Character Poser: http://${host}:${port}`);
  console.log(`Data directory: ${dataRoot}`);
});

async function shutdown() {
  await vite.close();
  server.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
