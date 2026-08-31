import * as THREE from 'three';

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

/** Below this the camera counts as sitting exactly on the main view. */
const EPSILON = 1e-4;
/** How long Clear must be held. */
const HOLD_MS = 500;

/**
 * The "main" view: a bookmarked camera position/target/FOV that the free
 * camera can wander away from and snap back to. Saved with the scene.
 */
export class CameraBookmark {
  main: CameraPose | null = null;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private cameraTarget: THREE.Vector3,
    private onChange: () => void,
  ) {}

  /** Remember the current camera as the main view. */
  set() {
    this.main = this.current();
    this.onChange();
  }

  clear() {
    if (!this.main) return;
    this.main = null;
    this.onChange();
  }

  /** Adopt a saved main view (or none) without treating it as an edit. */
  load(pose: CameraPose | null) {
    this.main = pose ? { position: [...pose.position], target: [...pose.target], fov: pose.fov } : null;
  }

  /** Snap the camera back to the main view. */
  restore() {
    if (!this.main) return;
    this.camera.position.fromArray(this.main.position);
    this.cameraTarget.fromArray(this.main.target);
    this.camera.fov = this.main.fov;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.cameraTarget);
    this.camera.updateMatrixWorld();
    this.onChange();
  }

  isAtMain(): boolean {
    const main = this.main;
    if (!main) return false;
    return this.camera.position.distanceToSquared(new THREE.Vector3().fromArray(main.position)) < EPSILON * EPSILON
      && this.cameraTarget.distanceToSquared(new THREE.Vector3().fromArray(main.target)) < EPSILON * EPSILON
      && Math.abs(this.camera.fov - main.fov) < EPSILON;
  }

  private current(): CameraPose {
    return {
      position: this.camera.position.toArray() as [number, number, number],
      target: this.cameraTarget.toArray() as [number, number, number],
      fov: this.camera.fov,
    };
  }
}

/**
 * The Camera section at the bottom of the Controls tab: "Set as Main" turns
 * into "Set to Main" (enabled only once the camera has moved off it), and a
 * hold-to-confirm Clear with a fill bar forgets the main view.
 */
export class CameraPanel {
  private mainButton = document.getElementById('btn-main-camera') as HTMLButtonElement;
  private clearButton = document.getElementById('btn-clear-main') as HTMLButtonElement;
  private progress = this.clearButton.querySelector('.hold-progress') as HTMLElement;
  /** Dotted outline around the viewport while the camera is away from the main view. */
  private viewFrame = document.getElementById('main-view-frame') as HTMLElement;
  private holdStart: number | null = null;

  constructor(private bookmark: CameraBookmark) {
    this.mainButton.addEventListener('click', () => {
      if (bookmark.main) bookmark.restore();
      else bookmark.set();
      this.update();
    });
    this.clearButton.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.holdStart = performance.now();
      try {
        this.clearButton.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic or already-released pointer */
      }
    });
    const release = (e: PointerEvent) => {
      if (this.holdStart === null) return;
      const held = performance.now() - this.holdStart >= HOLD_MS;
      this.holdStart = null;
      this.setProgress(0);
      if (this.clearButton.hasPointerCapture(e.pointerId)) this.clearButton.releasePointerCapture(e.pointerId);
      if (held && e.type === 'pointerup') bookmark.clear();
      this.update();
    };
    this.clearButton.addEventListener('pointerup', release);
    this.clearButton.addEventListener('pointercancel', release);
    this.update();
  }

  /** Called every frame: tracks the camera against the main view and fills the hold bar. */
  update() {
    const main = this.bookmark.main;
    const atMain = main !== null && this.bookmark.isAtMain();
    this.mainButton.textContent = main ? 'Set to Main' : 'Set as Main';
    this.mainButton.disabled = atMain;
    this.clearButton.hidden = main === null;
    this.viewFrame.hidden = main === null || atMain;
    if (this.holdStart !== null) {
      this.setProgress(Math.min(1, (performance.now() - this.holdStart) / HOLD_MS));
    }
  }

  private setProgress(fraction: number) {
    this.progress.style.width = `${Math.round(fraction * 100)}%`;
    this.clearButton.classList.toggle('armed', fraction >= 1);
  }
}
