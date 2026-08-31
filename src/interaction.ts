import * as THREE from 'three';
import { Character } from './character.ts';
import {
  CONTROL_JOINTS,
  ControlView,
  isAimOnlyJoint,
  isPositionLockedJoint,
  JointId,
} from './pose.ts';
import { PopupView, PopupViews } from './popup-views.ts';
import { CharacterScene } from './scene.ts';
import { AppState, COLORS } from './state.ts';
import { applySceneControls, ControlTransformDocument, serializeAllControls } from './documents.ts';

/** The right mouse button makes a manipulation carry the node's subtree. */
function cascades(e: PointerEvent): boolean {
  return e.button === 2;
}

/** Meters moved per mousewheel notch while depth-dragging a point. */
const Z_STEP = 0.05;
/** Direction helper distance in front of the node, along its aim. */
const HELPER_OFFSET = 0.24;
/** Radians of camera orbit per pixel of Alt-drag (Maya/Unity tumble feel). */
const ORBIT_SPEED = 0.008;
/** Exponential camera-distance change per horizontal pixel of Alt + right-drag. */
const ZOOM_DRAG_SPEED = 0.01;
/** Keep the orbit pitch this far from straight up/down so the camera never flips. */
const ORBIT_PITCH_LIMIT = THREE.MathUtils.degToRad(89);
const RING_RADIUS = 0.09;
const RING_TUBE = 0.007;
/** Pixels around a character's on-screen control points that count as hovering it. */
const REVEAL_MARGIN = 50;

function detailScale(view: ControlView): number {
  return view === 'body' ? 1 : view === 'face' ? 0.18 : 0.13;
}

function setTwistRingGradient(geometry: THREE.BufferGeometry, startColor: number) {
  const uv = geometry.getAttribute('uv');
  let colorAttribute = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!colorAttribute) {
    colorAttribute = new THREE.BufferAttribute(new Float32Array(uv.count * 3), 3);
    geometry.setAttribute('color', colorAttribute);
  }
  const start = new THREE.Color(startColor);
  const end = new THREE.Color(COLORS.free);
  const color = new THREE.Color();
  for (let i = 0; i < uv.count; i++) {
    color.lerpColors(start, end, uv.getX(i)).toArray(colorAttribute.array, i * 3);
  }
  colorAttribute.needsUpdate = true;
}

function twistRingGeometry(): THREE.TorusGeometry {
  const geometry = new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 10, 48);
  setTwistRingGradient(geometry, COLORS.ring);
  return geometry;
}

/**
 * The helper widgets shown for the selected node of the active character,
 * in the node's local frame: the twist ring lies perpendicular to the
 * node's aim, the direction helper floats in front of the node along its
 * current aim, and a passive stretch ring (coplanar with the twist ring)
 * shows how far the segment ending at this node is from its natural
 * length: its radius is the twist ring's radius times the stretch factor,
 * so it coincides with (hides behind) the twist ring at natural length,
 * grows when longer, shrinks when shorter.
 */
export class Widgets {
  group = new THREE.Group();
  ringPick: THREE.Mesh;
  helperPick: THREE.Mesh;
  private ring: THREE.Mesh;
  private stretchRing: THREE.Mesh;
  private stretchRingRadius = RING_RADIUS;
  private helper: THREE.Mesh;
  private line: THREE.Line;
  private linePositions: Float32Array;
  private hovered: 'ring' | 'helper' | null = null;
  private ringHighlighted = false;

