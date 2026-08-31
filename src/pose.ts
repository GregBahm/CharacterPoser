import * as THREE from 'three';

/** All body, finger, and facial joints used to drive the mesh. */
export type JointId =
  | 'Hips'
  | 'Spine'
  | 'Spine1'
  | 'Spine2'
  | 'Neck'
  | 'Head'
  | 'LeftShoulder'
  | 'LeftArm'
  | 'LeftForeArm'
  | 'LeftHand'
  | 'RightShoulder'
  | 'RightArm'
  | 'RightForeArm'
  | 'RightHand'
  | 'LeftUpLeg'
  | 'LeftLeg'
  | 'LeftFoot'
  | 'RightUpLeg'
  | 'RightLeg'
  | 'RightFoot'
  | 'LeftThumb1'
  | 'LeftThumb2'
  | 'LeftThumb3'
  | 'LeftIndex1'
  | 'LeftIndex2'
  | 'LeftIndex3'
  | 'LeftMiddle1'
  | 'LeftMiddle2'
  | 'LeftMiddle3'
  | 'LeftRing1'
  | 'LeftRing2'
  | 'LeftRing3'
  | 'LeftPinky1'
  | 'LeftPinky2'
  | 'LeftPinky3'
  | 'RightThumb1'
  | 'RightThumb2'
  | 'RightThumb3'
  | 'RightIndex1'
  | 'RightIndex2'
  | 'RightIndex3'
  | 'RightMiddle1'
  | 'RightMiddle2'
  | 'RightMiddle3'
  | 'RightRing1'
  | 'RightRing2'
  | 'RightRing3'
  | 'RightPinky1'
  | 'RightPinky2'
  | 'RightPinky3'
  | 'Jaw'
  | 'LeftEye'
  | 'RightEye'
  | 'LeftBrow'
  | 'RightBrow'
  | 'LeftMouthCorner'
  | 'RightMouthCorner';

export type ControlView = 'body' | 'leftHand' | 'rightHand' | 'face';

export interface JointDef {
  id: JointId;
  parent: JointId | null;
}

/** Skeleton hierarchy, listed parent-before-child. */
export const JOINT_DEFS: JointDef[] = [
  { id: 'Hips', parent: null },
  { id: 'Spine', parent: 'Hips' },
  { id: 'Spine1', parent: 'Spine' },
  { id: 'Spine2', parent: 'Spine1' },
  { id: 'Neck', parent: 'Spine2' },
  { id: 'Head', parent: 'Neck' },
  { id: 'LeftShoulder', parent: 'Spine2' },
  { id: 'LeftArm', parent: 'LeftShoulder' },
  { id: 'LeftForeArm', parent: 'LeftArm' },
  { id: 'LeftHand', parent: 'LeftForeArm' },
  { id: 'RightShoulder', parent: 'Spine2' },
  { id: 'RightArm', parent: 'RightShoulder' },
  { id: 'RightForeArm', parent: 'RightArm' },
  { id: 'RightHand', parent: 'RightForeArm' },
  { id: 'LeftUpLeg', parent: 'Hips' },
  { id: 'LeftLeg', parent: 'LeftUpLeg' },
  { id: 'LeftFoot', parent: 'LeftLeg' },
  { id: 'RightUpLeg', parent: 'Hips' },
  { id: 'RightLeg', parent: 'RightUpLeg' },
  { id: 'RightFoot', parent: 'RightLeg' },
  { id: 'LeftThumb1', parent: 'LeftHand' },
  { id: 'LeftThumb2', parent: 'LeftThumb1' },
  { id: 'LeftThumb3', parent: 'LeftThumb2' },
  { id: 'LeftIndex1', parent: 'LeftHand' },
  { id: 'LeftIndex2', parent: 'LeftIndex1' },
  { id: 'LeftIndex3', parent: 'LeftIndex2' },
  { id: 'LeftMiddle1', parent: 'LeftHand' },
  { id: 'LeftMiddle2', parent: 'LeftMiddle1' },
  { id: 'LeftMiddle3', parent: 'LeftMiddle2' },
  { id: 'LeftRing1', parent: 'LeftHand' },
  { id: 'LeftRing2', parent: 'LeftRing1' },
  { id: 'LeftRing3', parent: 'LeftRing2' },
  { id: 'LeftPinky1', parent: 'LeftHand' },
  { id: 'LeftPinky2', parent: 'LeftPinky1' },
  { id: 'LeftPinky3', parent: 'LeftPinky2' },
  { id: 'RightThumb1', parent: 'RightHand' },
  { id: 'RightThumb2', parent: 'RightThumb1' },
  { id: 'RightThumb3', parent: 'RightThumb2' },
  { id: 'RightIndex1', parent: 'RightHand' },
  { id: 'RightIndex2', parent: 'RightIndex1' },
  { id: 'RightIndex3', parent: 'RightIndex2' },
  { id: 'RightMiddle1', parent: 'RightHand' },
  { id: 'RightMiddle2', parent: 'RightMiddle1' },
  { id: 'RightMiddle3', parent: 'RightMiddle2' },
  { id: 'RightRing1', parent: 'RightHand' },
  { id: 'RightRing2', parent: 'RightRing1' },
  { id: 'RightRing3', parent: 'RightRing2' },
  { id: 'RightPinky1', parent: 'RightHand' },
  { id: 'RightPinky2', parent: 'RightPinky1' },
  { id: 'RightPinky3', parent: 'RightPinky2' },
  { id: 'Jaw', parent: 'Head' },
  { id: 'LeftEye', parent: 'Head' },
  { id: 'RightEye', parent: 'Head' },
  { id: 'LeftBrow', parent: 'Head' },
  { id: 'RightBrow', parent: 'Head' },
  { id: 'LeftMouthCorner', parent: 'Head' },
  { id: 'RightMouthCorner', parent: 'Head' },
];

