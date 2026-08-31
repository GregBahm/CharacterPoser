import * as THREE from 'three';

export interface DirectionalLightSettings {
  /** Hex color, e.g. "#ffffff". */
  color: string;
  intensity: number;
  /** Where the light comes from: degrees around +Y, from +Z (front) toward +X. */
  azimuth: number;
  /** Degrees above the horizon. */
  elevation: number;
  /** Angular radius of the light source in degrees; soft shadows when path traced. */
  softness: number;
}

export interface AmbientLightSettings {
  color: string;
  intensity: number;
}

export interface LightingSettings {
  ambient: AmbientLightSettings;
  lights: DirectionalLightSettings[];
}

export const MAX_LIGHTS = 8;

/** Valid ranges, shared by the sliders and document validation. */
export const LIGHT_RANGES = {
  intensity: { min: 0, max: 5, step: 0.05 },
  ambientIntensity: { min: 0, max: 3, step: 0.05 },
  azimuth: { min: -180, max: 180, step: 1 },
  elevation: { min: -90, max: 90, step: 1 },
  softness: { min: 0, max: 30, step: 0.5 },
} as const;

/** The scene as it was lit before lighting became editable. */
export function defaultLighting(): LightingSettings {
  return {
    ambient: { color: '#cfd8e6', intensity: 1.1 },
    lights: [{ color: '#ffffff', intensity: 2.2, azimuth: 37, elevation: 50, softness: 2 }],
  };
}

/** A fill light from the other side, for the Add Light button. */
export function defaultLight(): DirectionalLightSettings {
  return { color: '#ffffff', intensity: 1.2, azimuth: -60, elevation: 30, softness: 5 };
}

export function cloneLighting(settings: LightingSettings): LightingSettings {
  return { ambient: { ...settings.ambient }, lights: settings.lights.map((light) => ({ ...light })) };
}

/** Unit vector from the scene toward the light. */
export function lightDirection(light: DirectionalLightSettings, out = new THREE.Vector3()): THREE.Vector3 {
  const azimuth = THREE.MathUtils.degToRad(light.azimuth);
  const elevation = THREE.MathUtils.degToRad(light.elevation);
  return out.set(
    Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
  );
}

/** Raster directional lights sit here along their direction (shadow camera reach). */
const LIGHT_DISTANCE = 10;
/** The path tracer's soft-light stand-in discs sit out here, beyond the scene. */
const AREA_LIGHT_DISTANCE = 30;
/** Half-extent of the shadow camera when there is nothing to fit it to. */
const SHADOW_EXTENT = 5;
/**
 * Padding around the control points so the mesh itself (top of the head,
 * fingertips, shoes) stays inside the fitted shadow frustum.
 */
const SHADOW_MARGIN = 0.35;
const UP = new THREE.Vector3(0, 1, 0);
/** Ground bounce is the ambient color at this brightness. */
const GROUND_TINT = 0.35;

interface LightEntry {
  directional: THREE.DirectionalLight;
  area: THREE.RectAreaLight;
  soft: boolean;
}

/**
 * The scene's lights as three.js objects, rebuilt from LightingSettings: a
 * hemisphere light for the ambient term and one DirectionalLight per light,
 * the first of which casts the raster shadows. The path tracer's directional
 * lights have no angular size, so for path tracing each light with softness
 * is stood in for by a distant circular area light of matching irradiance;
 * setPathTraced picks which of the two is visible.
 */
export class SceneLighting {
  group = new THREE.Group();
  settings: LightingSettings = defaultLighting();

  private hemisphere = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
  private entries: LightEntry[] = [];
  private pathTraced = false;
  private environmentTexture: THREE.DataTexture | null = null;
  private environmentColor = '';
  private shadowBox = new THREE.Box3();
  private lightView = new THREE.Matrix4();
  private corner = new THREE.Vector3();
  private v0 = new THREE.Vector3();
  private v1 = new THREE.Vector3();

  constructor() {
    this.group.add(this.hemisphere);
    this.apply(this.settings);
  }

  apply(settings: LightingSettings) {
    this.settings = cloneLighting(settings);

    const ambient = new THREE.Color(settings.ambient.color);
    this.hemisphere.color.copy(ambient);
    this.hemisphere.groundColor.copy(ambient).multiplyScalar(GROUND_TINT);
    this.hemisphere.intensity = settings.ambient.intensity;

    while (this.entries.length > settings.lights.length) {
      const entry = this.entries.pop()!;
      this.group.remove(entry.directional, entry.directional.target, entry.area);
      entry.directional.dispose();
      entry.area.dispose();
    }
    while (this.entries.length < settings.lights.length) {
      const entry = createEntry();
      this.entries.push(entry);
      this.group.add(entry.directional, entry.directional.target, entry.area);
    }
    settings.lights.forEach((light, index) => this.applyLight(this.entries[index], light, index === 0));
  }

