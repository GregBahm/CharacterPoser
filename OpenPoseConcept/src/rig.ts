import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { frameQuat, JOINT_DEFS, JointId, SolvedSkeleton } from './pose.ts';

interface BoneBinding {
  id: JointId;
  parent: JointId | null;
  bone: THREE.Bone;
  bindLocalPos: THREE.Vector3;
  bindLocalQuat: THREE.Quaternion;
  bindWorldQuat: THREE.Quaternion;
}

const CHARACTER_HEIGHT = 1.75; // meters

/**
 * The loaded FBX model plus the machinery to fit its bones to a solved
 * skeleton: each bone aims at its solved child positions and its length
 * scales to span them exactly, so the mesh always fits the control points
 * no matter where they are dragged.
 */
export class CharacterRig {
  root: THREE.Group;
  /** Bind-pose world positions of all skeleton joints (normalized space). */
  bindWorldPositions = new Map<JointId, THREE.Vector3>();

  private bindings = new Map<JointId, BoneBinding>();
  private childBindings = new Map<JointId, BoneBinding[]>();

  private constructor(root: THREE.Group) {
    this.root = root;
  }

  static async load(url: string): Promise<CharacterRig> {
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

    const rig = new CharacterRig(group);
    for (const def of JOINT_DEFS) {
      const bone = findBone(fbx, def.id);
      if (!bone) throw new Error(`Could not find bone for joint "${def.id}" in ${url}`);
      rig.bindings.set(def.id, {
        id: def.id,
        parent: def.parent,
        bone,
        bindLocalPos: bone.position.clone(),
        bindLocalQuat: bone.quaternion.clone(),
        bindWorldQuat: bone.getWorldQuaternion(new THREE.Quaternion()),
      });
      rig.bindWorldPositions.set(def.id, bone.getWorldPosition(new THREE.Vector3()));
    }
    for (const def of JOINT_DEFS) {
      if (!def.parent) continue;
      const list = rig.childBindings.get(def.parent) ?? [];
      list.push(rig.bindings.get(def.id)!);
      rig.childBindings.set(def.parent, list);
    }

    return rig;
  }

  getBone(id: JointId): THREE.Bone {
    return this.bindings.get(id)!.bone;
  }

  /**
   * Fit the bones to the solved skeleton. Stateless per call: pose =
   * f(solved positions, solved rotation deltas), so no drift accumulates.
   *
   * Per bone: length scales so it spans parent->joint exactly (free points
   * squash/stretch their segments), and orientation = aim-correction *
   * rotation-delta * bind, so twist/aim from the widgets carries into the
   * mesh while the bone still points at its solved children.
   */
  applyPose(solved: SolvedSkeleton) {
    const tmpParentQuat = new THREE.Quaternion();
    const v0 = new THREE.Vector3();
    const v1 = new THREE.Vector3();
    const s0 = new THREE.Vector3();
    const s1 = new THREE.Vector3();

    // Reset every mapped bone to bind-local, scaling its offset from the
    // parent so the bone length matches the solved joint spacing.
    for (const [id, b] of this.bindings) {
      let stretch = 1;
      if (b.parent) {
        const bindLen = this.bindWorldPositions.get(id)!.distanceTo(this.bindWorldPositions.get(b.parent)!);
        const curLen = solved.pos.get(id)!.distanceTo(solved.pos.get(b.parent)!);
        if (bindLen > 1e-6) stretch = curLen / bindLen;
      }
      b.bone.position.copy(b.bindLocalPos).multiplyScalar(stretch);
      b.bone.quaternion.copy(b.bindLocalQuat);
    }

    // Translate the hips so their world position matches the solve.
    const hips = this.bindings.get('Hips')!;
    const hipsParent = hips.bone.parent!;
    hipsParent.updateWorldMatrix(true, false);
    hips.bone.position
      .copy(solved.pos.get('Hips')!)
      .applyMatrix4(new THREE.Matrix4().copy(hipsParent.matrixWorld).invert());

    // Root -> leaves (JOINT_DEFS order): compute each bone's world orientation
    // directly from bind data, then convert to bone-local.
    for (const def of JOINT_DEFS) {
      const binding = this.bindings.get(def.id)!;
      const bone = binding.bone;
      const delta = solved.rot.get(def.id)!;
      const jointPos = solved.pos.get(def.id)!;
      const jointBind = this.bindWorldPositions.get(def.id)!;
      const children = this.childBindings.get(def.id);

      const targetWorld = delta.clone().multiply(binding.bindWorldQuat);

      if (children && children.length > 0) {
        if (children.length === 1) {
          const child = children[0];
          v0.subVectors(this.bindWorldPositions.get(child.id)!, jointBind).applyQuaternion(delta).normalize();
          v1.subVectors(solved.pos.get(child.id)!, jointPos);
          if (v1.lengthSq() > 1e-12) {
            v1.normalize();
            targetWorld.premultiply(new THREE.Quaternion().setFromUnitVectors(v0, v1));
          }
        } else {
          // Hips (Spine + legs) or Spine2 (Neck + shoulders): align a frame
          // built from the primary (spine/neck) direction and the left-right axis.
          const primary = children.find((c) => c.id === 'Spine' || c.id === 'Neck') ?? children[0];
          const left = children.find((c) => c.id.startsWith('Left'));
          const right = children.find((c) => c.id.startsWith('Right'));
          v0.subVectors(this.bindWorldPositions.get(primary.id)!, jointBind).applyQuaternion(delta);
          v1.subVectors(solved.pos.get(primary.id)!, jointPos);
          if (left && right) {
            s0.subVectors(this.bindWorldPositions.get(left.id)!, this.bindWorldPositions.get(right.id)!).applyQuaternion(delta);
            s1.subVectors(solved.pos.get(left.id)!, solved.pos.get(right.id)!);
          } else {
            s0.set(1, 0, 0);
            s1.set(1, 0, 0);
          }
          if (v1.lengthSq() > 1e-12) {
            targetWorld.premultiply(frameQuat(v1, s1).multiply(frameQuat(v0, s0).invert()));
          }
        }
      }
      // Leaves (head/hands/feet) keep targetWorld = delta * bind: they follow
      // their node's accumulated aim/twist exactly.

      bone.parent!.getWorldQuaternion(tmpParentQuat);
      bone.quaternion.copy(tmpParentQuat.invert().multiply(targetWorld));
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