/** Skeleton parent of each joint. */
export const JOINT_PARENT: Record<JointId, JointId | null> = Object.fromEntries(
  JOINT_DEFS.map((d) => [d.id, d.parent]),
) as Record<JointId, JointId | null>;

/** The 13 user-facing control points (OpenPose-style body). */
export const BODY_CONTROL_JOINTS: JointId[] = [
  'Hips',
  'Spine2',
  'Head',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'RightArm',
  'RightForeArm',
  'RightHand',
  'LeftLeg',
  'LeftFoot',
  'RightLeg',
  'RightFoot',
];

export const LEFT_HAND_JOINTS: JointId[] = [
  'LeftThumb1', 'LeftThumb2', 'LeftThumb3',
  'LeftIndex1', 'LeftIndex2', 'LeftIndex3',
  'LeftMiddle1', 'LeftMiddle2', 'LeftMiddle3',
  'LeftRing1', 'LeftRing2', 'LeftRing3',
  'LeftPinky1', 'LeftPinky2', 'LeftPinky3',
];

export const RIGHT_HAND_JOINTS: JointId[] = [
  'RightThumb1', 'RightThumb2', 'RightThumb3',
  'RightIndex1', 'RightIndex2', 'RightIndex3',
  'RightMiddle1', 'RightMiddle2', 'RightMiddle3',
  'RightRing1', 'RightRing2', 'RightRing3',
  'RightPinky1', 'RightPinky2', 'RightPinky3',
];

/**
 * The facial bones of the Renderpeople rigs, each driven as its own control
 * point. The rigs' eyelid bones are left out: they pivot exactly where the
 * eye bones do, so their control points would sit on top of the eyes'.
 */
export const FACE_JOINTS: JointId[] = [
  'Jaw',
  'LeftEye',
  'RightEye',
  'LeftBrow',
  'RightBrow',
  'LeftMouthCorner',
  'RightMouthCorner',
];

export const DETAIL_JOINTS: JointId[] = [...LEFT_HAND_JOINTS, ...RIGHT_HAND_JOINTS, ...FACE_JOINTS];
export const FINGER_JOINTS: JointId[] = [...LEFT_HAND_JOINTS, ...RIGHT_HAND_JOINTS];
export const CONTROL_JOINTS: JointId[] = [...BODY_CONTROL_JOINTS, ...DETAIL_JOINTS];

