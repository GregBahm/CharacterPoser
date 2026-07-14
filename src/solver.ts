import * as THREE from 'three';

/**
 * Identifiers for the joints participating in the full-body solve.
 * The 15 user-facing control points are a subset (see CONTROL_JOINTS).
 */
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

/** The 15 HIK-style quick-select control points. */
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
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
];

/** Joints that support the rotate tool — every user-facing control point. */
export const ROTATABLE_JOINTS: JointId[] = [...CONTROL_JOINTS];

export interface SolverJoint {
  id: JointId;
  index: number;
  parent: number;
  children: number[];
  len: number; // bone length to parent (world units)
  pos: THREE.Vector3; // current solved world position — this IS the pose state
  bindPos: THREE.Vector3;
  pinned: boolean;
  pinPos: THREE.Vector3;
}

/** How strongly unreachable targets drag the hips along, per iteration. */
const HIP_PULL = 0.12;
const ITERATIONS = 14;

/**
 * Preferred bend directions (world space, character facing +Z). Nudging these
 * joints each iteration breaks FABRIK's symmetry so knees fold forward and
 * elbows fold down/back instead of splaying arbitrarily.
 */
const BEND_HINTS: Partial<Record<JointId, THREE.Vector3>> = {
  LeftLeg: new THREE.Vector3(0, 0, 1),
  RightLeg: new THREE.Vector3(0, 0, 1),
  LeftForeArm: new THREE.Vector3(0, -0.7, -0.7).normalize(),
  RightForeArm: new THREE.Vector3(0, -0.7, -0.7).normalize(),
};

/**
 * Rigid bodies within the skeleton: hip sockets are fixed to the pelvis and
 * shoulder sockets to the upper chest. Their positions are always derived
 * from the base joint's frame (aimed by the primary child, rolled by the
 * left-right axis) instead of being solved as free bones.
 */
const RIGID_GROUPS: { base: JointId; primary: JointId; members: [JointId, JointId] }[] = [
  { base: 'Hips', primary: 'Spine', members: ['LeftUpLeg', 'RightUpLeg'] },
  { base: 'Spine2', primary: 'Neck', members: ['LeftShoulder', 'RightShoulder'] },
];

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

/**
 * Multi-chain FABRIK solver over the humanoid joint tree.
 * Pinned joints act as permanent targets competing with the dragged target,
 * so pulling a wrist bends the arm, then spine/hips compensate, while pinned
 * feet keep the body grounded — approximating Maya HumanIK full-body mode.
 */
export class FullBodySolver {
  joints: SolverJoint[] = [];
  private byId = new Map<JointId, number>();
  private orderAsc: number[] = []; // root -> leaves
  private orderDesc: number[] = []; // leaves -> root
  private rigidMember = new Map<number, { base: number; primary: number; left: number; right: number }>();

  constructor(bindPositions: Map<JointId, THREE.Vector3>) {
    for (const def of JOINT_DEFS) {
      const index = this.joints.length;
      const parent = def.parent === null ? -1 : this.byId.get(def.parent)!;
      const bind = bindPositions.get(def.id)!.clone();
      const joint: SolverJoint = {
        id: def.id,
        index,
        parent,
        children: [],
        len: parent >= 0 ? bind.distanceTo(this.joints[parent].bindPos) : 0,
        pos: bind.clone(),
        bindPos: bind,
        pinned: false,
        pinPos: bind.clone(),
      };
      this.joints.push(joint);
      this.byId.set(def.id, index);
      if (parent >= 0) this.joints[parent].children.push(index);
    }
    // JOINT_DEFS is listed parent-before-child, so definition order is a topological order.
    this.orderAsc = this.joints.map((j) => j.index);
    this.orderDesc = [...this.orderAsc].reverse();

    for (const g of RIGID_GROUPS) {
      const info = {
        base: this.byId.get(g.base)!,
        primary: this.byId.get(g.primary)!,
        left: this.byId.get(g.members[0])!,
        right: this.byId.get(g.members[1])!,
      };
      this.rigidMember.set(info.left, info);
      this.rigidMember.set(info.right, info);
    }
  }

