import * as THREE from 'three';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { N8AOPass } from 'n8ao';
import { SceneLighting } from './lighting.ts';

export type RenderMode = 'untextured' | 'textured' | 'pathtraced';
export const RENDER_MODES: RenderMode[] = ['untextured', 'textured', 'pathtraced'];

/** Neutral clay color for textured models in the untextured mode. */
const CLAY_COLOR = 0xb8bdc7;

const MODE_KEY = 'characterPoser.renderMode';
const SSAO_KEY = 'characterPoser.ssao';
/** Quiet time after the last pose/camera/light change before path tracing resumes. */
const SETTLE_MS = 150;

interface MaterialSet {
  untextured: THREE.Material;
  textured: THREE.Material;
  pathtraced: THREE.Material;
}

/**
 * Owns how the scene is drawn: Lambert shading in clay or with the models'
 * textures (optionally with screen-space ambient occlusion), or a
 * progressive GPU path trace (three-gpu-pathtracer). The path tracer
 * accumulates samples while the scene is still; any pose, camera, or light
 * change drops back to a rasterized frame and, once the change settles, the
 * tracer rebuilds (geometry), re-aims (camera), or relights and starts
 * converging again.
 *
 * Overlay objects (control points, widgets) live in `overlay` and are drawn
 * on top of every mode, never path traced.
 */
export class SceneRenderer {
  mode: RenderMode;
  /** Screen-space ambient occlusion for the raster modes (per-browser preference). */
  ssao: boolean;
  overlay = new THREE.Scene();
  /** Draws extra views (insets) over the finished frame; plain raster. */
  insets: ((renderer: THREE.WebGLRenderer) => void) | null = null;

  private pathTracer: WebGLPathTracer | null = null;
  private composer: EffectComposer | null = null;
  private aoPass: N8AOPass | null = null;
  private materialSets = new Map<THREE.Mesh, MaterialSet>();

