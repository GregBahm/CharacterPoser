import * as THREE from 'three';
import { WebGLPathTracer } from 'three-gpu-pathtracer';

export type RenderMode = 'untextured' | 'textured' | 'pathtraced';
export const RENDER_MODES: RenderMode[] = ['untextured', 'textured', 'pathtraced'];

/** Neutral clay color for textured models in the untextured mode. */
const CLAY_COLOR = 0xb8bdc7;

const STORAGE_KEY = 'characterPoser.renderMode';
/** Quiet time after the last pose/camera change before path tracing resumes. */
const SETTLE_MS = 150;

interface MaterialSet {
  untextured: THREE.Material;
  textured: THREE.Material;
  pathtraced: THREE.Material;
}

/**
 * Owns how the scene is drawn: Lambert shading in clay or with the models'
 * textures, or a progressive GPU path trace (three-gpu-pathtracer). The path tracer
 * accumulates samples while the scene is still; any pose or camera change
 * drops back to a rasterized frame and, once the change settles, the tracer
 * rebuilds (geometry) or re-aims (camera) and starts converging again.
 *
 * Overlay objects (control points, widgets) live in `overlay` and are drawn
 * on top of every mode, never path traced.
 */
export class SceneRenderer {
  mode: RenderMode;
  overlay = new THREE.Scene();

  private pathTracer: WebGLPathTracer | null = null;
  private materialSets = new Map<THREE.Mesh, MaterialSet>();
  private environment: THREE.Texture | null = null;

  private geometryDirty = true;
  private cameraDirty = true;
  private lastChange = 0;
  private lastCameraWorld = new THREE.Matrix4();
  private lastCameraProj = new THREE.Matrix4();
  private listeners: (() => void)[] = [];

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private opts: {
      /** Meshes under these roots get per-mode materials. */
      shaded: THREE.Object3D[];
      /** Raster-only helpers hidden while path tracing (e.g. the grid). */
      rasterOnly: THREE.Object3D[];
      /** Raster-only lights the path tracer can't use (hemisphere fill). */
      rasterLights: THREE.Light[];
      /** Element that shows the path tracer's progress; may be null. */
      status?: HTMLElement | null;
    },
  ) {
    for (const root of opts.shaded) this.trackMeshes(root);
    this.mode = loadStoredMode() ?? 'textured';
    this.applyMode();
  }

  /** Draw the meshes under `root` with per-mode materials (e.g. a newly loaded character). */
  addShaded(root: THREE.Object3D) {
    for (const mesh of this.trackMeshes(root)) mesh.material = this.materialSets.get(mesh)![this.mode];
    this.markGeometryChanged();
  }

  /** Stop managing the meshes under `root` and release the materials made for them. */
  removeShaded(root: THREE.Object3D) {
    root.traverse((obj) => {
      const set = this.materialSets.get(obj as THREE.Mesh);
      if (!set) return;
      set.untextured.dispose();
      set.textured.dispose();
      this.materialSets.delete(obj as THREE.Mesh);
    });
    this.markGeometryChanged();
  }

  private trackMeshes(root: THREE.Object3D): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      this.materialSets.set(mesh, buildMaterialSet(mesh.material as THREE.Material));
      meshes.push(mesh);
    });
    return meshes;
  }

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  setMode(mode: RenderMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* private mode etc. */
    }
    this.applyMode();
    for (const fn of this.listeners) fn();
  }

  /** Call whenever posed geometry changes (pose edits, undo, loads). */
  markGeometryChanged() {
    this.geometryDirty = true;
    this.lastChange = performance.now();
  }

  /** Draw one frame in the current mode, then the overlay on top. */
  render() {
    this.detectCameraChange();

    if (this.mode === 'pathtraced') {
      this.renderPathTraced();
    } else {
      this.renderer.autoClear = true;
      this.renderer.render(this.scene, this.camera);
    }

    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.overlay, this.camera);
    this.renderer.autoClear = true;
  }

  private detectCameraChange() {
    this.camera.updateMatrixWorld();
    if (
      !this.lastCameraWorld.equals(this.camera.matrixWorld) ||
      !this.lastCameraProj.equals(this.camera.projectionMatrix)
    ) {
      this.lastCameraWorld.copy(this.camera.matrixWorld);
      this.lastCameraProj.copy(this.camera.projectionMatrix);
      this.cameraDirty = true;
      this.lastChange = performance.now();
    }
  }

  private renderPathTraced() {
    const tracer = this.ensurePathTracer();
    const settled = performance.now() - this.lastChange >= SETTLE_MS;

    if ((this.geometryDirty || this.cameraDirty) && !settled) {
      // Mid-gesture: plain raster so dragging stays fluid.
      this.renderer.autoClear = true;
      this.renderer.render(this.scene, this.camera);
      this.setStatus('Path tracing paused…');
      return;
    }
    if (this.geometryDirty) {
      tracer.setScene(this.scene, this.camera);
      this.geometryDirty = false;
      this.cameraDirty = false;
    } else if (this.cameraDirty) {
      tracer.updateCamera();
      this.cameraDirty = false;
    }

    tracer.renderSample();
    this.setStatus(`Path tracing: ${tracer.samples.toFixed(0)} samples`);
  }

  private ensurePathTracer(): WebGLPathTracer {
    if (this.pathTracer) return this.pathTracer;
    const tracer = new WebGLPathTracer(this.renderer);
    tracer.bounces = 4;
    tracer.minSamples = 1;
    // Half-resolution trace buffer keeps per-sample cost interactive; the
    // canvas upsamples it. Raise toward 1 for a crisper (slower) converge.
    tracer.renderScale = 0.5;
    tracer.renderDelay = 0;
    tracer.fadeDuration = 250;
    tracer.dynamicLowRes = true;
    tracer.lowResScale = 0.25;
    tracer.tiles.set(2, 2);
    this.pathTracer = tracer;
    return tracer;
  }

  private applyMode() {
    const mode = this.mode;
    for (const [mesh, set] of this.materialSets) mesh.material = set[mode];

    for (const obj of this.opts.rasterOnly) obj.visible = mode !== 'pathtraced';

    // Soft sky/ground environment stands in for the hemisphere fill light,
    // which the path tracer cannot sample.
    if (mode === 'pathtraced') {
      this.environment ??= makeGradientEnvironment();
      this.scene.environment = this.environment;
      this.scene.environmentIntensity = 0.9;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.0;
      this.geometryDirty = true;
      this.lastChange = 0;
    } else {
      this.scene.environment = null;
      this.renderer.toneMapping = THREE.NoToneMapping;
      this.setStatus('');
    }
    // Tone mapping is compiled into shaders; force a recompile of all variants.
    for (const set of this.materialSets.values()) {
      for (const m of Object.values(set)) m.needsUpdate = true;
    }
  }

  private setStatus(text: string) {
    const el = this.opts.status;
    if (!el || el.textContent === text) return;
    el.textContent = text;
    el.hidden = text === '';
  }
}

