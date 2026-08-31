import * as THREE from 'three';
import { CharacterScene } from './scene.ts';
import { JointId } from './pose.ts';
import { AppState, pointColor } from './state.ts';

export type PopupView = 'side' | 'top';
export const POPUP_VIEWS: PopupView[] = ['side', 'top'];

/** In CSS pixels from the canvas's top-left corner. */
export interface ViewRect {
  x: number;
  y: number;
  size: number;
}

const MARGIN = 12;
/** The two insets span the viewport height (margins above, between, below); this caps them on short, wide windows. */
const WIDTH_FRACTION = 0.45;
/** Screen distance kept between the selected point (and its widgets) and the insets. */
const CLEARANCE = 90;
const MIN_DISTANCE = 0.05;
const MAX_DISTANCE = 20;
const LABELS: Record<PopupView, string> = { side: 'Side', top: 'Top' };
const FLIPPED_LABELS: Record<PopupView, string> = { side: 'Side (flipped)', top: 'Bottom' };
const FLIP_KEY = 'characterPoser.insetFlips';

function loadFlips(): Record<PopupView, boolean> {
  try {
    const stored = JSON.parse(localStorage.getItem(FLIP_KEY) ?? '{}') as Partial<Record<PopupView, boolean>>;
    return { side: stored.side === true, top: stored.top === true };
  } catch {
    return { side: false, top: false };
  }
}

interface Anchor {
  characterId: string;
  joint: JointId;
  /** The point when the views were captured; the views stay aimed here. */
  point: THREE.Vector3;
  placement: 'left' | 'right';
  /** Unit offsets from the point toward each view's camera. */
  offset: Record<PopupView, THREE.Vector3>;
  up: Record<PopupView, THREE.Vector3>;
  /** Shared by both views: zooming one zooms the other. */
  distance: number;
}

/**
 * Two small inset views that appear while a control point is selected: one
 * from the side (the main camera's offset rotated 90° about the vertical
 * axis through the point) and one from above, both at the main camera's
 * distance scaled down by the insets' size so the point looks as big as it
 * does in the main view, so the point can be placed in all three dimensions.
 * They show the scene and only the selected point — no twist or aim widgets
 * — and are captured when the point gains focus: moving the point doesn't
 * move them, only zooming (mouse wheel over either view zooms both) or
 * reselecting does.
 */
export class PopupViews {
  cameras: Record<PopupView, THREE.PerspectiveCamera> = {
    side: new THREE.PerspectiveCamera(40, 1, 0.02, 100),
    top: new THREE.PerspectiveCamera(40, 1, 0.02, 100),
  };

  private anchor: Anchor | null = null;
  /** Right-click toggles: side looks from the opposite side, top becomes bottom. Persists across selections. */
  private flipped = loadFlips();
  private overlay = new THREE.Scene();
  private sphere: THREE.Mesh;
  private planeIndicator: THREE.Mesh;
  private frames: Record<PopupView, HTMLElement>;
  private labels: Record<PopupView, HTMLElement>;
  private hovered = false;
  private xzLocked = false;
  private projected = new THREE.Vector3();
  private offset = new THREE.Vector3();