  get(id: JointId): SolverJoint {
    return this.joints[this.byId.get(id)!];
  }

  /**
   * Rigidly rotate the descendant subtree of `id` about `id`'s position by the
   * world-space quaternion `delta`. Pinned descendants (and everything below
   * them) stay anchored so the rotation "inherits" only through free joints.
   * Used by the rotate tool's "Affect children" mode.
   */
  rotateSubtree(id: JointId, delta: THREE.Quaternion) {
    const root = this.get(id);
    const pivot = root.pos;
    const stack = [...root.children];
    const tmp = new THREE.Vector3();
    while (stack.length) {
      const j = this.joints[stack.pop()!];
      if (j.pinned) continue; // anchored: skip it and its subtree
      tmp.subVectors(j.pos, pivot).applyQuaternion(delta);
      j.pos.copy(pivot).add(tmp);
      for (const c of j.children) stack.push(c);
    }
  }

  setPinned(id: JointId, pinned: boolean) {
    const j = this.get(id);
    j.pinned = pinned;
    if (pinned) j.pinPos.copy(j.pos);
  }

  resetPose() {
    for (const j of this.joints) {
      j.pos.copy(j.bindPos);
      j.pinPos.copy(j.bindPos);
    }
  }

  /**
   * Solve toward the given drag targets (usually one: the control being dragged).
   * Pinned joints are always included as targets. Mutates joint positions in place.
   */
  solve(dragTargets: Map<JointId, THREE.Vector3>) {
    const n = this.joints.length;
    const targets: (THREE.Vector3 | null)[] = new Array(n).fill(null);
    let anyTarget = false;
    for (const j of this.joints) {
      const drag = dragTargets.get(j.id);
      if (drag) {
        targets[j.index] = drag;
        anyTarget = true;
      } else if (j.pinned) {
        targets[j.index] = j.pinPos;
        anyTarget = true;
      }
    }
    if (!anyTarget) return;

    // A joint is "active" if its subtree contains a target. Inactive subtrees
    // (e.g. the arms while dragging the hips) move rigidly with their base
    // instead of chasing their stale world positions.
    const active: boolean[] = new Array(n).fill(false);
    for (const i of this.orderDesc) {
      active[i] = targets[i] !== null || this.joints[i].children.some((c) => active[c]);
    }

    const backPos: (THREE.Vector3 | null)[] = new Array(n).fill(null);
    const proposals: (THREE.Vector3[] | null)[] = new Array(n).fill(null);
    const tmp = new THREE.Vector3();

    for (let it = 0; it < ITERATIONS; it++) {
      backPos.fill(null);
      proposals.fill(null);

      // Steer bendable joints toward their preferred fold direction, but only
      // when the chain is compressed (endpoints closer than the combined bone
      // lengths, i.e. the joint MUST bend) and only until the joint has
      // roughly the bend the compression requires. A straight chain at full
      // extension gets no hint, so hand drags don't disturb the legs. Hints
      // stop halfway through so the remaining iterations settle cleanly onto
      // the targets.
      for (const [id, hint] of it < ITERATIONS / 2 ? (Object.entries(BEND_HINTS) as [JointId, THREE.Vector3][]) : []) {
        const j = this.get(id);
        if (!active[j.index] || targets[j.index]) continue;
        const child = this.joints[j.children[0]];
        const a = this.joints[j.parent].pos;
        const b = targets[child.index] ?? child.pos;
        const full = j.len + child.len;
        const d = a.distanceTo(b);
        if (d >= full * 0.995) continue;
        const needed = Math.sqrt(Math.max(0, full * full - d * d)) / 2;
        tmp.subVectors(b, a);
        const lineLenSq = tmp.lengthSq();
        let perp = 0;
        if (lineLenSq > 1e-12) {
          const t = THREE.MathUtils.clamp(tmp.dot(new THREE.Vector3().subVectors(j.pos, a)) / lineLenSq, 0, 1);
          perp = new THREE.Vector3().copy(a).addScaledVector(tmp, t).sub(j.pos).length();
        }
        if (perp < needed * 0.8) {
          j.pos.addScaledVector(hint, Math.min((needed - perp) * 0.5, j.len * 0.3));
        }
      }

      const prev = this.joints.map((j) => j.pos.clone());

      // Backward pass: from each targeted joint, walk toward the root,
      // proposing a position for every joint along the way.
      for (const i of this.orderDesc) {
        const j = this.joints[i];
        let p: THREE.Vector3 | null = null;
        if (targets[i]) {
          p = targets[i]!.clone(); // a target always wins over child proposals
        } else if (proposals[i] && proposals[i]!.length > 0) {
          p = average(proposals[i]!);
        }
        if (!p) continue;
        backPos[i] = p;
        if (j.parent >= 0) {
          const parRef = backPos[j.parent] ?? prev[j.parent];
          tmp.subVectors(parRef, p);
          if (tmp.lengthSq() < 1e-12) tmp.set(0, 1, 0);
          tmp.normalize().multiplyScalar(j.len);
          (proposals[j.parent] ??= []).push(p.clone().add(tmp));
        }
      }

      // Root: dragged/pinned hips go where told; otherwise unreachable
      // targets gradually pull the whole body.
      const root = this.joints[0];
      if (targets[0]) {
        root.pos.copy(targets[0]!);
      } else if (proposals[0] && proposals[0]!.length > 0) {
        root.pos.lerp(average(proposals[0]!), HIP_PULL);
      }

      // Forward pass: from the root out, restore bone lengths while aiming
      // each bone at its backward-pass position. Inactive subtrees translate
      // rigidly with their parent's motion.
      const groupQuats = new Map<number, THREE.Quaternion>();
      for (const i of this.orderAsc) {
        const j = this.joints[i];
        if (j.parent < 0) continue;
        const par = this.joints[j.parent];

        // Hip/shoulder sockets: rigid placement from the base joint's frame.
        // (Base and primary have smaller indices, so their positions are fresh.)
        const rigid = this.rigidMember.get(i);
        if (rigid) {
          let q = groupQuats.get(rigid.base);
          if (!q) {
            const base = this.joints[rigid.base];
            const prim = this.joints[rigid.primary];
            const primCur = new THREE.Vector3().subVectors(prim.pos, base.pos);
            const lrCur = new THREE.Vector3().subVectors(prev[rigid.left], prev[rigid.right]);
            const primBind = new THREE.Vector3().subVectors(prim.bindPos, base.bindPos);
            const lrBind = new THREE.Vector3().subVectors(this.joints[rigid.left].bindPos, this.joints[rigid.right].bindPos);
            q = frameQuat(primCur, lrCur).multiply(frameQuat(primBind, lrBind).invert());
            groupQuats.set(rigid.base, q);
          }
          const base = this.joints[rigid.base];
          j.pos.copy(j.bindPos).sub(base.bindPos).applyQuaternion(q).add(base.pos);
          continue;
        }

        if (!active[i]) {
          j.pos.copy(par.pos).add(prev[i]).sub(prev[j.parent]);
          continue;
        }
        const ref = backPos[i] ?? targets[i] ?? prev[i];
        tmp.subVectors(ref, par.pos);
        if (tmp.lengthSq() < 1e-12) tmp.set(0, -1, 0);
        tmp.normalize().multiplyScalar(j.len);
        j.pos.copy(par.pos).add(tmp);
      }
    }
  }
}

function average(list: THREE.Vector3[]): THREE.Vector3 {
  const out = new THREE.Vector3();
  for (const v of list) out.add(v);
  return out.divideScalar(list.length);
}
