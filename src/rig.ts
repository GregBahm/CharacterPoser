import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { frameQuat, FullBodySolver, JOINT_DEFS, JointId } from './solver.ts';

interface BoneBinding {
  id: JointId;
  bone: THREE.Bone;
  bindLocalPos: THREE.Vector3;
  bindLocalQuat: THREE.Quaternion;
  bindWorldQuat: THREE.Quaternion;
}

const CHARACTER_HEIGHT = 1.75; // meters

/**
 * A posable character: the loaded FBX model, its solver skeleton, and the
 * machinery to turn solved joint positions back into bone rotations.
 */
export class CharacterRig {
  root: THREE.Group;
  solver: FullBodySolver;
  /**
   * World-orientation overrides. Joints present here keep the stored world
   * orientation through solves (orientation locks and rotate-tool edits).
   * Head and feet start overridden to their bind orientation so the head
   * stays upright and feet stay flat as limbs move.
   */
  orientOverrides = new Map<JointId, THREE.Quaternion>();

  private bindings = new Map<JointId, BoneBinding>();
  private childBindings = new Map<JointId, BoneBinding[]>();

  private constructor(root: THREE.Group, solver: FullBodySolver) {
    this.root = root;
    this.solver = solver;
  }

  static async load(url: string, applyInitialPose = true): Promise<CharacterRig> {
    const fbx = await new FBXLoader().loadAsync(url);

    // Neutral material — Mixamo FBX texture references often don't resolve.
    fbx.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.material = new THREE.MeshStandardMaterial({
          color: 0xb8bdc7,
          roughness: 0.65,
          metalness: 0.05,
        });
        mesh.castShadow = true;
        mesh.frustumCulled = false; // skinned mesh moves far from its bind bbox
      }
    });

    // Normalize scale and rest the feet on the ground plane.
    const group = new THREE.Group();
    group.add(fbx);
    let bbox = new THREE.Box3().setFromObject(fbx);
    const height = bbox.max.y - bbox.min.y;
    group.scale.setScalar(CHARACTER_HEIGHT / height);
    group.updateWorldMatrix(true, true);
    bbox = new THREE.Box3().setFromObject(group);
    group.position.y = -bbox.min.y;
    group.updateWorldMatrix(true, true);

    const rig = new CharacterRig(group, null as unknown as FullBodySolver);
    const bindWorldPositions = new Map<JointId, THREE.Vector3>();

    for (const def of JOINT_DEFS) {
      const bone = findBone(fbx, def.id);
      if (!bone) throw new Error(`Could not find bone for joint "${def.id}" in ${url}`);
      rig.bindings.set(def.id, {
        id: def.id,
        bone,
        bindLocalPos: bone.position.clone(),
        bindLocalQuat: bone.quaternion.clone(),
        bindWorldQuat: bone.getWorldQuaternion(new THREE.Quaternion()),
      });
      bindWorldPositions.set(def.id, bone.getWorldPosition(new THREE.Vector3()));
    }
    for (const def of JOINT_DEFS) {
      if (!def.parent) continue;
      const list = rig.childBindings.get(def.parent) ?? [];
      list.push(rig.bindings.get(def.id)!);
      rig.childBindings.set(def.parent, list);
    }

    rig.solver = new FullBodySolver(bindWorldPositions);

    // HIK-like defaults: feet pinned so the body stays grounded, and
    // head/feet hold their world orientation.
    rig.solver.setPinned('LeftFoot', true);
    rig.solver.setPinned('RightFoot', true);
    for (const id of ['Head', 'LeftFoot', 'RightFoot'] as JointId[]) {
      rig.orientOverrides.set(id, rig.bindings.get(id)!.bindWorldQuat.clone());
    }

    if (applyInitialPose) rig.applyPose();
    return rig;
  }

  getBone(id: JointId): THREE.Bone {
    return this.bindings.get(id)!.bone;
  }

  getJointWorldPos(id: JointId, target: THREE.Vector3): THREE.Vector3 {
    return this.getBone(id).getWorldPosition(target);
  }

  getJointWorldQuat(id: JointId, target: THREE.Quaternion): THREE.Quaternion {
    return this.getBone(id).getWorldQuaternion(target);
  }

  setOrientOverride(id: JointId, worldQuat: THREE.Quaternion) {
    this.orientOverrides.set(id, worldQuat.clone());
  }

  clearOrientOverride(id: JointId) {
    this.orientOverrides.delete(id);
  }

  resetPose() {
    this.solver.resetPose();
    this.orientOverrides.clear();
    for (const id of ['Head', 'LeftFoot', 'RightFoot'] as JointId[]) {
      this.orientOverrides.set(id, this.bindings.get(id)!.bindWorldQuat.clone());
    }
    this.applyPose();
  }

  /**
   * Rebuild bone rotations from the bind pose so that each solver joint's
   * bone points at its solved child positions. Stateless per call: pose =
   * f(solved positions, orientation overrides), so no drift accumulates.
   */
  applyPose() {
    const tmpParentQuat = new THREE.Quaternion();
    const tmpWorldQuat = new THREE.Quaternion();
    const tmpDelta = new THREE.Quaternion();
    const jointPos = new THREE.Vector3();
    const v0 = new THREE.Vector3();
    const v1 = new THREE.Vector3();
    const s0 = new THREE.Vector3();
    const s1 = new THREE.Vector3();

    // Reset every mapped bone to its bind-local transform.
    for (const b of this.bindings.values()) {
      b.bone.position.copy(b.bindLocalPos);
      b.bone.quaternion.copy(b.bindLocalQuat);
    }

    // Translate the hips so their world position matches the solve.
    const hips = this.bindings.get('Hips')!;
    const hipsParent = hips.bone.parent!;
    hipsParent.updateWorldMatrix(true, false);
    hips.bone.position
      .copy(this.solver.get('Hips').pos)
      .applyMatrix4(new THREE.Matrix4().copy(hipsParent.matrixWorld).invert());

    // Root -> leaves (JOINT_DEFS order): aim each bone at its solved children.
    for (const def of JOINT_DEFS) {
      const binding = this.bindings.get(def.id)!;
      const bone = binding.bone;
      const joint = this.solver.get(def.id);
      const children = this.childBindings.get(def.id);
      const override = this.orientOverrides.get(def.id);

      bone.updateWorldMatrix(true, false);
      bone.getWorldQuaternion(tmpWorldQuat);

      if (children && children.length > 0) {
        jointPos.setFromMatrixPosition(bone.matrixWorld);
        if (children.length === 1) {
          const child = children[0];
          v0.copy(child.bindLocalPos).applyMatrix4(bone.matrixWorld).sub(jointPos).normalize();
          v1.subVectors(this.solver.get(child.id).pos, joint.pos).normalize();
          tmpDelta.setFromUnitVectors(v0, v1);
          tmpWorldQuat.premultiply(tmpDelta);
        } else {
          // Hips (Spine + legs) or Spine2 (Neck + shoulders): align a frame
          // built from the primary (spine/neck) direction and the left-right axis.
          const primary = children.find((c) => c.id === 'Spine' || c.id === 'Neck') ?? children[0];
          const left = children.find((c) => c.id.startsWith('Left'));
          const right = children.find((c) => c.id.startsWith('Right'));
          v0.copy(primary.bindLocalPos).applyMatrix4(bone.matrixWorld).sub(jointPos);
          v1.subVectors(this.solver.get(primary.id).pos, joint.pos);
          if (left && right) {
            s0.copy(left.bindLocalPos)
              .applyMatrix4(bone.matrixWorld)
              .sub(s1.copy(right.bindLocalPos).applyMatrix4(bone.matrixWorld));
            s1.subVectors(this.solver.get(left.id).pos, this.solver.get(right.id).pos);
          } else {
            s0.set(1, 0, 0);
            s1.set(1, 0, 0);
          }
          tmpDelta.multiplyQuaternions(frameQuat(v1, s1), frameQuat(v0, s0).invert());
          tmpWorldQuat.premultiply(tmpDelta);
        }
        if (override) tmpWorldQuat.copy(override);
      } else {
        // End joint (head/hands/feet): follow the parent unless overridden.
        if (override) tmpWorldQuat.copy(override);
        else continue;
      }

      bone.parent!.getWorldQuaternion(tmpParentQuat);
      bone.quaternion.copy(tmpParentQuat.invert().multiply(tmpWorldQuat));
      bone.updateWorldMatrix(false, false);
    }

    this.root.updateWorldMatrix(true, true);
  }
}

/** Find a bone whose sanitized name ends with the given Mixamo joint name. */
function findBone(root: THREE.Object3D, id: JointId): THREE.Bone | null {
  let found: THREE.Bone | null = null;
  root.traverse((obj) => {
    if (found || !(obj as THREE.Bone).isBone) return;
    const clean = obj.name.replace(/[^A-Za-z0-9]/g, '');
    if (clean.endsWith(id)) found = obj as THREE.Bone;
  });
  return found;
}
