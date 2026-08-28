import { ControlView } from './pose.ts';
import { parsePoseDocument, parseSceneDocument, PoseDocument, SceneDocument } from './documents.ts';

export interface StoredDocumentSummary {
  id: string;
  name: string;
  scope?: ControlView;
  updatedAt: string;
  invalid: boolean;
  error?: string;
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
      ? value.error
      : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return value;
}

function parseSummaryList(value: unknown): StoredDocumentSummary[] {
  if (!Array.isArray(value)) throw new Error('Server returned an invalid document list');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Document list item ${index} is invalid`);
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.name !== 'string' || typeof record.updatedAt !== 'string') {
      throw new Error(`Document list item ${index} is missing required fields`);
    }
    const scope = typeof record.scope === 'string' ? record.scope as ControlView : undefined;
    return {
      id: record.id,
      name: record.name,
      scope,
      updatedAt: record.updatedAt,
      invalid: record.invalid === true,
      error: typeof record.error === 'string' ? record.error : undefined,
    };
  });
}

function jsonRequest(value: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  };
}

export class PersistenceClient {
  async health() {
    const value = await requestJson('/api/health');
    if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== true) {
      throw new Error('Start Character Poser with Launch.bat or npm run dev to enable file persistence');
    }
  }

  async listPoses(scope: ControlView): Promise<StoredDocumentSummary[]> {
    return parseSummaryList(await requestJson(`/api/poses?scope=${encodeURIComponent(scope)}`));
  }

  async loadPose(scope: ControlView, id: string): Promise<PoseDocument> {
    return parsePoseDocument(await requestJson(`/api/poses/${encodeURIComponent(scope)}/${encodeURIComponent(id)}`));
  }

  async savePose(document: PoseDocument): Promise<void> {
    await requestJson(
      `/api/poses/${encodeURIComponent(document.scope)}/${encodeURIComponent(document.id)}`,
      jsonRequest(document),
    );
  }

  async listSessions(): Promise<StoredDocumentSummary[]> {
    return parseSummaryList(await requestJson('/api/sessions'));
  }

  async loadSession(id: string): Promise<SceneDocument> {
    return parseSceneDocument(await requestJson(`/api/sessions/${encodeURIComponent(id)}`));
  }

  async saveSession(document: SceneDocument): Promise<void> {
    await requestJson(`/api/sessions/${encodeURIComponent(document.id)}`, jsonRequest(document));
  }

  saveSessionOnUnload(document: SceneDocument) {
    void fetch(`/api/sessions/${encodeURIComponent(document.id)}`, {
      ...jsonRequest(document),
      keepalive: true,
    });
  }
}

export function createDocumentId(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  return `${slug || 'untitled'}-${Date.now().toString(36)}`;
}
