import * as THREE from 'three';
import {
  applyPoseDocument,
  createPoseDocument,
  SCENE_KIND,
  SCENE_DOCUMENT_VERSION,
  SceneCharacterDocument,
  SceneDocument,
  serializeAllControls,
  ShotDocument,
} from './documents.ts';
import { CameraPose } from './camera-bookmark.ts';
import { cloneLighting, defaultLighting, LightingSettings } from './lighting.ts';
import { findCharacterModel } from './models.ts';
import { PersistenceClient, createDocumentId, StoredDocumentSummary } from './persistence.ts';
import { PersistenceUI } from './persistence-ui.ts';
import { ControlView, PoseGraph } from './pose.ts';
import { CharacterScene } from './scene.ts';
import { ShotTray } from './shot-tray.ts';
import { AppState } from './state.ts';

interface PersistenceContext {
  scene: CharacterScene;
  state: AppState;
  camera: THREE.PerspectiveCamera;
  cameraTarget: THREE.Vector3;
  resolution(): { width: number; height: number };
  captureThumbnail(): string;
  /** Replace the scene's characters with saved ones (loads their models). */
  loadCharacters(characters: SceneCharacterDocument[]): Promise<void>;
  lighting(): LightingSettings;
  setLighting(lighting: LightingSettings): void;
  mainCamera(): CameraPose | null;
  setMainCamera(pose: CameraPose | null): void;
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
  updatedAt: string;
}

export class PersistenceController {
  private client = new PersistenceClient();
  private ui: PersistenceUI;
  private shotTray: ShotTray;
  private current: CurrentSession | null = null;
  private shots: ShotDocument[] = [];
  private activeShotId: string | null = null;
  private suppressAutosave = false;
  private dirty = false;
  private saveInFlight: Promise<void> | null = null;
  private saveTimer: number | null = null;
  private thumbnailVersions = new Map<string, string>();
  private operationTail: Promise<void> = Promise.resolve();
  private poseListToken = 0;