/**
 * Lambert variants of the source material — clay without its texture, or
 * with it — plus the Standard source itself for path tracing.
 */
function buildMaterialSet(source: THREE.Material): MaterialSet {
  const std = source as THREE.MeshStandardMaterial;
  const color = std.color?.clone() ?? new THREE.Color(CLAY_COLOR);
  const map = std.map ?? null;
  const pathtraced = std.isMeshStandardMaterial
    ? source
    : new THREE.MeshStandardMaterial({ color, map, roughness: 0.65, metalness: 0.05 });
  return {
    // A textured material's own color is white; clay needs a real gray.
    untextured: new THREE.MeshLambertMaterial({ color: map ? CLAY_COLOR : color }),
    textured: new THREE.MeshLambertMaterial({ color, map }),
    pathtraced,
  };
}

/** Small equirect gradient: bright sky above, dim ground below. */
function makeGradientEnvironment(): THREE.Texture {
  const w = 64;
  const h = 32;
  const data = new Float32Array(w * h * 4);
  const sky = new THREE.Color(0xcfd8e6);
  const horizon = new THREE.Color(0x8d97a8);
  const ground = new THREE.Color(0x3a3f4a);
  const c = new THREE.Color();
  for (let y = 0; y < h; y++) {
    const t = y / (h - 1); // 0 = top row (zenith), 1 = bottom row (nadir)
    if (t < 0.5) c.lerpColors(sky, horizon, t / 0.5);
    else c.lerpColors(horizon, ground, (t - 0.5) / 0.5);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = c.r;
      data[i + 1] = c.g;
      data[i + 2] = c.b;
      data[i + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function loadStoredMode(): RenderMode | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return RENDER_MODES.includes(v as RenderMode) ? (v as RenderMode) : null;
  } catch {
    return null;
  }
}

/** Wire the sidebar's render-mode buttons to the renderer. */
export function bindRenderModeButtons(sceneRenderer: SceneRenderer) {
  const buttons: Record<RenderMode, HTMLButtonElement | null> = {
    untextured: document.getElementById('btn-render-untextured') as HTMLButtonElement | null,
    textured: document.getElementById('btn-render-textured') as HTMLButtonElement | null,
    pathtraced: document.getElementById('btn-render-pathtraced') as HTMLButtonElement | null,
  };
  const refresh = () => {
    for (const mode of RENDER_MODES) buttons[mode]?.classList.toggle('active', sceneRenderer.mode === mode);
  };
  for (const mode of RENDER_MODES) buttons[mode]?.addEventListener('click', () => sceneRenderer.setMode(mode));
  sceneRenderer.onChange(refresh);
  refresh();
}