export const CONTROL_JOINTS_BY_VIEW: Record<ControlView, JointId[]> = {
  body: BODY_CONTROL_JOINTS,
  leftHand: ['LeftHand', ...LEFT_HAND_JOINTS],
  rightHand: ['RightHand', ...RIGHT_HAND_JOINTS],
  face: ['Head', ...FACE_JOINTS],
};

const DETAIL_JOINT_SET = new Set(DETAIL_JOINTS);
const FINGER_JOINT_SET = new Set(FINGER_JOINTS);

export function isDetailJoint(id: JointId): boolean {
  return DETAIL_JOINT_SET.has(id);
}

export function isFingerJoint(id: JointId): boolean {
  return FINGER_JOINT_SET.has(id);
}

/**
 * Eyes only aim: they can't be dragged out of the head or twisted, and they
 * aim together — a rotation applied to one is applied to the other.
 */
const AIM_LINKED: Partial<Record<JointId, JointId>> = { LeftEye: 'RightEye', RightEye: 'LeftEye' };

export function isAimOnlyJoint(id: JointId): boolean {
  return id in AIM_LINKED;
}

/**
 * Parent of each control point in the *control* tree from the design doc.
 * This skips over the non-control skeleton joints (spine mids, clavicles,
 * hip sockets), e.g. a knee's control parent is the Hips.
 */
export const CONTROL_PARENT: Partial<Record<JointId, JointId | null>> = {
  Hips: null,
  Spine2: 'Hips',
  Head: 'Spine2',
  LeftArm: 'Spine2',
  LeftForeArm: 'LeftArm',
  LeftHand: 'LeftForeArm',
  RightArm: 'Spine2',
  RightForeArm: 'RightArm',
  RightHand: 'RightForeArm',
  LeftLeg: 'Hips',
  LeftFoot: 'LeftLeg',
  RightLeg: 'Hips',
  RightFoot: 'RightLeg',
  LeftThumb1: 'LeftHand',
  LeftThumb2: 'LeftThumb1',
  LeftThumb3: 'LeftThumb2',
  LeftIndex1: 'LeftHand',
  LeftIndex2: 'LeftIndex1',
  LeftIndex3: 'LeftIndex2',
  LeftMiddle1: 'LeftHand',
  LeftMiddle2: 'LeftMiddle1',
  LeftMiddle3: 'LeftMiddle2',
  LeftRing1: 'LeftHand',
  LeftRing2: 'LeftRing1',
  LeftRing3: 'LeftRing2',
  LeftPinky1: 'LeftHand',
  LeftPinky2: 'LeftPinky1',
  LeftPinky3: 'LeftPinky2',
  RightThumb1: 'RightHand',
  RightThumb2: 'RightThumb1',
  RightThumb3: 'RightThumb2',
  RightIndex1: 'RightHand',
  RightIndex2: 'RightIndex1',
  RightIndex3: 'RightIndex2',
  RightMiddle1: 'RightHand',
  RightMiddle2: 'RightMiddle1',
  RightMiddle3: 'RightMiddle2',
  RightRing1: 'RightHand',
  RightRing2: 'RightRing1',
  RightRing3: 'RightRing2',
  RightPinky1: 'RightHand',
  RightPinky2: 'RightPinky1',
  RightPinky3: 'RightPinky2',
  Jaw: 'Head',
  LeftEye: 'Head',
  RightEye: 'Head',
  LeftBrow: 'Head',
  RightBrow: 'Head',
  LeftMouthCorner: 'Head',
  RightMouthCorner: 'Head',
};


/**
 * Non-control skeleton joints that ride rigidly on a control point: their
 * bind offset from the base is rotated by the base's orientation.
 */
const RIGID_ATTACH: { joint: JointId; base: JointId }[] = [
  { joint: 'LeftUpLeg', base: 'Hips' },
  { joint: 'RightUpLeg', base: 'Hips' },
  { joint: 'Neck', base: 'Spine2' },
  { joint: 'LeftShoulder', base: 'Spine2' },
  { joint: 'RightShoulder', base: 'Spine2' },
];

/** Every node's aim direction at bind: the character faces world +Z. */
const BIND_FORWARD = new THREE.Vector3(0, 0, 1);