  private geometryDirty = true;
  private cameraDirty = true;
  private lightsDirty = false;
  private environmentDirty = false;
  private lastChange = 0;
  private lastCameraWorld = new THREE.Matrix4();
  private lastCameraProj = new THREE.Matrix4();
  private listeners: (() => void)[] = [];

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private opts: {
      lighting: SceneLighting;
      /** Meshes under these roots get per-mode materials. */
      shaded: THREE.Object3D[];
      /** Raster-only helpers hidden while path tracing (e.g. the grid). */
      rasterOnly: THREE.Object3D[];
      /** Element that shows the path tracer's progress; may be null. */
      status?: HTMLElement | null;
    },
  ) {
    // Soft-light stand-ins are RectAreaLights; raster fallback frames need the LTC tables.
    RectAreaLightUniformsLib.init();
    // Shadow maps are rendered once per frame (see render), not once per view.
    renderer.shadowMap.autoUpdate = false;
    for (const root of opts.shaded) this.trackMeshes(root);
    this.mode = loadStoredMode() ?? 'textured';
    this.ssao = loadStoredFlag(SSAO_KEY) ?? false;
    this.applyMode();
  }

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  setMode(mode: RenderMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    store(MODE_KEY, mode);
    this.applyMode();
    this.emit();
  }

  setSsao(ssao: boolean) {
    if (ssao === this.ssao) return;
    this.ssao = ssao;
    store(SSAO_KEY, ssao ? '1' : '0');
    // Whatever the AO accumulated before it was switched off is stale now.
    if (this.aoPass) this.aoPass.needsFrame = true;
    this.emit();
  }

  /** Viewport size in CSS pixels; keeps the post-processing buffers in step. */
  setSize(width: number, height: number) {
    this.composer?.setSize(width, height);
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

  /** Call whenever posed geometry changes (pose edits, undo, loads). */
  markGeometryChanged() {
    this.geometryDirty = true;
    this.lastChange = performance.now();
    // The AO pass only notices camera motion on its own; restart its
    // frame accumulation so a pose drag doesn't ghost.
    if (this.aoPass) this.aoPass.needsFrame = true;
  }

  /** Call after the directional lights change; raster picks it up on its own. */
  markLightsChanged() {
    if (this.mode !== 'pathtraced') return;
    this.lightsDirty = true;
    this.lastChange = performance.now();
  }

  /** Call after the ambient light changes; the path tracer's environment follows it. */
  markEnvironmentChanged() {
    if (this.mode !== 'pathtraced') return;
    this.applyEnvironment();
    this.environmentDirty = true;
    this.lastChange = performance.now();
  }

  /** Draw one frame in the current mode, the overlay on top, then any insets. */
  render() {
    this.detectCameraChange();
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.setScissorTest(false);

    if (this.mode === 'pathtraced') {
      this.renderPathTraced();
    } else {
      this.renderRaster();
    }

    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.overlay, this.camera);
    this.renderer.autoClear = true;

    this.insets?.(this.renderer);
  }

  private emit() {
    for (const fn of this.listeners) fn();
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

  private renderRaster() {
    this.renderer.autoClear = true;
    if (this.ssao) this.ensureComposer().render();
    else this.renderer.render(this.scene, this.camera);
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
    const dirty = this.geometryDirty || this.cameraDirty || this.lightsDirty || this.environmentDirty;
    const settled = performance.now() - this.lastChange >= SETTLE_MS;

    if (dirty && !settled) {
      // Mid-gesture: plain raster so dragging stays fluid.
      this.renderer.autoClear = true;
      this.renderer.render(this.scene, this.camera);
      this.setStatus('Path tracing paused…');
      return;
    }
    if (this.geometryDirty) {
      tracer.setScene(this.scene, this.camera);
    } else {
      if (this.lightsDirty) {
        this.scene.updateMatrixWorld(true);
        tracer.updateLights();
      }
      if (this.environmentDirty) tracer.updateEnvironment();
      if (this.cameraDirty) tracer.updateCamera();
    }
    this.geometryDirty = false;
    this.cameraDirty = false;
    this.lightsDirty = false;
    this.environmentDirty = false;

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

  /**
   * N8AO (renders the scene itself, then composites the occlusion) → output
   * color conversion; sized from the renderer when first needed. Neural
   * denoising keeps single frames clean while dragging; accumulation
   * averages frames once the view is still.
   */
  private ensureComposer(): EffectComposer {
    if (this.composer) return this.composer;
    const composer = new EffectComposer(this.renderer);
    const size = this.renderer.getSize(new THREE.Vector2());
    const ao = new N8AOPass(this.scene, this.camera, size.x, size.y);
    ao.setQualityMode('Neural-Medium');
    // Scene units are meters: reach a few tens of centimeters from a surface.
    ao.configuration.aoRadius = 0.35;
    ao.configuration.distanceFalloff = 1.0;
    ao.configuration.intensity = 3.0;
    ao.configuration.accumulate = true;
    ao.configuration.gammaCorrection = false; // OutputPass converts to sRGB
    composer.addPass(ao);
    composer.addPass(new OutputPass());
    this.aoPass = ao;
    this.composer = composer;
    return composer;
  }

  private applyMode() {
    const mode = this.mode;
    for (const [mesh, set] of this.materialSets) mesh.material = set[mode];

    for (const obj of this.opts.rasterOnly) obj.visible = mode !== 'pathtraced';
    this.opts.lighting.setPathTraced(mode === 'pathtraced');

    if (mode === 'pathtraced') {
      this.applyEnvironment();
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

  /** The ambient light's gradient stands in for the hemisphere light, which the path tracer can't sample. */
  private applyEnvironment() {
    this.scene.environment = this.opts.lighting.environment();
    this.scene.environmentIntensity = this.opts.lighting.environmentIntensity;
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

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
}

function loadStoredMode(): RenderMode | null {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return RENDER_MODES.includes(v as RenderMode) ? (v as RenderMode) : null;
  } catch {
    return null;
  }
}

function loadStoredFlag(key: string): boolean | null {
  try {
    const v = localStorage.getItem(key);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

/** Wire the sidebar's render-mode buttons and the ambient-occlusion toggle to the renderer. */
export function bindRenderModeButtons(sceneRenderer: SceneRenderer) {
  const buttons: Record<RenderMode, HTMLButtonElement | null> = {
    untextured: document.getElementById('btn-render-untextured') as HTMLButtonElement | null,
    textured: document.getElementById('btn-render-textured') as HTMLButtonElement | null,
    pathtraced: document.getElementById('btn-render-pathtraced') as HTMLButtonElement | null,
  };
  const ssaoButton = document.getElementById('btn-ssao') as HTMLButtonElement | null;
  const refresh = () => {
    for (const mode of RENDER_MODES) buttons[mode]?.classList.toggle('active', sceneRenderer.mode === mode);
    ssaoButton?.classList.toggle('active', sceneRenderer.ssao);
    // Occlusion only applies to the raster modes.
    if (ssaoButton) ssaoButton.disabled = sceneRenderer.mode === 'pathtraced';
  };
  for (const mode of RENDER_MODES) buttons[mode]?.addEventListener('click', () => sceneRenderer.setMode(mode));
  ssaoButton?.addEventListener('click', () => sceneRenderer.setSsao(!sceneRenderer.ssao));
  sceneRenderer.onChange(refresh);
  refresh();
}