  /**
   * Fit the shadow-casting light's frustum to the characters (call each
   * frame) so the shadow map's resolution is spent on them rather than on a
   * fixed area. The ground shadow still fits: it lies along the same light
   * rays, further down the frustum, so only the far plane needs room for it.
   */
  fitShadows(bounds: THREE.Box3 | null) {
    const entry = this.entries[0];
    if (!entry) return;
    const light = entry.directional;
    const camera = light.shadow.camera;

    if (!bounds) {
      camera.left = -SHADOW_EXTENT;
      camera.right = SHADOW_EXTENT;
      camera.bottom = -SHADOW_EXTENT;
      camera.top = SHADOW_EXTENT;
      camera.near = 0.5;
      camera.far = 3 * LIGHT_DISTANCE;
      camera.updateProjectionMatrix();
      return;
    }

    const box = this.shadowBox.copy(bounds).expandByScalar(SHADOW_MARGIN);
    box.min.y = Math.min(box.min.y, 0); // the ground under the feet receives too

    light.updateWorldMatrix(true, false);
    light.target.updateWorldMatrix(true, false);
    const position = light.getWorldPosition(this.v0);
    const target = light.target.getWorldPosition(this.v1);
    // Light-space view: the box's extents across the light's view become the
    // orthographic bounds, its depth the near/far range.
    this.lightView.lookAt(position, target, UP).setPosition(position).invert();
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < 8; i++) {
      this.corner.set(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      ).applyMatrix4(this.lightView);
      minX = Math.min(minX, this.corner.x);
      maxX = Math.max(maxX, this.corner.x);
      minY = Math.min(minY, this.corner.y);
      maxY = Math.max(maxY, this.corner.y);
      minZ = Math.min(minZ, this.corner.z);
      maxZ = Math.max(maxZ, this.corner.z);
    }
    camera.left = minX;
    camera.right = maxX;
    camera.bottom = minY;
    camera.top = maxY;
    camera.near = Math.max(0.1, -maxZ - 0.5);
    // Room past the characters for the ground shadow, which stretches away
    // from them when the light is low.
    camera.far = -minZ + 2 * LIGHT_DISTANCE;
    camera.updateProjectionMatrix();
  }

  /** Path tracing swaps soft lights for their area-light stand-ins. */
  setPathTraced(pathTraced: boolean) {
    this.pathTraced = pathTraced;
    for (const entry of this.entries) this.updateVisibility(entry);
  }

  /** Sky-to-ground gradient in the ambient color, the path tracer's stand-in for the hemisphere light. */
  environment(): THREE.Texture {
    if (!this.environmentTexture || this.environmentColor !== this.settings.ambient.color) {
      this.environmentTexture?.dispose();
      this.environmentTexture = makeGradientEnvironment(new THREE.Color(this.settings.ambient.color));
      this.environmentColor = this.settings.ambient.color;
    }
    return this.environmentTexture;
  }

  get environmentIntensity(): number {
    // The gradient is brighter on average than the hemisphere light's mix.
    return this.settings.ambient.intensity * 0.8;
  }

  private applyLight(entry: LightEntry, light: DirectionalLightSettings, castShadow: boolean) {
    const direction = lightDirection(light);
    const color = new THREE.Color(light.color);

    const directional = entry.directional;
    directional.color.copy(color);
    directional.intensity = light.intensity;
    directional.position.copy(direction).multiplyScalar(LIGHT_DISTANCE);
    directional.target.position.set(0, 0, 0);
    directional.castShadow = castShadow;

    // A disc of angular radius θ subtends Ω = π·tan²θ; radiance I/Ω delivers
    // the directional light's irradiance I, whatever the distance.
    const angle = THREE.MathUtils.degToRad(light.softness);
    const radius = AREA_LIGHT_DISTANCE * Math.tan(angle);
    const area = entry.area;
    area.color.copy(color);
    area.width = 2 * radius;
    area.height = 2 * radius;
    area.intensity = angle > 0 ? light.intensity / (Math.PI * Math.tan(angle) ** 2) : 0;
    area.position.copy(direction).multiplyScalar(AREA_LIGHT_DISTANCE);
    area.lookAt(0, 0, 0);

    entry.soft = angle > 0;
    this.updateVisibility(entry);
  }

  private updateVisibility(entry: LightEntry) {
    const useArea = this.pathTraced && entry.soft;
    entry.area.visible = useArea;
    entry.directional.visible = !useArea;
  }
}

function createEntry(): LightEntry {
  const directional = new THREE.DirectionalLight(0xffffff, 1);
  directional.shadow.mapSize.set(2048, 2048);
  directional.shadow.camera.left = -SHADOW_EXTENT;
  directional.shadow.camera.right = SHADOW_EXTENT;
  directional.shadow.camera.top = SHADOW_EXTENT;
  directional.shadow.camera.bottom = -SHADOW_EXTENT;
  directional.shadow.camera.near = 0.5;
  directional.shadow.camera.far = 3 * LIGHT_DISTANCE;
  // Self-shadowing needs a little bias against acne; the fitted frustum
  // keeps texels small (millimetres), so these stay modest.
  directional.shadow.bias = -0.0003;
  directional.shadow.normalBias = 0.02;
  const area = new THREE.RectAreaLight(0xffffff, 1, 1, 1);
  // three-gpu-pathtracer samples a RectAreaLight as a disc when flagged circular.
  (area as THREE.RectAreaLight & { isCircular: boolean }).isCircular = true;
  area.visible = false;
  return { directional, area, soft: false };
}

/** Small equirect gradient: the ambient color above, dimmer below. */
function makeGradientEnvironment(sky: THREE.Color): THREE.DataTexture {
  const w = 64;
  const h = 32;
  const data = new Float32Array(w * h * 4);
  const ground = sky.clone().multiplyScalar(GROUND_TINT);
  const horizon = sky.clone().lerp(ground, 0.5);
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