export interface ControlNode {
  id: JointId;
  parent: ControlNode | null;
  children: ControlNode[];
  /** World position — this IS the pose state. */
  pos: THREE.Vector3;
  /** Accumulated world-space rotation away from bind (identity at rest). */
  quat: THREE.Quaternion;
  bindPos: THREE.Vector3;
}

/** World positions + per-joint rotation deltas for the full 20-joint skeleton. */
export interface SolvedSkeleton {
  pos: Map<JointId, THREE.Vector3>;
  rot: Map<JointId, THREE.Quaternion>;
}

/**
 * The pose is a tree of free-floating control points, manipulated directly
 * (no IK): translate a point alone or with its subtree, aim a point's
 * forward axis at a target, or twist its subtree around that axis.
 * `solveSkeleton` derives the full skeleton for the mesh from these points.
 */
export class PoseGraph {
  nodes = new Map<JointId, ControlNode>();
  bindPositions = new Map<JointId, THREE.Vector3>();
  /** Result of the most recent solveSkeleton(), for read-only queries. */
  lastSolved: SolvedSkeleton | null = null;

  /** Spine/Spine1 positions as fractions along the Hips->Chest line at bind. */
  private tSpine = 0.33;
  private tSpine1 = 0.66;

  constructor(bindPositions: Map<JointId, THREE.Vector3>) {
    for (const [id, p] of bindPositions) this.bindPositions.set(id, p.clone());

    for (const id of CONTROL_JOINTS) {
      const bind = this.bindPositions.get(id)!;
      this.nodes.set(id, {
        id,
        parent: null,
        children: [],
        pos: bind.clone(),
        quat: new THREE.Quaternion(),
        bindPos: bind.clone(),
      });
    }
    for (const id of CONTROL_JOINTS) {
      const parentId = CONTROL_PARENT[id];
      if (!parentId) continue;
      const node = this.nodes.get(id)!;
      const parent = this.nodes.get(parentId)!;
      node.parent = parent;
      parent.children.push(node);
    }

    this.computeSpineFractions();
  }

  private computeSpineFractions() {
    const b = (id: JointId) => this.bindPositions.get(id)!;
    const d0 = b('Hips').distanceTo(b('Spine'));
    const d1 = b('Spine').distanceTo(b('Spine1'));
    const d2 = b('Spine1').distanceTo(b('Spine2'));
    const total = d0 + d1 + d2;
    if (total > 1e-6) {
      this.tSpine = d0 / total;
      this.tSpine1 = (d0 + d1) / total;
    }
  }

  get(id: JointId): ControlNode {
    return this.nodes.get(id)!;
  }

  /** The node's current aim direction (world +Z at bind, rotated by its quat). */
  forward(id: JointId, target = new THREE.Vector3()): THREE.Vector3 {
    return target.copy(BIND_FORWARD).applyQuaternion(this.get(id).quat);
  }

  /** Translate a point, optionally carrying its whole control subtree along. */
  translate(id: JointId, delta: THREE.Vector3, withChildren: boolean) {
    if (isAimOnlyJoint(id)) return; // eyes stay in their sockets
    const node = this.get(id);
    node.pos.add(delta);
    const anchoredDetails = !isDetailJoint(id)
      ? node.children.filter((child) => isDetailJoint(child.id))
      : [];
    const stack = withChildren ? [...node.children] : anchoredDetails;
    while (stack.length) {
      const n = stack.pop()!;
      n.pos.add(delta);
      stack.push(...n.children);
    }
  }

  moveTo(id: JointId, target: THREE.Vector3, withChildren: boolean) {
    const delta = new THREE.Vector3().subVectors(target, this.get(id).pos);
    this.translate(id, delta, withChildren);
  }

  /**
   * Rotate the node by a world-space delta about its position. With
   * `withChildren`, descendant positions and orientations rotate along, so
   * the limb moves rigidly; without it, only this node's orientation changes.
   */
  rotate(id: JointId, delta: THREE.Quaternion, withChildren: boolean) {
    const node = this.get(id);
    node.quat.premultiply(delta);
    // The other eye turns the same way (it has no children of its own).
    const linked = AIM_LINKED[id];
    if (linked) this.get(linked).quat.premultiply(delta);
    const pivot = node.pos;
    const tmp = new THREE.Vector3();
    const anchoredDetails = !isDetailJoint(id)
      ? node.children.filter((child) => isDetailJoint(child.id))
      : [];
    const stack = withChildren ? [...node.children] : anchoredDetails;
    while (stack.length) {
      const n = stack.pop()!;
      tmp.subVectors(n.pos, pivot).applyQuaternion(delta);
      n.pos.copy(pivot).add(tmp);
      n.quat.premultiply(delta);
      stack.push(...n.children);
    }
  }

