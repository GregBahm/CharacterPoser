import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CharacterRig } from './rig.ts';
import { CONTROL_JOINTS, ROTATABLE_JOINTS, JointId } from './solver.ts';
import { AppState, COLORS } from './state.ts';
import { PanelManager } from './panels.ts';

/** Draggable control-point spheres drawn on top of the character. */
export class ControlPoints {
  group = new THREE.Group();
  private spheres = new Map<JointId, THREE.Mesh>();
  private rig: CharacterRig;
  private state: AppState;

  constructor(rig: CharacterRig, state: AppState) {
    this.rig = rig;
    this.state = state;
    const geo = new THREE.SphereGeometry(0.028, 20, 14);
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
    for (const [id, sphere] of this.spheres) {
      this.rig.getJointWorldPos(id, sphere.position);
      const pinned = this.rig.solver.get(id).pinned;
      const selected = this.state.selected === id;
      const mat = sphere.material as THREE.MeshBasicMaterial;
      mat.color.setHex(
        selected && pinned
          ? COLORS.selectedPinned
          : selected
            ? COLORS.selected
            : pinned
              ? COLORS.pinned
              : COLORS.free,
      );
    }
  }

  get meshes(): THREE.Mesh[] {
    return [...this.spheres.values()];
  }
}

interface ActiveDrag {
  joint: JointId;
  camera: THREE.Camera;
  rect: DOMRect;
  plane: THREE.Plane;
}

/**
 * Pointer handling across the main view and all floating panels: picking,
 * IK dragging, and the rotate tool for head/hands/feet.
 */
export class Interaction {
  private canvas: HTMLCanvasElement;
  private mainCamera: THREE.Camera;
  private panels: PanelManager;
  private rig: CharacterRig;
  private state: AppState;
  private points: ControlPoints;
  private raycaster = new THREE.Raycaster();
  private drag: ActiveDrag | null = null;
  private transform: TransformControls;
  private proxy = new THREE.Object3D();

  constructor(opts: {
    canvas: HTMLCanvasElement;
    scene: THREE.Scene;
    mainCamera: THREE.Camera;
    panels: PanelManager;
    rig: CharacterRig;
    state: AppState;
    points: ControlPoints;
  }) {
    this.canvas = opts.canvas;
    this.mainCamera = opts.mainCamera;
    this.panels = opts.panels;
    this.rig = opts.rig;
    this.state = opts.state;
    this.points = opts.points;

    opts.scene.add(this.proxy);
    this.transform = new TransformControls(opts.mainCamera, opts.canvas);
    this.transform.setMode('rotate');
    this.transform.setSize(0.6);
    this.transform.enabled = false;
    opts.scene.add(this.transform.getHelper());
    this.transform.addEventListener('objectChange', () => {
      if (!this.state.selected) return;
      this.rig.setOrientOverride(this.state.selected, this.proxy.quaternion);
      this.rig.applyPose();
    });

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);

    this.state.onChange(() => this.syncRotateTool());
  }

  /** Called every frame after pose updates. */
  update() {
    this.points.update();
    if (!this.transform.dragging && this.state.selected && this.rotateActive()) {
      this.syncProxyToJoint();
    }
  }

  private rotateActive(): boolean {
    return (
      this.state.rotateMode &&
      this.state.selected !== null &&
      ROTATABLE_JOINTS.includes(this.state.selected)
    );
  }

  private syncRotateTool() {
    const active = this.rotateActive();
    this.transform.enabled = active;
    if (active) {
      this.syncProxyToJoint();
      this.transform.attach(this.proxy);
    } else {
      this.transform.detach();
    }
  }

  private syncProxyToJoint() {
    const id = this.state.selected!;
    this.rig.getJointWorldPos(id, this.proxy.position);
    this.rig.getJointWorldQuat(id, this.proxy.quaternion);
  }

  private viewUnder(e: PointerEvent): { camera: THREE.Camera; rect: DOMRect } {
    const panel = this.panels.panelAt(e.clientX, e.clientY);
    if (panel) return { camera: panel.camera, rect: panel.content.getBoundingClientRect() };
    return { camera: this.mainCamera, rect: this.canvas.getBoundingClientRect() };
  }

  private ndc(e: PointerEvent, rect: DOMRect): THREE.Vector2 {
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  private pickJoint(e: PointerEvent): { joint: JointId; point: THREE.Vector3; camera: THREE.Camera; rect: DOMRect } | null {
    const { camera, rect } = this.viewUnder(e);
    this.raycaster.setFromCamera(this.ndc(e, rect), camera);
    // Control spheres ignore depth, so pick the sphere nearest the ray, not the first hit.
    let best: { joint: JointId; point: THREE.Vector3; dist: number } | null = null;
    for (const hit of this.raycaster.intersectObjects(this.points.meshes, false)) {
      const joint = hit.object.userData.jointId as JointId;
      if (!best || hit.distance < best.dist) best = { joint, point: hit.point, dist: hit.distance };
    }
    return best ? { joint: best.joint, point: best.point, camera, rect } : null;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    // Let the rotate gizmo take priority when the pointer is over it.
    if (this.rotateActive() && this.transform.axis !== null) return;

    const hit = this.pickJoint(e);
    if (!hit) return;
    this.state.select(hit.joint);

    const center = this.rig.getJointWorldPos(hit.joint, new THREE.Vector3());
    const normal = new THREE.Vector3();
    hit.camera.getWorldDirection(normal);
    this.drag = {
      joint: hit.joint,
      camera: hit.camera,
      rect: hit.rect,
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center),
    };
    this.canvas.setPointerCapture(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.drag) {
      if (!(this.rotateActive() && this.transform.axis !== null)) {
        this.canvas.style.cursor = this.pickJoint(e) ? 'grab' : 'default';
      }
      return;
    }
    this.raycaster.setFromCamera(this.ndc(e, this.drag.rect), this.drag.camera);
    const target = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.drag.plane, target)) return;

    const joint = this.rig.solver.get(this.drag.joint);
    this.rig.solver.solve(new Map([[this.drag.joint, target]]));
    if (joint.pinned) joint.pinPos.copy(joint.pos);
    this.rig.applyPose();
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.drag) return;
    const joint = this.rig.solver.get(this.drag.joint);
    if (joint.pinned) joint.pinPos.copy(joint.pos);
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  };
}