  constructor(
    private scene: CharacterScene,
    private state: AppState,
  ) {
    this.ring = new THREE.Mesh(
      twistRingGeometry(),
      new THREE.MeshBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.85 }),
    );
    this.ring.renderOrder = 11;
    this.stretchRing = new THREE.Mesh(
      new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 10, 48),
      new THREE.MeshBasicMaterial({ color: COLORS.stretchRing, depthTest: false, transparent: true, opacity: 0.7 }),
    );
    // Drawn just under the twist ring so it vanishes when the radii match.
    this.stretchRing.renderOrder = 10.5;
    // Fatter invisible torus so the thin ring is easy to grab.
    this.ringPick = new THREE.Mesh(
      new THREE.TorusGeometry(RING_RADIUS, 0.03, 8, 32),
      new THREE.MeshBasicMaterial({ visible: false }),
    );

    this.helper = new THREE.Mesh(
      new THREE.SphereGeometry(0.018, 16, 12),
      new THREE.MeshBasicMaterial({ color: COLORS.helper, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    this.helper.renderOrder = 12;
    this.helperPick = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 12, 8),
      new THREE.MeshBasicMaterial({ visible: false }),
    );

    this.linePositions = new Float32Array(6);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
    this.line = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({ color: COLORS.helper, depthTest: false, transparent: true, opacity: 0.55 }),
    );
    this.line.renderOrder = 11;

    this.group.add(this.ring, this.stretchRing, this.ringPick, this.helper, this.helperPick, this.line);
    this.group.visible = false;
  }

  /** The node the widgets belong to, if a joint of the active character is selected. */
  target(): { character: Character; joint: JointId } | null {
    const character = this.scene.active;
    const joint = this.state.selected;
    return character && joint ? { character, joint } : null;
  }

  /** Rebuild the stretch ring's torus so its tube stays constant while the radius changes. */
  private setStretchRingRadius(radius: number) {
    radius = Math.max(radius, RING_TUBE);
    if (Math.abs(radius - this.stretchRingRadius) < 1e-4) return;
    this.stretchRingRadius = radius;
    this.stretchRing.geometry.dispose();
    this.stretchRing.geometry = new THREE.TorusGeometry(radius, RING_TUBE, 10, 48);
  }

  helperWorldPos(target = new THREE.Vector3()): THREE.Vector3 {
    const { character, joint } = this.target()!;
    const node = character.pose.get(joint);
    return character.pose.forward(joint, target).multiplyScalar(HELPER_OFFSET * this.widgetScale()).add(node.pos);
  }

  private widgetScale(): number {
    return detailScale(this.state.activeView);
  }

  setHovered(target: 'ring' | 'helper' | null) {
    this.hovered = target;
  }

  update(hideAim = false) {
    const target = this.target();
    this.group.visible = target !== null;
    if (!target) return;
    const { character, joint } = target;
    const node = character.pose.get(joint);
    const scale = this.widgetScale();
    const ringHighlighted = this.hovered === 'ring';
    if (ringHighlighted !== this.ringHighlighted) {
      this.ringHighlighted = ringHighlighted;
      setTwistRingGradient(this.ring.geometry, ringHighlighted ? COLORS.ringHover : COLORS.ring);
    }
    (this.ring.material as THREE.MeshBasicMaterial).opacity = ringHighlighted ? 1 : 0.85;
    (this.helper.material as THREE.MeshBasicMaterial).color.setHex(
      this.hovered === 'helper' ? COLORS.helperHover : COLORS.helper,
    );

    // Aim-only joints (eyes) get just the direction helper.
    const aimOnly = isAimOnlyJoint(joint);
    this.ring.visible = !aimOnly;
    this.ringPick.visible = !aimOnly;
    // The full control frame keeps the gradient seam aligned to accumulated twist.
    const ringOrientation = character.pose.controlFrame(joint);
    this.ring.position.copy(node.pos);
    this.ring.quaternion.copy(ringOrientation);
    this.ring.scale.setScalar(scale);
    this.ringPick.position.copy(node.pos);
    this.ringPick.quaternion.copy(ringOrientation);
    this.ringPick.scale.setScalar(scale);

    this.stretchRing.visible = !aimOnly && character.pose.hasStretchSegment(joint);
    this.stretchRing.position.copy(node.pos);
    this.stretchRing.quaternion.copy(ringOrientation);
    this.stretchRing.scale.setScalar(scale);
    this.setStretchRingRadius(RING_RADIUS * character.pose.segmentStretch(joint));

    const helperPos = this.helperWorldPos();
    this.helper.visible = !hideAim;
    this.helperPick.visible = !hideAim;
    this.line.visible = !hideAim;
    this.helper.position.copy(helperPos);
    this.helper.scale.setScalar(scale);
    this.helperPick.position.copy(helperPos);
    this.helperPick.scale.setScalar(scale);

    this.linePositions.set([node.pos.x, node.pos.y, node.pos.z, helperPos.x, helperPos.y, helperPos.z]);
    (this.line.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}

interface Pick {
  character: Character;
  joint: JointId;
}

type Drag =
  /** `view` is the inset the drag started in, or null for the main view. */
  | {
      mode: 'point' | 'subtree';
      character: Character;
      joint: JointId;
      grabOffset: THREE.Vector3;
      view: PopupView | null;
      xzLocked: boolean;
      lastX: number;
      lastY: number;
    }
  | { mode: 'aim'; character: Character; joint: JointId; target: THREE.Vector3; withChildren: boolean }
  | { mode: 'twist'; character: Character; joint: JointId; axis: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3; lastAngle: number; withChildren: boolean }
  | { mode: 'twist-pixels'; character: Character; joint: JointId; lastX: number; withChildren: boolean }
  | { mode: 'pan'; lastX: number; lastY: number }
  | { mode: 'orbit'; lastX: number; lastY: number }
  | { mode: 'zoom'; lastX: number };

type PoseSnapshot = Record<JointId, ControlTransformDocument>;
/** Every character's controls, keyed by character id. */
type SceneSnapshot = Record<string, PoseSnapshot>;
type WidgetTarget = 'ring' | 'helper';
const HISTORY_LIMIT = 50;

function poseSnapshotsEqual(a: PoseSnapshot, b: PoseSnapshot): boolean {
  for (const id of CONTROL_JOINTS) {
    const left = a[id];
    const right = b[id];
    if (left.position.some((value, index) => value !== right.position[index])) return false;
    if (left.rotation.some((value, index) => value !== right.rotation[index])) return false;
  }
  return true;
}

function sceneSnapshotsEqual(a: SceneSnapshot, b: SceneSnapshot): boolean {
  const ids = Object.keys(a);
  if (ids.length !== Object.keys(b).length) return false;
  return ids.every((id) => b[id] !== undefined && poseSnapshotsEqual(a[id], b[id]));
}

/**
 * Pointer handling for the canvas. By default a manipulation affects the
 * local node only; using the right mouse button cascades it down the body,
 * carrying the whole subtree as if parented to the node:
 *  - drag a point: move it in the view plane; Shift constrains it to world XZ
 *  - mousewheel while dragging: move in z-space instead
 *  - drag the selected node's twist ring / direction helper: rotate it
 *  - Alt + left-drag: orbit; middle-drag: pan; Alt + right-drag:
 *    zoom; mousewheel (no drag): zoom
 *
 * Pose history holds every character's controls per step; adding or
 * removing a character clears it (see main.ts).
 */
export class Interaction {
  private canvas: HTMLCanvasElement;
  private camera: THREE.PerspectiveCamera;
  private cameraTarget: THREE.Vector3;
  private scene: CharacterScene;
  private state: AppState;
  private widgets: Widgets;
  private popups: PopupViews;
  private onSceneChanged: () => void;
  private raycaster = new THREE.Raycaster();
  private drag: Drag | null = null;
  private hoveredPoint: Pick | null = null;
  private shiftDown = false;
  private gestureStart: SceneSnapshot | null = null;
  private undoStack: SceneSnapshot[] = [];
  private redoStack: SceneSnapshot[] = [];

  constructor(opts: {
    canvas: HTMLCanvasElement;
    camera: THREE.PerspectiveCamera;
    cameraTarget: THREE.Vector3;
    scene: CharacterScene;
    state: AppState;
    widgets: Widgets;
    popups: PopupViews;
    onSceneChanged?: () => void;
  }) {
    this.canvas = opts.canvas;
    this.camera = opts.camera;
    this.cameraTarget = opts.cameraTarget;
    this.scene = opts.scene;
    this.state = opts.state;
    this.widgets = opts.widgets;
    this.popups = opts.popups;
    this.onSceneChanged = opts.onSceneChanged ?? (() => {});

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', () => {
      if (this.drag) return;
      this.setHovered(null, null);
      for (const character of this.scene.characters) character.points.setRevealed(false);
    });
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // Stop middle-click autoscroll.
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => {
      this.shiftDown = false;
      this.syncPlaneLock();
    });
  }

  /** Called every frame. */
  update() {
    for (const character of this.scene.characters) character.points.update(this.state);
    const draggingPoint = this.drag?.mode === 'point' || this.drag?.mode === 'subtree';
    this.widgets.update(draggingPoint || this.shiftDown);
    this.popups.setXZLocked(
      this.shiftDown && this.state.selected !== null && !isPositionLockedJoint(this.state.selected),
    );
    this.popups.update();
  }

  /** Fit every character's mesh to its pose (after edits that may touch several). */
  applyPose() {
    this.scene.applyPoses();
    this.onSceneChanged();
  }

  performPoseEdit(edit: () => void) {
    const before = this.capturePose();
    edit();
    this.applyPose();
    this.recordEdit(before);
  }

  undo() {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.capturePose());
    this.restorePose(previous);
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.capturePose());
    this.restorePose(next);
  }

  clearPoseHistory() {
    this.gestureStart = null;
    this.undoStack = [];
    this.redoStack = [];
  }

  private applyCharacter(character: Character) {
    character.applyPose();
    this.onSceneChanged();
  }

  private capturePose(): SceneSnapshot {
    return Object.fromEntries(
      this.scene.characters.map((character) => [character.id, serializeAllControls(character.pose)]),
    );
  }

  private restorePose(snapshot: SceneSnapshot) {
    for (const character of this.scene.characters) {
      const controls = snapshot[character.id];
      if (controls) applySceneControls(character.pose, controls);
    }
    this.applyPose();
  }

  private beginPoseGesture() {
    this.gestureStart = this.capturePose();
  }

  private commitPoseGesture() {
    if (!this.gestureStart) return;
    this.recordEdit(this.gestureStart);
    this.gestureStart = null;
  }

  private recordEdit(before: SceneSnapshot) {
    if (sceneSnapshotsEqual(before, this.capturePose())) return;
    this.undoStack.push(before);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Shift') {
      this.shiftDown = true;
      this.syncPlaneLock();
    }
    if (this.drag || !event.ctrlKey || event.key.toLowerCase() !== 'z' || event.repeat) return;
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    event.preventDefault();
    if (event.shiftKey) this.redo();
    else this.undo();
  };

  private onKeyUp = (event: KeyboardEvent) => {
    if (event.key !== 'Shift') return;
    this.shiftDown = false;
    this.syncPlaneLock();
  };

  private ndc(e: { clientX: number; clientY: number }): THREE.Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  private setRay(e: { clientX: number; clientY: number }) {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
  }

  /** Aim the ray through the main view or through an inset view. */
  private setRayFor(e: { clientX: number; clientY: number }, view: PopupView | null) {
    if (view) this.raycaster.setFromCamera(this.popups.ndcIn(view, e.clientX, e.clientY), this.popups.cameras[view]);
    else this.setRay(e);
  }

  private cameraFor(view: PopupView | null): THREE.PerspectiveCamera {
    return view ? this.popups.cameras[view] : this.camera;
  }

  /** Intersect the current ray with the plane through `point` parallel to the camera's view. */
  private hitViewPlane(point: THREE.Vector3, camera: THREE.Camera = this.camera): THREE.Vector3 | null {
    const normal = camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, out) ? out : null;
  }

  /** Whether the ray hits the selected point's sphere (the only thing an inset offers). */
  private hitsSelectedSphere(): boolean {
    const target = this.widgets.target();
    if (!target) return false;
    const sphere = target.character.points.sphere(target.joint);
    return this.raycaster.intersectObject(sphere, false).length > 0;
  }

  /**
   * Pointer down inside an inset: grab the selected point to move it in that
   * view's plane; a right-click on empty space flips the view around instead.
   */
  private onPopupPointerDown(e: PointerEvent, view: PopupView) {
    if (e.button !== 0 && e.button !== 2) return;
    const target = this.widgets.target();
    if (!target) return;
    this.setRayFor(e, view);
    if (!this.hitsSelectedSphere()) {
      if (e.button === 2) this.popups.flip(view);
      return;
    }
    const { character, joint } = target;
    this.beginPoseGesture();
    const center = character.pose.get(joint).pos;
    const planeHit = this.shiftDown ? null : this.hitViewPlane(center, this.cameraFor(view));
    const grabOffset = planeHit ? new THREE.Vector3().subVectors(center, planeHit) : new THREE.Vector3();
    this.drag = {
      mode: cascades(e) ? 'subtree' : 'point',
      character,
      joint,
      grabOffset,
      view,
      xzLocked: this.shiftDown,
      lastX: e.clientX,
      lastY: e.clientY,
    };
    this.syncPlaneLock();
    this.canvas.setPointerCapture(e.pointerId);
  }

  private pickSphere(): Pick | null {
    // Control spheres ignore depth, so pick the sphere nearest the ray, not the first hit.
    let best: { pick: Pick; dist: number } | null = null;
    for (const hit of this.raycaster.intersectObjects(this.scene.pickMeshes(), false)) {
      if (best && hit.distance >= best.dist) continue;
      const character = this.scene.get(hit.object.userData.characterId as string);
      if (!character) continue;
      best = { pick: { character, joint: hit.object.userData.jointId as JointId }, dist: hit.distance };
    }
    return best ? best.pick : null;
  }

  private pickWidget(): WidgetTarget | null {
    if (this.shiftDown) return null;
    const target = this.widgets.target();
    if (!target) return null;
    if (this.raycaster.intersectObject(this.widgets.helperPick, false).length > 0) return 'helper';
    // Raycasts ignore visibility; the eyes' hidden ring must not grab the pointer.
    if (isAimOnlyJoint(target.joint)) return null;
    if (this.raycaster.intersectObject(this.widgets.ringPick, false).length > 0) return 'ring';
    return null;
  }

  private setHovered(point: Pick | null, widget: WidgetTarget | null) {
    this.hoveredPoint = point;
    for (const character of this.scene.characters) {
      character.points.setHovered(point && point.character === character ? point.joint : null);
    }
    this.widgets.setHovered(widget);
    this.syncPlaneLock();
    this.canvas.style.cursor = point || widget ? 'grab' : 'default';
  }

  private syncPlaneLock() {
    const dragPoint = this.drag && (this.drag.mode === 'point' || this.drag.mode === 'subtree')
      ? { character: this.drag.character, joint: this.drag.joint }
      : null;
    const candidate = dragPoint ?? this.hoveredPoint;
    const target = this.shiftDown && candidate && !isPositionLockedJoint(candidate.joint) ? candidate : null;
    for (const character of this.scene.characters) {
      character.points.setPlaneLocked(target?.character === character ? target.joint : null);
    }
    this.popups.setXZLocked(
      this.shiftDown && this.state.selected !== null && !isPositionLockedJoint(this.state.selected),
    );
  }

  private updateHover(e: { clientX: number; clientY: number }) {
    const view = this.popups.viewAt(e.clientX, e.clientY);
    if (view) {
      // Insets only offer the selected point.
      this.setRayFor(e, view);
      const target = this.widgets.target();
      const hit = this.hitsSelectedSphere();
      this.popups.setHovered(hit);
      this.setHovered(hit && target ? target : null, null);
      return;
    }
    this.popups.setHovered(false);
    this.setRay(e);
    const widget = this.pickWidget();
    this.setHovered(widget ? null : this.pickSphere(), widget);
  }

  /**
   * With always-show off, a character's points are drawn while the cursor is
   * within their on-screen bounds (padded), or while one of them is dragged.
   */
  private updateReveal(e: { clientX: number; clientY: number }) {
    if (this.state.alwaysShowPoints) return;
    const rect = this.canvas.getBoundingClientRect();
    const dragged = this.drag && 'character' in this.drag ? this.drag.character : null;
    const v = new THREE.Vector3();
    for (const character of this.scene.characters) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const mesh of character.points.meshes) {
        v.copy(mesh.position).project(this.camera);
        if (v.z > 1) continue; // behind the camera
        const x = rect.left + ((v.x + 1) / 2) * rect.width;
        const y = rect.top + ((1 - v.y) / 2) * rect.height;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      const inside = minX !== Infinity
        && e.clientX >= minX - REVEAL_MARGIN && e.clientX <= maxX + REVEAL_MARGIN
        && e.clientY >= minY - REVEAL_MARGIN && e.clientY <= maxY + REVEAL_MARGIN;
      character.points.setRevealed(inside || character === dragged);
    }
  }

  private onPointerDown = (e: PointerEvent) => {
    if (this.drag) return;

    const view = this.popups.viewAt(e.clientX, e.clientY);
    if (view) {
      this.onPopupPointerDown(e, view);
      return;
    }

    if (e.altKey && e.button === 0) {
      e.preventDefault();
      this.setHovered(null, null);
      this.drag = { mode: 'orbit', lastX: e.clientX, lastY: e.clientY };
      this.canvas.style.cursor = 'grabbing';
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button === 1) {
      e.preventDefault();
      this.setHovered(null, null);
      this.drag = { mode: 'pan', lastX: e.clientX, lastY: e.clientY };
      this.canvas.style.cursor = 'move';
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.altKey && e.button === 2) {
      e.preventDefault();
      this.setHovered(null, null);
      this.drag = { mode: 'zoom', lastX: e.clientX };
      this.canvas.style.cursor = 'ew-resize';
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;

    this.setRay(e);

    // Widgets of the selected node take priority over the control spheres.
    const withChildren = cascades(e);
    const widget = this.pickWidget();
    const target = this.widgets.target();
    if (target && widget) {
      const { character, joint } = target;
      this.beginPoseGesture();
      this.setHovered(null, widget);
      if (widget === 'helper') {
        this.drag = { mode: 'aim', character, joint, target: this.widgets.helperWorldPos(), withChildren };
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }
      this.drag = this.beginTwist(e, character, joint, withChildren);
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }

    const pick = this.pickSphere();
    if (!pick) {
      this.setHovered(null, null);
      if (e.button === 0) this.state.select(null);
      return;
    }
    const { character, joint } = pick;
    this.state.select(joint, character.id);
    this.setHovered(pick, null);
    if (isPositionLockedJoint(joint)) return;
    this.beginPoseGesture();

    const center = character.pose.get(joint).pos;
    const planeHit = this.shiftDown ? null : this.hitViewPlane(center);
    const grabOffset = planeHit ? new THREE.Vector3().subVectors(center, planeHit) : new THREE.Vector3();
    this.drag = {
      mode: withChildren ? 'subtree' : 'point',
      character,
      joint,
      grabOffset,
      view: null,
      xzLocked: this.shiftDown,
      lastX: e.clientX,
      lastY: e.clientY,
    };
    this.syncPlaneLock();
    this.canvas.setPointerCapture(e.pointerId);
  };

  private beginTwist(e: PointerEvent, character: Character, joint: JointId, withChildren: boolean): Drag {
    const axis = character.pose.forward(joint);
    const camDir = this.camera.getWorldDirection(new THREE.Vector3());
    // Ring edge-on to the camera: fall back to horizontal mouse movement.
    if (Math.abs(camDir.dot(axis)) < 0.25) {
      return { mode: 'twist-pixels', character, joint, lastX: e.clientX, withChildren };
    }
    const u = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, 1, 0));
    if (u.lengthSq() < 1e-6) u.set(1, 0, 0);
    u.normalize();
    const v = new THREE.Vector3().crossVectors(axis, u);
    const lastAngle = this.twistAngle(character, joint, axis, u, v) ?? 0;
    return { mode: 'twist', character, joint, axis, u, v, lastAngle, withChildren };
  }

  private twistAngle(character: Character, joint: JointId, axis: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3): number | null {
    const center = character.pose.get(joint).pos;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, center);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return null;
    hit.sub(center);
    return Math.atan2(hit.dot(v), hit.dot(u));
  }

  private onPointerMove = (e: PointerEvent) => {
    this.updateReveal(e);
    if (!this.drag) {
      this.updateHover(e);
      return;
    }

    const d = this.drag;
    if (d.mode === 'pan') {
      // Slide camera and target together along the view's right/up axes.
      const wpp = this.worldPerPixel();
      const dx = (e.clientX - d.lastX) * wpp;
      const dy = (e.clientY - d.lastY) * wpp;
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
      const move = right.multiplyScalar(-dx).addScaledVector(up, dy);
      this.camera.position.add(move);
      this.cameraTarget.add(move);
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      this.onSceneChanged();
      return;
    }
    if (d.mode === 'orbit') {
      this.orbit((e.clientX - d.lastX) * ORBIT_SPEED, (e.clientY - d.lastY) * ORBIT_SPEED);
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      this.onSceneChanged();
      return;
    }
    if (d.mode === 'zoom') {
      this.zoomByFactor(Math.exp((e.clientX - d.lastX) * ZOOM_DRAG_SPEED));
      d.lastX = e.clientX;
      return;
    }

    const pose = d.character.pose;

    if (d.mode === 'point' || d.mode === 'subtree') {
      // Point drags may live in an inset; everything else is main-view only.
      this.setRayFor(e, d.view);
      if (d.xzLocked !== this.shiftDown) {
        d.xzLocked = this.shiftDown;
        d.lastX = e.clientX;
        d.lastY = e.clientY;
        if (!d.xzLocked) {
          const center = pose.get(d.joint).pos;
          const planeHit = this.hitViewPlane(center, this.cameraFor(d.view));
          d.grabOffset.copy(planeHit ? center.clone().sub(planeHit) : new THREE.Vector3());
        }
        return;
      }
      if (d.xzLocked) {
        const move = this.xzDragDelta(e, d);
        if (move.lengthSq() === 0) return;
        pose.translate(d.joint, move, d.mode === 'subtree');
        this.applyCharacter(d.character);
        return;
      }
      const hit = this.hitViewPlane(pose.get(d.joint).pos, this.cameraFor(d.view));
      if (!hit) return;
      pose.moveTo(d.joint, hit.add(d.grabOffset), d.mode === 'subtree');
      this.applyCharacter(d.character);
      return;
    }

    this.setRay(e);
    if (d.mode === 'aim') {
      const hit = this.hitViewPlane(d.target);
      if (!hit) return;
      d.target.copy(hit);
      pose.aimAt(d.joint, d.target, d.withChildren);
      this.applyCharacter(d.character);
    } else if (d.mode === 'twist') {
      const angle = this.twistAngle(d.character, d.joint, d.axis, d.u, d.v);
      if (angle === null) return;
      let delta = angle - d.lastAngle;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      d.lastAngle = angle;
      pose.twist(d.joint, delta, d.withChildren);
      this.applyCharacter(d.character);
    } else if (d.mode === 'twist-pixels') {
      const delta = (e.clientX - d.lastX) * 0.01;
      d.lastX = e.clientX;
      pose.twist(d.joint, delta, d.withChildren);
      this.applyCharacter(d.character);
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.drag) return;
    const finished = this.drag;
    this.drag = null;
    this.syncPlaneLock();
    if (
      finished.mode === 'point' ||
      finished.mode === 'subtree' ||
      finished.mode === 'aim' ||
      finished.mode === 'twist' ||
      finished.mode === 'twist-pixels'
    ) {
      this.commitPoseGesture();
    }
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.updateReveal(e);
    this.updateHover(e);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const notch = Math.sign(e.deltaY);
    if (notch === 0) return;
    const d = this.drag;

    // Over an inset the wheel zooms both insets (unless a main-view drag is mid-depth-move).
    const view = this.popups.viewAt(e.clientX, e.clientY);
    if (view && !(d && 'view' in d && d.view === null)) {
      this.popups.zoom(Math.pow(1.12, notch));
      return;
    }

    // Wheel-up brings the point toward the camera, wheel-down pushes it away
    // (along the view direction, so this stays "depth" from any orbit angle).
    const depthStep = this.camera
      .getWorldDirection(new THREE.Vector3())
      .multiplyScalar(notch * Z_STEP * detailScale(this.state.activeView));
    if (this.shiftDown && depthStep.lengthSq() > 1e-10) {
      const length = depthStep.length();
      depthStep.y = 0;
      if (depthStep.lengthSq() > 1e-10) depthStep.setLength(length);
    }
    if (d && (d.mode === 'point' || d.mode === 'subtree')) {
      d.character.pose.translate(d.joint, depthStep, d.mode === 'subtree');
      this.applyCharacter(d.character);
      return;
    }
    if (d && d.mode === 'aim') {
      d.target.add(depthStep);
      d.character.pose.aimAt(d.joint, d.target, d.withChildren);
      this.applyCharacter(d.character);
      return;
    }
    if (d) return; // no zoom mid-twist/pan

    // No drag: zoom the canvas.
    this.zoomByFactor(Math.pow(1.12, notch));
  };

  private zoomByFactor(factor: number) {
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.cameraTarget);
    offset.setLength(THREE.MathUtils.clamp(offset.length() * factor, 0.08, 20));
    this.camera.position.copy(this.cameraTarget).add(offset);
    this.onSceneChanged();
  }

  /**
   * Tumble the camera about its target: yaw around world up, pitch around
   * the camera's right axis, pitch clamped short of the poles so the view
   * never flips (Maya/Unity alt-drag behaviour). Dragging right orbits the
   * camera to the right, i.e. the scene appears to turn left.
   */
  private orbit(dYaw: number, dPitch: number) {
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.cameraTarget);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= dYaw;
    spherical.phi = THREE.MathUtils.clamp(
      spherical.phi - dPitch,
      Math.PI / 2 - ORBIT_PITCH_LIMIT,
      Math.PI / 2 + ORBIT_PITCH_LIMIT,
    );
    offset.setFromSpherical(spherical);
    this.camera.position.copy(this.cameraTarget).add(offset);
    this.camera.lookAt(this.cameraTarget);
    this.camera.updateMatrixWorld();
  }

  /** World units per screen pixel at the camera target's depth. */
  private worldPerPixel(): number {
    const dist = this.camera.position.distanceTo(this.cameraTarget);
    const viewHeight = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    return viewHeight / this.canvas.clientHeight;
  }

  private xzDragDelta(
    e: { clientX: number; clientY: number },
    drag: Extract<Drag, { mode: 'point' | 'subtree' }>,
  ): THREE.Vector3 {
    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    if (dx === 0 && dy === 0) return new THREE.Vector3();

    const camera = this.cameraFor(drag.view);
    const point = drag.character.pose.get(drag.joint).pos;
    const viewportHeight = drag.view
      ? this.popups.rects()?.[drag.view].size ?? this.canvas.clientHeight
      : this.canvas.clientHeight;
    const distance = camera.position.distanceTo(point);
    const viewHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const worldPerPixel = viewHeight / Math.max(1, viewportHeight);

    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    right.y = 0;
    if (right.lengthSq() > 1e-10) right.normalize();

    const vertical = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    vertical.y = 0;
    if (vertical.lengthSq() < 1e-6) {
      camera.getWorldDirection(vertical);
      vertical.y = 0;
    }
    if (vertical.lengthSq() > 1e-10) vertical.normalize();

    return right.multiplyScalar(dx * worldPerPixel).addScaledVector(vertical, -dy * worldPerPixel);
  }
}