  /** Point the node's forward axis at a world target (direction helper). */
  aimAt(id: JointId, target: THREE.Vector3, withChildren: boolean) {
    const node = this.get(id);
    const desired = new THREE.Vector3().subVectors(target, node.pos);
    if (desired.lengthSq() < 1e-8) return;
    desired.normalize();
    const current = this.forward(id);
    const delta = new THREE.Quaternion().setFromUnitVectors(current, desired);
    this.rotate(id, delta, withChildren);
  }

  /** Roll the node around its forward axis (twist ring). */
  twist(id: JointId, angle: number, withChildren: boolean) {
    const axis = this.forward(id);
    this.rotate(id, new THREE.Quaternion().setFromAxisAngle(axis, angle), withChildren);
  }

  reset() {
    for (const node of this.nodes.values()) {
      node.pos.copy(node.bindPos);
      node.quat.identity();
    }
  }

  /**
   * Derive world positions and rotation deltas for all 20 skeleton joints:
   * control joints directly, sockets/neck rigidly attached to their control,
   * and the spine mids interpolated along the Hips->Chest line.
   */
  solveSkeleton(): SolvedSkeleton {
    const pos = new Map<JointId, THREE.Vector3>();
    const rot = new Map<JointId, THREE.Quaternion>();

    for (const id of CONTROL_JOINTS) {
      const node = this.get(id);
      pos.set(id, node.pos.clone());
      rot.set(id, node.quat.clone());
    }

    for (const { joint, base } of RIGID_ATTACH) {
      const baseNode = this.get(base);
      const offset = new THREE.Vector3()
        .subVectors(this.bindPositions.get(joint)!, this.bindPositions.get(base)!)
        .applyQuaternion(baseNode.quat);
      pos.set(joint, offset.add(baseNode.pos));
      rot.set(joint, baseNode.quat.clone());
    }

    const hips = this.get('Hips');
    const chest = this.get('Spine2');
    for (const [id, t] of [
      ['Spine', this.tSpine],
      ['Spine1', this.tSpine1],
    ] as [JointId, number][]) {
      pos.set(id, new THREE.Vector3().lerpVectors(hips.pos, chest.pos, t));
      // Blend the twist smoothly up the torso.
      rot.set(id, hips.quat.clone().slerp(chest.quat, t));
    }

    this.lastSolved = { pos, rot };
    return this.lastSolved;
  }

  /**
   * Current length of the skeleton segment ending at `id` (its skeleton
   * parent -> it) relative to bind: 1 = natural, >1 longer, <1 shorter.
   * The root has no segment and reports 1.
   */
  segmentStretch(id: JointId): number {
    const parent = JOINT_PARENT[id];
    if (!parent) return 1;
    const solved = this.lastSolved ?? this.solveSkeleton();
    const bindLen = this.bindPositions.get(id)!.distanceTo(this.bindPositions.get(parent)!);
    if (bindLen < 1e-6) return 1;
    return solved.pos.get(id)!.distanceTo(solved.pos.get(parent)!) / bindLen;
  }

  hasStretchSegment(id: JointId): boolean {
    const parent = JOINT_PARENT[id];
    if (!parent) return false;
    return !isDetailJoint(id) || (isFingerJoint(id) && isFingerJoint(parent));
  }
}

/** Build a world quaternion from a primary aim direction and a secondary (roll) hint. */
export function frameQuat(primary: THREE.Vector3, secondary: THREE.Vector3): THREE.Quaternion {
  const x = primary.clone().normalize();
  const z = new THREE.Vector3().crossVectors(x, secondary);
  if (z.lengthSq() < 1e-10) z.set(0, 0, 1);
  z.normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}
