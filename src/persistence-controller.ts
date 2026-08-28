import * as THREE from 'three';
import {
  applyPoseDocument,
  applySceneControls,
  createPoseDocument,
  DOCUMENT_VERSION,
  SCENE_KIND,
  SceneDocument,
  serializeAllControls,
} from './documents.ts';
import { PersistenceClient, createDocumentId, StoredDocumentSummary } from './persistence.ts';
import { PersistenceUI } from './persistence-ui.ts';
import { ControlView, PoseGraph } from './pose.ts';
import { AppState } from './state.ts';

interface PersistenceContext {
  pose: PoseGraph;
  state: AppState;
  camera: THREE.PerspectiveCamera;
  cameraTarget: THREE.Vector3;
  model: string;
  resolution(): { width: number; height: number };
  applyPose(): void;
  resetScene(): void;
}

interface CurrentSession {
  id: string;
  name: string;
  createdAt: string;
}

export class PersistenceController {
  private client = new PersistenceClient();
  private ui: PersistenceUI;
  private current: CurrentSession | null = null;
  private suppressAutosave = false;
  private dirty = false;
  private saveInFlight: Promise<void> | null = null;
  private saveTimer: number | null = null;
  private poseListToken = 0;

  constructor(private context: PersistenceContext) {
    this.ui = new PersistenceUI({
      savePose: (name) => this.savePose(name),
      loadPose: (id) => this.loadPose(id),
      createSession: (name) => this.createSession(name, true),
      loadSession: (id) => this.loadSession(id),
    });
    this.ui.setScope(context.state.activeView);
    window.addEventListener('pagehide', () => this.flushOnPageHide());
  }

  async initialize() {
    await this.client.health();
    const sessions = await this.client.listSessions();
    this.ui.setSessions(sessions);
    const skipped: string[] = [];
    for (const candidate of sessions.filter((session) => !session.invalid)) {
      try {
        await this.loadSession(candidate.id, sessions);
        break;
      } catch (cause) {
        skipped.push(`${candidate.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    if (!this.current) {
      await this.createSession('Default Session', false);
    }
    if (sessions.some((session) => session.invalid) || skipped.length > 0) {
      const detail = skipped.length > 0 ? ` ${skipped.join(' | ')}` : '';
      this.ui.setStatus(`Invalid sessions were skipped.${detail}`, true);
    }
    await this.refreshPoses();
  }

  withoutAutosave(action: () => void) {
    const previous = this.suppressAutosave;
    this.suppressAutosave = true;
    try {
      action();
    } finally {
      this.suppressAutosave = previous;
    }
  }

  reportStatus(message: string) {
    this.ui.setStatus(message);
  }

  reportError(cause: unknown) {
    this.ui.setStatus(
      `Persistence unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      true,
    );
  }

  notifySceneChanged() {
    if (this.suppressAutosave || !this.current) return;
    this.dirty = true;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flushAutosave();
    }, 400);
  }

  notifyViewChanged(view: ControlView) {
    this.ui.setScope(view);
    void this.refreshPoses();
    this.notifySceneChanged();
  }

  private async savePose(name: string) {
    const id = createDocumentId(name);
    const document = createPoseDocument(id, name, this.context.state.activeView, this.context.pose);
    await this.client.savePose(document);
    await this.refreshPoses();
    this.ui.setStatus(`Saved ${name}.`);
  }

  private async loadPose(id: string) {
    const scope = this.context.state.activeView;
    const document = await this.client.loadPose(scope, id);
    this.suppressAutosave = true;
    try {
      applyPoseDocument(this.context.pose, document);
      this.context.applyPose();
    } finally {
      this.suppressAutosave = false;
    }
    this.notifySceneChanged();
    this.ui.setStatus(`Loaded ${document.name}.`);
  }