  constructor(private context: PersistenceContext) {
    this.ui = new PersistenceUI({
      savePose: (name) => this.enqueue(() => this.savePose(name)),
      loadPose: (id) => this.enqueue(() => this.loadPose(id)),
      createSession: (name) => this.enqueue(() => this.createSession(name, true)),
      loadSession: (id) => this.enqueue(() => this.loadSession(id)),
    });
    this.shotTray = new ShotTray({
      select: (id) => this.enqueue(() => this.selectShot(id)),
      add: () => this.enqueue(() => this.addShot()),
      duplicate: (id) => this.enqueue(() => this.duplicateShot(id)),
      delete: (id) => this.enqueue(() => this.deleteShot(id)),
      reorder: (orderedIds) => this.enqueue(() => this.reorderShots(orderedIds)),
    }, (cause) => this.ui.setStatus(cause instanceof Error ? cause.message : String(cause), true));
    this.ui.setScope(context.state.activeView);
    window.addEventListener('pagehide', () => this.flushOnPageHide());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden' || !this.dirty) return;
      if (this.saveTimer !== null) {
        window.clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
      void this.flushAutosave();
    });
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(action, action);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result;
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
    const previousDocument = previousSession ? this.captureSession() : null;
    const previousShotId = this.activeShotId;
    const previousShots = this.shots;
    const previousThumbnailVersions = this.thumbnailVersions;
    this.suppressAutosave = true;
    try {
      if (reset) await this.context.resetScene();
      const now = new Date().toISOString();
      this.current = { id: createDocumentId(name), name, createdAt: now, updatedAt: now };
      this.activeShotId = createDocumentId('shot');
      this.shots = [this.captureShot(this.activeShotId)];
      this.thumbnailVersions = new Map();
      await this.client.saveSession(this.captureSession(now, false));
      this.context.clearPoseHistory();
    } catch (cause) {
      this.current = previousSession;
      this.shots = previousDocument?.shots ?? previousShots;
      this.activeShotId = previousDocument?.activeShotId ?? previousShotId;
      this.thumbnailVersions = previousThumbnailVersions;
      if (previousDocument) {
        await this.applyShotState(this.activeShot());
      }
      throw cause;
    } finally {
      this.suppressAutosave = false;
    }
    await this.refreshSessions();
    await this.refreshPoses();
    this.ui.setCurrentSession(name);
    this.refreshShotTray();
    this.ui.setStatus(`Created session ${name}.`);
  }

  private async loadSession(id: string, existingList?: StoredDocumentSummary[]) {
    await this.flushBeforeSessionChange();
    const previousSession = this.current;
    const previousShots = this.shots;
    const previousShotId = this.activeShotId;
    const previousShot = previousShotId ? this.activeShot() : null;
    const previousThumbnailVersions = this.thumbnailVersions;
    const document = await this.client.loadSession(id);
    for (const shot of document.shots) {
      for (const character of shot.characters) {
        if (!findCharacterModel(character.model)) {
          throw new Error(`Session model "${character.model}" is not available in this build`);
        }
      }
    }

    this.suppressAutosave = true;
    try {
      this.current = {
        id: document.id,
        name: document.name,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      };
      this.shots = document.shots;
      this.activeShotId = document.activeShotId;
      this.thumbnailVersions = new Map(document.shots.map((shot) => [shot.id, document.updatedAt]));
      await this.applyShotState(this.activeShot());
      this.context.clearPoseHistory();
    } catch (cause) {
      this.current = previousSession;
      this.shots = previousShots;
      this.activeShotId = previousShotId;
      this.thumbnailVersions = previousThumbnailVersions;
      if (previousShot) await this.applyShotState(previousShot);
      throw cause;
    } finally {
      this.suppressAutosave = false;
    }
    if (document.migratedFromVersion) await this.saveSessionNow(false);

    const sessions = existingList ?? await this.client.listSessions();
    this.ui.setSessions(sessions, id);
    this.ui.setCurrentSession(document.name);
    this.ui.setScope(this.activeShot().activeView);
    this.refreshShotTray();
    await this.refreshPoses();
    this.ui.setStatus(`Loaded session ${document.name}.`);
  }

  private activeShot(): ShotDocument {
    const shot = this.shots.find((candidate) => candidate.id === this.activeShotId);
    if (!shot) throw new Error('No active shot');
    return shot;
  }

  private async selectShot(id: string) {
    if (id === this.activeShotId) return;
    await this.flushBeforeSessionChange();
    const previousId = this.activeShotId;
    const previousShot = this.activeShot();
    const target = this.shots.find((shot) => shot.id === id);
    if (!target) throw new Error('Shot not found');
    this.suppressAutosave = true;
    try {
      this.activeShotId = id;
      await this.applyShotState(target);
      this.context.clearPoseHistory();
    } catch (cause) {
      this.activeShotId = previousId;
      await this.applyShotState(previousShot);
      throw cause;
    } finally {
      this.suppressAutosave = false;
    }
    await this.saveSessionNow();
    this.ui.setScope(target.activeView);
    await this.refreshPoses();
    this.ui.setStatus('Selected shot.');
  }

  private async addShot() {
    await this.flushBeforeSessionChange();
    const previousId = this.activeShotId;
    const previousShot = this.activeShot();
    this.suppressAutosave = true;
    try {
      await this.context.resetScene();
      const id = createDocumentId('shot');
      this.activeShotId = id;
      this.shots.push(this.captureShot(id));
      this.context.clearPoseHistory();
    } catch (cause) {
      this.activeShotId = previousId;
      await this.applyShotState(previousShot);
      throw cause;
    } finally {
      this.suppressAutosave = false;
    }
    await this.saveSessionNow();
    this.ui.setStatus('Added shot.');
  }

  private async duplicateShot(id: string) {
    await this.flushBeforeSessionChange();
    const sourceIndex = this.shots.findIndex((shot) => shot.id === id);
    if (sourceIndex < 0) throw new Error('Shot not found');
    const previousId = this.activeShotId;
    const previousShot = this.activeShot();
    const duplicate = structuredClone(this.shots[sourceIndex]);
    duplicate.id = createDocumentId('shot');
    this.shots.splice(sourceIndex + 1, 0, duplicate);
    this.suppressAutosave = true;
    try {
      this.activeShotId = duplicate.id;
      await this.applyShotState(duplicate);
      this.context.clearPoseHistory();
    } catch (cause) {
      this.shots.splice(this.shots.indexOf(duplicate), 1);
      this.activeShotId = previousId;
      await this.applyShotState(previousShot);
      throw cause;
    } finally {
      this.suppressAutosave = false;
    }
    await this.saveSessionNow();
    this.ui.setStatus('Duplicated shot.');
  }

  private async deleteShot(id: string) {
    if (this.shots.length <= 1) throw new Error('A session must contain at least one shot');
    await this.flushBeforeSessionChange(false);
    const index = this.shots.findIndex((shot) => shot.id === id);
    if (index < 0) throw new Error('Shot not found');
    const deletingActive = id === this.activeShotId;
    const previousId = this.activeShotId;
    const previousShot = this.activeShot();
    const [removed] = this.shots.splice(index, 1);
    this.suppressAutosave = true;
    try {
      if (deletingActive) {
        const next = this.shots[Math.min(index, this.shots.length - 1)];
        this.activeShotId = next.id;
        await this.applyShotState(next);
        this.context.clearPoseHistory();
      }
    } catch (cause) {
      this.shots.splice(index, 0, removed);
      this.activeShotId = previousId;
      await this.applyShotState(previousShot);
      throw cause;
    } finally {
      this.suppressAutosave = false;
    }
    await this.saveSessionNow();
    this.thumbnailVersions.delete(id);
    this.refreshShotTray();
    try {
      await this.client.deleteShotThumbnail(this.current!.id, id);
      this.ui.setStatus('Deleted shot.');
    } catch (cause) {
      this.ui.setStatus(
        `Deleted shot, but thumbnail cleanup failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        true,
      );
    }
  }

  private async reorderShots(orderedIds: string[]) {
    if (
      orderedIds.length !== this.shots.length ||
      new Set(orderedIds).size !== this.shots.length
    ) {
      throw new Error('Reordered shots do not match the session');
    }
    const byId = new Map(this.shots.map((shot) => [shot.id, shot]));
    if (orderedIds.some((id) => !byId.has(id))) throw new Error('Reordered shots do not match the session');
    if (orderedIds.every((id, index) => id === this.shots[index].id)) return;
    await this.flushBeforeSessionChange(false);
    const previousShots = this.shots;
    this.shots = orderedIds.map((id) => byId.get(id)!);
    try {
      await this.saveSessionNow();
    } catch (cause) {
      this.shots = previousShots;
      this.refreshShotTray();
      throw cause;
    }
    this.ui.setStatus('Reordered shots.');
  }

  private async saveSessionNow(updateActive = false) {
    if (!this.current) throw new Error('No active session');
    if (this.saveInFlight) await this.saveInFlight;
    this.dirty = false;
    try {
      await this.client.saveSession(this.captureSession(undefined, updateActive));
    } catch (cause) {
      this.dirty = true;
      this.scheduleAutosaveRetry();
      throw cause;
    } finally {
      this.refreshShotTray();
    }
  }

  private refreshShotTray() {
    if (!this.activeShotId || !this.current) return;
    this.shotTray.setShots(
      this.shots.map((shot) => ({
        id: shot.id,
        thumbnail: this.client.shotThumbnailUrl(
          this.current!.id,
          shot.id,
          this.thumbnailVersions.get(shot.id) ?? this.current!.updatedAt,
        ),
      })),
      this.activeShotId,
    );
  }

  private async saveActiveThumbnail(expectedShotId: string | null) {
    if (!this.current || !expectedShotId || expectedShotId !== this.activeShotId) return;
    const thumbnail = this.context.captureThumbnail();
    await this.client.saveShotThumbnail(this.current.id, expectedShotId, thumbnail);
    this.thumbnailVersions.set(expectedShotId, Date.now().toString(36));
    this.refreshShotTray();
  }

  private async trySaveActiveThumbnail(expectedShotId: string | null): Promise<boolean> {
    try {
      await this.saveActiveThumbnail(expectedShotId);
      return true;
    } catch (cause) {
      this.ui.setStatus(
        `Thumbnail save failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        true,
      );
      return false;
    }
  }

  private scheduleAutosaveRetry() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flushAutosave();
    }, 1000);
  }

  private captureShot(id: string): ShotDocument {
    const resolution = this.context.resolution();
    const activeCharacterId = this.context.scene.active?.id;
    const mainCamera = this.context.mainCamera();
    return {
      id,
      characters: this.context.scene.characters.map((character) => ({
        id: character.id,
        model: character.model.url,
        controls: serializeAllControls(character.pose),
      })),
      ...(activeCharacterId ? { activeCharacterId } : {}),
      lighting: cloneLighting(this.context.lighting()),
      ...(mainCamera ? { mainCamera } : {}),
      cameras: [{
        id: 'free',
        position: this.context.camera.position.toArray(),
        target: this.context.cameraTarget.toArray(),
        fov: this.context.camera.fov,
        resolution,
      }],
      activeCameraId: 'free',
      activeView: this.context.state.activeView,
    };
  }

  private updateActiveShot() {
    if (!this.activeShotId) throw new Error('No active shot');
    const index = this.shots.findIndex((shot) => shot.id === this.activeShotId);
    if (index < 0) throw new Error('The active shot is missing');
    this.shots[index] = this.captureShot(this.activeShotId);
  }

  private captureSession(
    updatedAt = new Date().toISOString(),
    updateActive = true,
  ): SceneDocument {
    if (!this.current) throw new Error('No active session');
    if (updateActive) this.updateActiveShot();
    this.current.updatedAt = updatedAt;
    return {
      kind: SCENE_KIND,
      version: SCENE_DOCUMENT_VERSION,
      id: this.current.id,
      name: this.current.name,
      shots: this.shots,
      activeShotId: this.activeShotId!,
      createdAt: this.current.createdAt,
      updatedAt: this.current.updatedAt,
    };
  }

  private async flushBeforeSessionChange(captureThumbnail = true) {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.saveInFlight) await this.saveInFlight;
    for (let attempt = 0; this.dirty && attempt < 3; attempt++) {
      await this.flushAutosave();
    }
    if (this.dirty) throw new Error('The current session could not be saved; session change was cancelled');
    if (captureThumbnail) await this.trySaveActiveThumbnail(this.activeShotId);
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
        await this.client.saveSession(this.captureSession());
      }
      this.ui.setStatus(`Autosaved ${new Date().toLocaleTimeString()}.`);
    } catch (cause) {
      this.dirty = true;
      this.scheduleAutosaveRetry();
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

  private async applyShotState(shot: ShotDocument) {
    await this.context.loadCharacters(shot.characters);
    if (shot.activeCharacterId) this.context.state.setActiveCharacter(shot.activeCharacterId);
    this.context.setLighting(shot.lighting ?? defaultLighting());
    this.context.setMainCamera(shot.mainCamera ?? null);
    const camera = shot.cameras[0];
    this.context.camera.position.fromArray(camera.position);
    this.context.cameraTarget.fromArray(camera.target);
    this.context.camera.fov = camera.fov;
    this.context.camera.updateProjectionMatrix();
    this.context.camera.lookAt(this.context.cameraTarget);
    this.context.camera.updateMatrixWorld();
    this.context.state.setView(shot.activeView);
    this.context.applyPose();
  }

  private flushOnPageHide() {
    if (!this.dirty || !this.current || !this.activeShotId) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const updatedAt = new Date().toISOString();
    this.client.saveActiveShotOnUnload(
      this.current.id,
      this.activeShotId,
      this.captureShot(this.activeShotId),
      updatedAt,
    );
  }
}
