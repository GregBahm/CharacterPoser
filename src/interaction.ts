import * as THREE from 'three';
import { CharacterRig } from './rig.ts';
import { CONTROL_JOINTS, CONTROL_JOINTS_BY_VIEW, ControlView, JointId, PoseGraph } from './pose.ts';
import { AppState, COLORS, pointColor } from './state.ts';

/** Shift (or the right mouse button) makes a manipulation carry the node's subtree. */
function cascades(e: PointerEvent): boolean {
  return e.shiftKey || e.button === 2;
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

function detailScale(view: ControlView): number {
  return view === 'body' ? 1 : view === 'face' ? 0.18 : 0.13;
}

/** Draggable control-point spheres drawn on top of the character. */
export class ControlPoints {
  group = new THREE.Group();
  private spheres = new Map<JointId, THREE.Mesh>();

  constructor(
    private pose: PoseGraph,
    private state: AppState,
  ) {
    const geo = new THREE.SphereGeometry(1, 20, 14);
    for (const id of CONTROL_JOINTS) {
      const mat = new THREE.MeshBasicMaterial({
        color: COLORS.free,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      });
      const sphere = new THREE.Mesh(geo, mat);
      sphere.renderOrder = 10;
      sphere.userData.jointId = id;
      this.spheres.set(id, sphere);
      this.group.add(sphere);
    }
  }

  update() {
    const visible = new Set(CONTROL_JOINTS_BY_VIEW[this.state.activeView]);
    const detailSize = this.state.activeView === 'face' ? 0.006 : 0.005;
    for (const [id, sphere] of this.spheres) {
      sphere.visible = visible.has(id);
      const anchor = id === 'Head' || id === 'LeftHand' || id === 'RightHand';
      sphere.scale.setScalar(this.state.activeView === 'body' ? 0.024 : anchor ? 0.009 : detailSize);
      sphere.position.copy(this.pose.get(id).pos);
      (sphere.material as THREE.MeshBasicMaterial).color.setHex(pointColor(this.state.selected === id));
    }
  }

  get meshes(): THREE.Mesh[] {
    return [...this.spheres.values()].filter((sphere) => sphere.visible);
  }
}

/**
 * The helper widgets shown for the selected node, in the node's local frame:
 * the twist ring lies perpendicular to the node's aim, the direction helper
 * floats in front of the node along its current aim, and a passive stretch
 * ring (coplanar with the twist ring) shows how far the segment ending at
 * this node is from its natural length: its radius is the twist ring's
 * radius times the stretch factor, so it coincides with (hides behind) the
 * twist ring at natural length, grows when longer, shrinks when shorter.
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

  constructor(
    private pose: PoseGraph,
    private state: AppState,
  ) {
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 10, 48),
      new THREE.MeshBasicMaterial({ color: COLORS.ring, depthTest: false, transparent: true, opacity: 0.85 }),
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

  /** Rebuild the stretch ring's torus so its tube stays constant while the radius changes. */
  private setStretchRingRadius(radius: number) {
    radius = Math.max(radius, RING_TUBE);
    if (Math.abs(radius - this.stretchRingRadius) < 1e-4) return;
    this.stretchRingRadius = radius;
    this.stretchRing.geometry.dispose();
    this.stretchRing.geometry = new THREE.TorusGeometry(radius, RING_TUBE, 10, 48);
  }

  helperWorldPos(target = new THREE.Vector3()): THREE.Vector3 {
    const id = this.state.selected!;
    const node = this.pose.get(id);
    return this.pose.forward(id, target).multiplyScalar(HELPER_OFFSET * this.widgetScale()).add(node.pos);
  }

  private widgetScale(): number {
    return detailScale(this.state.activeView);
  }

  update() {
    const id = this.state.selected;
    this.group.visible = id !== null;
    if (!id) return;
    const node = this.pose.get(id);
    const scale = this.widgetScale();

    // Torus axis is +Z, so the node's quat tips it perpendicular to the aim.
    this.ring.position.copy(node.pos);
    this.ring.quaternion.copy(node.quat);
    this.ring.scale.setScalar(scale);
    this.ringPick.position.copy(node.pos);
    this.ringPick.quaternion.copy(node.quat);
    this.ringPick.scale.setScalar(scale);

    this.stretchRing.visible = this.pose.hasStretchSegment(id);
    this.stretchRing.position.copy(node.pos);
    this.stretchRing.quaternion.copy(node.quat);
    this.stretchRing.scale.setScalar(scale);
    this.setStretchRingRadius(RING_RADIUS * this.pose.segmentStretch(id));

    const helperPos = this.helperWorldPos();
    this.helper.position.copy(helperPos);
    this.helper.scale.setScalar(scale);
    this.helperPick.position.copy(helperPos);
    this.helperPick.scale.setScalar(scale);

    this.linePositions.set([node.pos.x, node.pos.y, node.pos.z, helperPos.x, helperPos.y, helperPos.z]);
    (this.line.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}

type Drag =
  | { mode: 'point' | 'subtree'; joint: JointId; grabOffset: THREE.Vector3 }
  | { mode: 'aim'; joint: JointId; target: THREE.Vector3; withChildren: boolean }
  | { mode: 'twist'; joint: JointId; axis: THREE.Vector3; u: THREE.Vector3; v: THREE.Vector3; lastAngle: number; withChildren: boolean }
  | { mode: 'twist-pixels'; joint: JointId; lastX: number; withChildren: boolean }
  | { mode: 'pan'; lastX: number; lastY: number }
  | { mode: 'orbit'; lastX: number; lastY: number }
  | { mode: 'zoom'; lastX: number };

/**
 * Pointer handling for the canvas. By default a manipulation affects the
 * local node only; holding Shift (or using the right mouse button) cascades
 * it down the body, carrying the whole subtree as if parented to the node —
 * for point drags and widget drags alike:
 *  - drag a point: move it in the view XY plane
 *  - mousewheel while dragging: move in z-space instead
 *  - drag the selected node's twist ring / direction helper: rotate it
 *  - Alt + left-drag: orbit; middle-drag: pan; Alt + right-drag:
 *    zoom; mousewheel (no drag): zoom
 */
export class Interaction {
  private canvas: HTMLCanvasElement;
  private camera: THREE.PerspectiveCamera;
  private cameraTarget: THREE.Vector3;
  private rig: CharacterRig;
  private pose: PoseGraph;
  private state: AppState;
  private points: ControlPoints;
  private widgets: Widgets;
  private raycaster = new THREE.Raycaster();
  private drag: Drag | null = null;

  constructor(opts: {
    canvas: HTMLCanvasElement;
    camera: THREE.PerspectiveCamera;
    cameraTarget: THREE.Vector3;
    rig: CharacterRig;
    pose: PoseGraph;
    state: AppState;
    points: ControlPoints;
    widgets: Widgets;
  }) {
    this.canvas = opts.canvas;
    this.camera = opts.camera;
    this.cameraTarget = opts.cameraTarget;
    this.rig = opts.rig;
    this.pose = opts.pose;
    this.state = opts.state;
    this.points = opts.points;
    this.widgets = opts.widgets;

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // Stop middle-click autoscroll.
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
  }

  /** Called every frame. */
  update() {
    this.points.update();
    this.widgets.update();
  }

  applyPose() {
    this.rig.applyPose(this.pose.solveSkeleton());
  }

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

  /** Intersect the current ray with the view-parallel plane through `point`. */
  private hitViewPlane(point: THREE.Vector3): THREE.Vector3 | null {
    const normal = this.camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, out) ? out : null;
  }

  private pickSphere(): JointId | null {
    // Control spheres ignore depth, so pick the sphere nearest the ray, not the first hit.
    let best: { joint: JointId; dist: number } | null = null;
    for (const hit of this.raycaster.intersectObjects(this.points.meshes, false)) {
      const joint = hit.object.userData.jointId as JointId;
      if (!best || hit.distance < best.dist) best = { joint, dist: hit.distance };
    }
    return best ? best.joint : null;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (this.drag) return;

    if (e.altKey && e.button === 0) {
      e.preventDefault();
      this.drag = { mode: 'orbit', lastX: e.clientX, lastY: e.clientY };
      this.canvas.style.cursor = 'grabbing';
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button === 1) {
      e.preventDefault();
      this.drag = { mode: 'pan', lastX: e.clientX, lastY: e.clientY };
      this.canvas.style.cursor = 'move';
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.altKey && e.button === 2) {
      e.preventDefault();
      this.drag = { mode: 'zoom', lastX: e.clientX };
      this.canvas.style.cursor = 'ew-resize';
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;

    this.setRay(e);

    // Widgets of the selected node take priority over the control spheres.
    const withChildren = cascades(e);
    if (this.state.selected) {
      const joint = this.state.selected;
      if (this.raycaster.intersectObject(this.widgets.helperPick, false).length > 0) {
        this.drag = { mode: 'aim', joint, target: this.widgets.helperWorldPos(), withChildren };
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }
      if (this.raycaster.intersectObject(this.widgets.ringPick, false).length > 0) {
        this.drag = this.beginTwist(e, joint, withChildren);
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }
    }

    const joint = this.pickSphere();
    if (!joint) {
      if (e.button === 0) this.state.select(null);
      return;
    }
    this.state.select(joint);

    const center = this.pose.get(joint).pos;
    const planeHit = this.hitViewPlane(center);
    const grabOffset = planeHit ? new THREE.Vector3().subVectors(center, planeHit) : new THREE.Vector3();
    this.drag = { mode: withChildren ? 'subtree' : 'point', joint, grabOffset };
    this.canvas.setPointerCapture(e.pointerId);
  };

  private beginTwist(e: PointerEvent, joint: JointId, withChildren: boolean): Drag {
    const axis = this.pose.forward(joint);
    const camDir = this.camera.getWorldDirection(new THREE.Vector3());
    // Ring edge-on to the camera: fall back to horizontal mouse movement.
    if (Math.abs(camDir.dot(axis)) < 0.25) {
      return { mode: 'twist-pixels', joint, lastX: e.clientX, withChildren };
    }
    const u = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, 1, 0));
    if (u.lengthSq() < 1e-6) u.set(1, 0, 0);
    u.normalize();
    const v = new THREE.Vector3().crossVectors(axis, u);
    return { mode: 'twist', joint, axis, u, v, lastAngle: this.twistAngle(joint, axis, u, v) ?? 0, withChildren };
  }

  private twistAngle(joint: JointId, axis: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3): number | null {
    const center = this.pose.get(joint).pos;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, center);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return null;
    hit.sub(center);
    return Math.atan2(hit.dot(v), hit.dot(u));
  }

  private onPointerMove = (e: PointerEvent) => {
    if (!this.drag) {
      this.setRay(e);
      let hover = this.pickSphere() !== null;
      if (!hover && this.state.selected) {
        hover =
          this.raycaster.intersectObject(this.widgets.helperPick, false).length > 0 ||
          this.raycaster.intersectObject(this.widgets.ringPick, false).length > 0;
      }
      this.canvas.style.cursor = hover ? 'grab' : 'default';
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
      return;
    }
    if (d.mode === 'orbit') {
      this.orbit((e.clientX - d.lastX) * ORBIT_SPEED, (e.clientY - d.lastY) * ORBIT_SPEED);
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      return;
    }
    if (d.mode === 'zoom') {
      this.zoomByFactor(Math.exp((e.clientX - d.lastX) * ZOOM_DRAG_SPEED));
      d.lastX = e.clientX;
      return;
    }

    this.setRay(e);

    if (d.mode === 'point' || d.mode === 'subtree') {
      const hit = this.hitViewPlane(this.pose.get(d.joint).pos);
      if (!hit) return;
      this.pose.moveTo(d.joint, hit.add(d.grabOffset), d.mode === 'subtree');
      this.applyPose();
    } else if (d.mode === 'aim') {
      const hit = this.hitViewPlane(d.target);
      if (!hit) return;
      d.target.copy(hit);
      this.pose.aimAt(d.joint, d.target, d.withChildren);
      this.applyPose();
    } else if (d.mode === 'twist') {
      const angle = this.twistAngle(d.joint, d.axis, d.u, d.v);
      if (angle === null) return;
      let delta = angle - d.lastAngle;
      if (delta > Math.PI) delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      d.lastAngle = angle;
      this.pose.twist(d.joint, delta, d.withChildren);
      this.applyPose();
    } else if (d.mode === 'twist-pixels') {
      const delta = (e.clientX - d.lastX) * 0.01;
      d.lastX = e.clientX;
      this.pose.twist(d.joint, delta, d.withChildren);
      this.applyPose();
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.drag) return;
    this.drag = null;
    this.canvas.style.cursor = 'default';
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const notch = Math.sign(e.deltaY);
    if (notch === 0) return;
    const d = this.drag;

    // Wheel-up brings the point toward the camera, wheel-down pushes it away
    // (along the view direction, so this stays "depth" from any orbit angle).
    const depthStep = this.camera
      .getWorldDirection(new THREE.Vector3())
      .multiplyScalar(notch * Z_STEP * detailScale(this.state.activeView));
    if (d && (d.mode === 'point' || d.mode === 'subtree')) {
      this.pose.translate(d.joint, depthStep, d.mode === 'subtree');
      this.applyPose();
      return;
    }
    if (d && d.mode === 'aim') {
      d.target.add(depthStep);
      this.pose.aimAt(d.joint, d.target, d.withChildren);
      this.applyPose();
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
}