  private async createSession(name: string, reset: boolean) {
    await this.flushBeforeSessionChange();
    const previousSession = this.current;
    const previousScene = previousSession ? this.captureScene() : null;
    this.suppressAutosave = true;
    try {
      if (reset) this.context.resetScene();
      const now = new Date().toISOString();
      this.current = { id: createDocumentId(name), name, createdAt: now };
      await this.client.saveSession(this.captureScene(now));
    } catch (cause) {
      this.current = previousSession;
      if (previousScene) this.applySceneState(previousScene);
      throw cause;
    } finally {
      this.suppressAutosave = false;
    }
    await this.refreshSessions();
    await this.refreshPoses();
    this.ui.setCurrentSession(name);
    this.ui.setStatus(`Created session ${name}.`);
  }

  private async loadSession(id: string, existingList?: StoredDocumentSummary[]) {
    await this.flushBeforeSessionChange();
    const document = await this.client.loadSession(id);
    if (document.characters[0].model !== this.context.model) {
      throw new Error(`Session model "${document.characters[0].model}" is not available in this build`);
    }

    this.suppressAutosave = true;
    try {
      this.applySceneState(document);
      this.current = { id: document.id, name: document.name, createdAt: document.createdAt };
    } finally {
      this.suppressAutosave = false;
    }

    const sessions = existingList ?? await this.client.listSessions();
    this.ui.setSessions(sessions, id);
    this.ui.setCurrentSession(document.name);
    this.ui.setScope(document.activeView);
    await this.refreshPoses();
    this.ui.setStatus(`Loaded session ${document.name}.`);
  }

  private captureScene(updatedAt = new Date().toISOString()): SceneDocument {
    if (!this.current) throw new Error('No active session');
    const resolution = this.context.resolution();
    return {
      kind: SCENE_KIND,
      version: DOCUMENT_VERSION,
      id: this.current.id,
      name: this.current.name,
      characters: [{
        id: 'character-1',
        model: this.context.model,
        controls: serializeAllControls(this.context.pose),
      }],
      cameras: [{
        id: 'free',
        position: this.context.camera.position.toArray(),
        target: this.context.cameraTarget.toArray(),
        fov: this.context.camera.fov,
        resolution,
      }],
      activeCameraId: 'free',
      activeView: this.context.state.activeView,
      createdAt: this.current.createdAt,
      updatedAt,
    };
  }

  private async flushBeforeSessionChange() {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    for (let attempt = 0; this.dirty && attempt < 3; attempt++) {
      await this.flushAutosave();
    }
    if (this.dirty) throw new Error('The current session could not be saved; session change was cancelled');
  }

  private flushAutosave(): Promise<void> {
    if (this.saveInFlight) return this.saveInFlight;
    if (!this.dirty || !this.current) return Promise.resolve();
    this.saveInFlight = this.performAutosave().finally(() => {
      this.saveInFlight = null;
    });
    return this.saveInFlight;
  }

  private async performAutosave() {
    try {
      while (this.dirty && this.current) {
        this.dirty = false;
        await this.client.saveSession(this.captureScene());
      }
      this.ui.setStatus(`Autosaved ${new Date().toLocaleTimeString()}.`);
    } catch (cause) {
      this.dirty = true;
      this.ui.setStatus(`Autosave failed: ${cause instanceof Error ? cause.message : String(cause)}`, true);
    }
  }

  private async refreshPoses() {
    const scope = this.context.state.activeView;
    const token = ++this.poseListToken;
    const poses = await this.client.listPoses(scope);
    if (token === this.poseListToken && scope === this.context.state.activeView) {
      this.ui.setPoses(poses);
    }
  }

  private async refreshSessions() {
    const sessions = await this.client.listSessions();
    this.ui.setSessions(sessions, this.current?.id);
  }

  private applySceneState(document: SceneDocument) {
    applySceneControls(this.context.pose, document.characters[0].controls);
    const camera = document.cameras[0];
    this.context.camera.position.fromArray(camera.position);
    this.context.cameraTarget.fromArray(camera.target);
    this.context.camera.fov = camera.fov;
    this.context.camera.updateProjectionMatrix();
    this.context.camera.lookAt(this.context.cameraTarget);
    this.context.camera.updateMatrixWorld();
    this.context.state.setView(document.activeView);
    this.context.applyPose();
  }

  private flushOnPageHide() {
    if (!this.dirty || !this.current) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.dirty = false;
    this.client.saveSessionOnUnload(this.captureScene());
  }
}