  constructor(
    private scene: CharacterScene,
    private state: AppState,
    private mainCamera: THREE.PerspectiveCamera,
    private canvas: HTMLCanvasElement,
    host: HTMLElement,
  ) {
    this.sphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.sphere.renderOrder = 10;
    this.planeIndicator = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.04, 1),
      new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity: 0.8 }),
    );
    this.planeIndicator.renderOrder = 10;
    this.planeIndicator.visible = false;
    this.overlay.add(this.sphere, this.planeIndicator);

    const labels: Partial<Record<PopupView, HTMLElement>> = {};
    const frame = (view: PopupView) => {
      const el = document.createElement('div');
      el.className = 'popup-view';
      el.hidden = true;
      const label = document.createElement('span');
      label.textContent = LABELS[view];
      el.appendChild(label);
      host.appendChild(el);
      labels[view] = label;
      return el;
    };
    this.frames = { side: frame('side'), top: frame('top') };
    this.labels = labels as Record<PopupView, HTMLElement>;
  }

  /** Look from the opposite direction (side ↔ other side, top ↔ bottom); remembered across selections. */
  flip(view: PopupView) {
    this.flipped[view] = !this.flipped[view];
    try {
      localStorage.setItem(FLIP_KEY, JSON.stringify(this.flipped));
    } catch {
      /* private mode etc. */
    }
  }

  /** Where the views are, or null while nothing is selected. */
  rects(): Record<PopupView, ViewRect> | null {
    return this.anchor ? this.layout(this.anchor.placement) : null;
  }

  /** The view under a client position, if any. */
  viewAt(clientX: number, clientY: number): PopupView | null {
    const rects = this.rects();
    if (!rects) return null;
    const bounds = this.canvas.getBoundingClientRect();
    const x = clientX - bounds.left;
    const y = clientY - bounds.top;
    for (const view of POPUP_VIEWS) {
      const r = rects[view];
      if (x >= r.x && x <= r.x + r.size && y >= r.y && y <= r.y + r.size) return view;
    }
    return null;
  }

  /** Normalized device coordinates of a client position within a view. */
  ndcIn(view: PopupView, clientX: number, clientY: number): THREE.Vector2 {
    const r = this.rects()![view];
    const bounds = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - bounds.left - r.x) / r.size) * 2 - 1,
      -((clientY - bounds.top - r.y) / r.size) * 2 + 1,
    );
  }

  /** Zoom both views together (the wheel over either one). */
  zoom(factor: number) {
    if (!this.anchor) return;
    this.anchor.distance = THREE.MathUtils.clamp(this.anchor.distance * factor, MIN_DISTANCE, MAX_DISTANCE);
  }

  setHovered(hovered: boolean) {
    this.hovered = hovered;
  }

  setXZLocked(locked: boolean) {
    this.xzLocked = locked;
  }

  /** Called every frame: (re)capture on selection change, then aim the cameras and place the frames. */
  update() {
    const character = this.scene.active;
    const joint = this.state.selected;
    if (!character || !joint) {
      this.anchor = null;
      for (const view of POPUP_VIEWS) this.frames[view].hidden = true;
      return;
    }
    if (!this.anchor || this.anchor.characterId !== character.id || this.anchor.joint !== joint) {
      this.anchor = this.capture(character.id, joint, character.pose.get(joint).pos);
    }

    const anchor = this.anchor;
    const rects = this.layout(anchor.placement);
    for (const view of POPUP_VIEWS) {
      const camera = this.cameras[view];
      camera.fov = this.mainCamera.fov;
      this.offset.copy(anchor.offset[view]);
      if (this.flipped[view]) this.offset.negate();
      camera.position.copy(anchor.point).addScaledVector(this.offset, anchor.distance);
      camera.up.copy(anchor.up[view]);
      camera.lookAt(anchor.point);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();

      const frame = this.frames[view];
      const r = rects[view];
      frame.hidden = false;
      this.labels[view].textContent = this.flipped[view] ? FLIPPED_LABELS[view] : LABELS[view];
      frame.style.left = `${r.x}px`;
      frame.style.top = `${r.y}px`;
      frame.style.width = `${r.size}px`;
      frame.style.height = `${r.size}px`;
    }

    // The point itself follows the pose; same size rules as the main view's spheres.
    const anchorJoint = joint === 'Head' || joint === 'LeftHand' || joint === 'RightHand';
    const detailSize = this.state.activeView === 'face' ? 0.006 : 0.005;
    const pointSize = this.state.activeView === 'body' ? 0.024 : anchorJoint ? 0.009 : detailSize;
    const point = character.pose.get(joint).pos;
    this.sphere.visible = !this.xzLocked;
    this.sphere.scale.setScalar(pointSize);
    this.sphere.position.copy(point);
    this.planeIndicator.visible = this.xzLocked;
    this.planeIndicator.position.copy(point);
    this.planeIndicator.scale.setScalar(pointSize * 3);
    const color = pointColor(true, this.hovered);
    (this.sphere.material as THREE.MeshBasicMaterial).color.setHex(color);
    (this.planeIndicator.material as THREE.MeshBasicMaterial).color.setHex(color);
  }

  /** Draw both views into their rectangles; call after the main view has been drawn. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    const rects = this.rects();
    if (!rects) return;
    const size = renderer.getSize(new THREE.Vector2());
    renderer.setScissorTest(true);
    for (const view of POPUP_VIEWS) {
      const r = rects[view];
      const y = size.y - r.y - r.size; // GL viewports measure from the bottom
      renderer.setViewport(r.x, y, r.size, r.size);
      renderer.setScissor(r.x, y, r.size, r.size);
      renderer.autoClear = true;
      renderer.render(scene, this.cameras[view]);
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(this.overlay, this.cameras[view]);
    }
    renderer.autoClear = true;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, size.x, size.y);
  }

  private capture(characterId: string, joint: JointId, position: THREE.Vector3): Anchor {
    const point = position.clone();
    const toCamera = new THREE.Vector3().subVectors(this.mainCamera.position, point);
    const mainDistance = Math.max(toCamera.length(), 0.1);
    const v = toCamera.normalize();
    // Side: the main camera's offset swung 90° around the vertical axis through the point.
    const side = new THREE.Vector3(v.z, v.y, -v.x);
    // Top: straight above, with the main view's forward direction as screen-up
    // so left/right agree between the two views.
    const topUp = new THREE.Vector3(-v.x, 0, -v.z);
    if (topUp.lengthSq() < 1e-6) topUp.set(0, 0, -1);
    topUp.normalize();

    // Keep the insets off the selected point (and its widgets); prefer the right.
    let placement: 'left' | 'right' = 'right';
    const bounds = this.canvas.getBoundingClientRect();
    const rects = this.layout('right');
    this.projected.copy(point).project(this.mainCamera);
    if (this.projected.z <= 1) {
      const px = ((this.projected.x + 1) / 2) * bounds.width;
      const py = ((1 - this.projected.y) / 2) * bounds.height;
      const top = rects.side.y;
      const bottom = rects.top.y + rects.top.size;
      if (px >= rects.side.x - CLEARANCE && py >= top - CLEARANCE && py <= bottom + CLEARANCE) placement = 'left';
    }

    // An inset is a fraction of the main view's height; the same fraction of
    // the main camera's distance keeps the point the same size on screen.
    const scale = rects.side.size / Math.max(1, this.canvas.clientHeight);

    return {
      characterId,
      joint,
      point,
      placement,
      offset: { side, top: new THREE.Vector3(0, 1, 0) },
      up: { side: new THREE.Vector3(0, 1, 0), top: topUp },
      distance: THREE.MathUtils.clamp(mainDistance * scale, MIN_DISTANCE, MAX_DISTANCE),
    };
  }

  private layout(placement: 'left' | 'right'): Record<PopupView, ViewRect> {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const size = Math.max(64, Math.min(Math.floor((height - 3 * MARGIN) / 2), Math.floor(width * WIDTH_FRACTION)));
    const x = placement === 'right' ? width - size - MARGIN : MARGIN;
    const y = MARGIN;
    return {
      side: { x, y, size },
      top: { x, y: y + size + MARGIN, size },
    };
  }
}
