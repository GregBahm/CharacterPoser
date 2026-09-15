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
const thumbnailRoot = path.join(dataRoot, 'shot-thumbnails');
const referenceImageRoot = path.join(dataRoot, 'reference-images');
const host = '127.0.0.1';
const port = Number(process.env.PORT ?? 5173);
// Storyboards can contain many complete scene snapshots.
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 200 * 1024;
const MAX_REFERENCE_IMAGE_BYTES = 25 * 1024 * 1024;
const REFERENCE_IMAGE_TYPES = new Map([
  ['image/jpeg', { extension: 'jpg', signature: (body) => body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff }],
  ['image/png', { extension: 'png', signature: (body) => body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }],
  ['image/gif', { extension: 'gif', signature: (body) => body.length >= 6 && ['GIF87a', 'GIF89a'].includes(body.subarray(0, 6).toString('ascii')) }],
  ['image/webp', { extension: 'webp', signature: (body) => body.length >= 12 && body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP' }],
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const POSE_SCOPES = new Set(['body', 'leftHand', 'rightHand', 'face']);
const allowedHosts = new Set([`${host}:${port}`, `localhost:${port}`]);

await Promise.all([
  ...[...POSE_SCOPES].map((scope) => mkdir(path.join(poseRoot, scope), { recursive: true })),
  mkdir(sessionRoot, { recursive: true }),
  mkdir(thumbnailRoot, { recursive: true }),
  mkdir(referenceImageRoot, { recursive: true }),
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

async function readBinaryBody(request, maxBytes) {
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (declaredLength > maxBytes) {
    const error = new Error(`Request body exceeds ${maxBytes} bytes`);
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) {
      const error = new Error(`Request body exceeds ${maxBytes} bytes`);
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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

async function writeBinaryAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, value, { flag: 'wx' });
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

  const activeShotMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/active-shot$/);
  if (activeShotMatch) {
    if (request.method !== 'PUT') {
      sendJson(response, 405, { error: 'Method not allowed' });
      return true;
    }
    const id = requireId(decodePathSegment(activeShotMatch[1]), 'session id');
    const filePath = path.join(sessionRoot, `${id}.json`);
    const update = await readJsonBody(request);
    const document = await readStoredJson(filePath);
    if (
      document.kind !== 'character-poser-scene' ||
      document.version !== 2 ||
      !Array.isArray(document.shots) ||
      !update.shot ||
      typeof update.shot !== 'object' ||
      typeof update.activeShotId !== 'string' ||
      update.shot.id !== update.activeShotId ||
      !Array.isArray(update.shot.characters) ||
      !Array.isArray(update.shot.cameras) ||
      update.shot.cameras.length !== 1 ||
      typeof update.shot.activeCameraId !== 'string' ||
      !POSE_SCOPES.has(update.shot.activeView)
    ) {
      const error = new Error('Active-shot update does not match a version 2 session');
      error.status = 400;
      throw error;
    }
    const index = document.shots.findIndex((shot) => shot && shot.id === update.activeShotId);
    if (index < 0) {
      const error = new Error('Active shot was not found in the session');
      error.status = 404;
      throw error;
    }
    document.shots[index] = update.shot;
    document.activeShotId = update.activeShotId;
    if (typeof update.updatedAt === 'string') document.updatedAt = update.updatedAt;
    await writeJsonAtomic(filePath, document);
    sendJson(response, 200, { ok: true });
    return true;
  }

  const thumbnailMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/shots\/([^/]+)\/thumbnail$/);
  if (thumbnailMatch) {
    const sessionId = requireId(decodePathSegment(thumbnailMatch[1]), 'session id');
    const shotId = requireId(decodePathSegment(thumbnailMatch[2]), 'shot id');
    const directory = path.join(thumbnailRoot, sessionId);
    const filePath = path.join(directory, `${shotId}.jpg`);
    if (request.method === 'GET') {
      try {
        const body = await readFile(filePath);
        response.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': body.length,
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        response.end(body);
      } catch (cause) {
        if (cause && typeof cause === 'object' && cause.code === 'ENOENT') {
          sendJson(response, 404, { error: 'Shot thumbnail not found' });
        } else {
          throw cause;
        }
      }
      return true;
    }
    if (request.method === 'PUT') {
      if (request.headers['content-type'] !== 'image/jpeg') {
        const error = new Error('Shot thumbnail must be image/jpeg');
        error.status = 415;
        throw error;
      }
      const body = await readBinaryBody(request, MAX_THUMBNAIL_BYTES);
      if (body.length < 3 || body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) {
        const error = new Error('Shot thumbnail is not a JPEG');
        error.status = 400;
        throw error;
      }
      await mkdir(directory, { recursive: true });
      await writeBinaryAtomic(filePath, body);
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (request.method === 'DELETE') {
      await rm(filePath, { force: true });
      sendJson(response, 200, { ok: true });
      return true;
    }
    sendJson(response, 405, { error: 'Method not allowed' });
    return true;
  }

  const referenceImageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/shots\/([^/]+)\/reference-image$/);
  if (referenceImageMatch) {
    const sessionId = requireId(decodePathSegment(referenceImageMatch[1]), 'session id');
    const shotId = requireId(decodePathSegment(referenceImageMatch[2]), 'shot id');
    const directory = path.join(referenceImageRoot, sessionId);
    const candidates = [...REFERENCE_IMAGE_TYPES.entries()].map(([mediaType, { extension }]) => ({
      mediaType,
      filePath: path.join(directory, `${shotId}.${extension}`),
    }));
    if (request.method === 'GET') {
      for (const candidate of candidates) {
        try {
          const body = await readFile(candidate.filePath);
          response.writeHead(200, {
            'Content-Type': candidate.mediaType,
            'Content-Length': body.length,
            'Cache-Control': 'public, max-age=31536000, immutable',
          });
          response.end(body);
          return true;
        } catch (cause) {
          if (!cause || typeof cause !== 'object' || cause.code !== 'ENOENT') throw cause;
        }
      }
      sendJson(response, 404, { error: 'Shot reference image not found' });
      return true;
    }
    if (request.method === 'PUT') {
      const mediaType = (request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
      const imageType = REFERENCE_IMAGE_TYPES.get(mediaType);
      if (!imageType) {
        const error = new Error('Reference image must be JPEG, PNG, GIF, or WebP');
        error.status = 415;
        throw error;
      }
      const body = await readBinaryBody(request, MAX_REFERENCE_IMAGE_BYTES);
      if (!imageType.signature(body)) {
        const error = new Error(`Reference image does not contain valid ${mediaType} data`);
        error.status = 400;
        throw error;
      }
      await mkdir(directory, { recursive: true });
      const filePath = path.join(directory, `${shotId}.${imageType.extension}`);
      await writeBinaryAtomic(filePath, body);
      await Promise.all(candidates
        .filter((candidate) => candidate.filePath !== filePath)
        .map((candidate) => rm(candidate.filePath, { force: true })));
      sendJson(response, 200, { ok: true });
      return true;
    }
    if (request.method === 'DELETE') {
      await Promise.all(candidates.map((candidate) => rm(candidate.filePath, { force: true })));
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
