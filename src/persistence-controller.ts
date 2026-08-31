import * as THREE from 'three';
import {
  applyPoseDocument,
  createPoseDocument,
  DOCUMENT_VERSION,
  SCENE_KIND,
  SceneCharacterDocument,
  SceneDocument,
  serializeAllControls,
} from './documents.ts';
import { cloneLighting, defaultLighting, LightingSettings } from './lighting.ts';
import { findCharacterModel } from './models.ts';
import { PersistenceClient, createDocumentId, StoredDocumentSummary } from './persistence.ts';
import { PersistenceUI } from './persistence-ui.ts';
import { ControlView, PoseGraph } from './pose.ts';
import { CharacterScene } from './scene.ts';
import { AppState } from './state.ts';

interface PersistenceContext {
  scene: CharacterScene;
  state: AppState;
  camera: THREE.PerspectiveCamera;
  cameraTarget: THREE.Vector3;
  resolution(): { width: number; height: number };
  /** Replace the scene's characters with saved ones (loads their models). */
  loadCharacters(characters: SceneCharacterDocument[]): Promise<void>;
  lighting(): LightingSettings;
  setLighting(lighting: LightingSettings): void;
  applyPose(): void;
  applyPoseEdit(edit: () => void): void;
  clearPoseHistory(): void;
  /** Start over: the default character in its base pose, camera reset. */
  resetScene(): Promise<void>;
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
      await this.createSession('Default Session', true);
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

  /** The pose library works on the active character. */
  private activePose(): PoseGraph {
    const character = this.context.scene.active;
    if (!character) throw new Error('Select a character first');
    return character.pose;
  }

  private async savePose(name: string) {
    const pose = this.activePose();
    const id = createDocumentId(name);
    const document = createPoseDocument(id, name, this.context.state.activeView, pose);
    await this.client.savePose(document);
    await this.refreshPoses();
    this.ui.setStatus(`Saved ${name}.`);
  }

  private async loadPose(id: string) {
    const pose = this.activePose();
    const scope = this.context.state.activeView;
    const document = await this.client.loadPose(scope, id);
    this.suppressAutosave = true;
    try {
      this.context.applyPoseEdit(() => applyPoseDocument(pose, document));
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
      if (reset) await this.context.resetScene();
      const now = new Date().toISOString();
      this.current = { id: createDocumentId(name), name, createdAt: now };
      await this.client.saveSession(this.captureScene(now));
      this.context.clearPoseHistory();
    } catch (cause) {
      this.current = previousSession;
      if (previousScene) await this.applySceneState(previousScene);
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
    for (const character of document.characters) {
      if (!findCharacterModel(character.model)) {
        throw new Error(`Session model "${character.model}" is not available in this build`);
      }
    }

    this.suppressAutosave = true;
    try {
      await this.applySceneState(document);
      this.current = { id: document.id, name: document.name, createdAt: document.createdAt };
      this.context.clearPoseHistory();
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
    const activeCharacterId = this.context.scene.active?.id;
    return {
      kind: SCENE_KIND,
      version: DOCUMENT_VERSION,
      id: this.current.id,
      name: this.current.name,
      characters: this.context.scene.characters.map((character) => ({
        id: character.id,
        model: character.model.url,
        controls: serializeAllControls(character.pose),
      })),
      ...(activeCharacterId ? { activeCharacterId } : {}),
      lighting: cloneLighting(this.context.lighting()),
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

  private async applySceneState(document: SceneDocument) {
    await this.context.loadCharacters(document.characters);
    if (document.activeCharacterId) this.context.state.setActiveCharacter(document.activeCharacterId);
    this.context.setLighting(document.lighting ?? defaultLighting());
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
