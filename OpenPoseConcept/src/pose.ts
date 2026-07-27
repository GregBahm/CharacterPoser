import * as THREE from 'three';

/** All skeleton joints mapped to Mixamo bones (used to drive the mesh). */
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
  | 'RightFoot';

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
];

/** The 13 user-facing control points (OpenPose-style body). */
export const CONTROL_JOINTS: JointId[] = [
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
    const node = this.get(id);
    node.pos.add(delta);
    if (!withChildren) return;
    const stack = [...node.children];
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
   * Rotate the node and its whole control subtree by a world-space delta
   * about the node's position. Descendant positions and orientations both
   * rotate, so limbs move rigidly.
   */
  rotate(id: JointId, delta: THREE.Quaternion) {
    const node = this.get(id);
    node.quat.premultiply(delta);
    const pivot = node.pos;
    const tmp = new THREE.Vector3();
    const stack = [...node.children];
    while (stack.length) {
      const n = stack.pop()!;
      tmp.subVectors(n.pos, pivot).applyQuaternion(delta);
      n.pos.copy(pivot).add(tmp);
      n.quat.premultiply(delta);
      stack.push(...n.children);
    }
  }

  /** Point the node's forward axis at a world target (direction helper). */
  aimAt(id: JointId, target: THREE.Vector3) {
    const node = this.get(id);
    const desired = new THREE.Vector3().subVectors(target, node.pos);
    if (desired.lengthSq() < 1e-8) return;
    desired.normalize();
    const current = this.forward(id);
    const delta = new THREE.Quaternion().setFromUnitVectors(current, desired);
    this.rotate(id, delta);
  }

  /** Roll the node and subtree around the node's forward axis (twist ring). */
  twist(id: JointId, angle: number) {
    const axis = this.forward(id);
    this.rotate(id, new THREE.Quaternion().setFromAxisAngle(axis, angle));
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

    return { pos, rot };
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
