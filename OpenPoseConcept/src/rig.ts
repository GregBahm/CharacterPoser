import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import {
  frameQuat,
  isDetailJoint,
  isFingerJoint,
  JOINT_DEFS,
  JointDef,
  JointId,
  SolvedSkeleton,
} from './pose.ts';

interface BoneBinding {
  id: JointId;
  parent: JointId | null;
  bone: THREE.Bone;
  bindLocalPos: THREE.Vector3;
  bindLocalQuat: THREE.Quaternion;
  bindWorldQuat: THREE.Quaternion;
  /**
   * For single-child segment bones: unit direction (bone-local) toward the
   * child joint. The bone stretches along this axis to span the solved
   * joints. Null for the root/branching bones (Hips, Spine2) and leaves.
   */
  stretchAxis: THREE.Vector3 | null;
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
        stretchAxis: null,
      });
      // Bone matrices are written explicitly in applyPose (axial stretch is
      // not expressible via position/quaternion/scale alone).
      bone.matrixAutoUpdate = false;
      rig.bindWorldPositions.set(def.id, bone.getWorldPosition(new THREE.Vector3()));
    }
    for (const def of JOINT_DEFS) {
      if (!def.parent) continue;
      // Body leaves (hands/head) must keep their existing behavior when
      // detail controls are present. Finger segments still aim at each other.
      if (isDetailJoint(def.id) && !(isFingerJoint(def.id) && isFingerJoint(def.parent))) continue;
      const list = rig.childBindings.get(def.parent) ?? [];
      list.push(rig.bindings.get(def.id)!);
      rig.childBindings.set(def.parent, list);
    }
    for (const [id, children] of rig.childBindings) {
      if (children.length !== 1) continue;
      const axis = children[0].bindLocalPos.clone();
      if (axis.lengthSq() > 1e-10) rig.bindings.get(id)!.stretchAxis = axis.normalize();
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
   * Per bone: orientation = aim-correction * rotation-delta * bind, so
   * twist/aim from the widgets carries into the mesh while the bone still
   * points at its solved children. Each segment bone (one child) is then
   * scaled along its child axis by solvedLength / bindLength -- a plain axial
   * stretch, no volume preservation -- so the skin actually lengthens or
   * shortens to meet the control points. Children counter-scale so the
   * stretch does not propagate down the chain.
   */
  applyPose(solved: SolvedSkeleton) {
    const tmpParentQuat = new THREE.Quaternion();
    const v0 = new THREE.Vector3();
    const v1 = new THREE.Vector3();
    const s0 = new THREE.Vector3();
    const s1 = new THREE.Vector3();
    const tmpParentRotation = new THREE.Matrix4();
    const scaleM = new THREE.Matrix4();
    const invScaleM = new THREE.Matrix4();

    // Reset every mapped bone to bind-local, scaling its offset from the
    // parent so the bone length matches the solved joint spacing.
    const stretchOf = new Map<JointId, number>();
    for (const [id, b] of this.bindings) {
      let stretch = 1;
      if (b.parent) {
        const bindLen = this.bindWorldPositions.get(id)!.distanceTo(this.bindWorldPositions.get(b.parent)!);
        const curLen = solved.pos.get(id)!.distanceTo(solved.pos.get(b.parent)!);
        if (bindLen > 1e-6) stretch = curLen / bindLen;
      }
      stretchOf.set(id, stretch);
      b.bone.position.copy(b.bindLocalPos);
      if (!isDetailJoint(id)) b.bone.position.multiplyScalar(stretch);
      b.bone.quaternion.copy(b.bindLocalQuat);
      b.bone.scale.setScalar(1);
      b.bone.updateMatrix();
    }

    // Translate the hips so their world position matches the solve.
    const hips = this.bindings.get('Hips')!;
    const hipsParent = hips.bone.parent!;
    hipsParent.updateWorldMatrix(true, false);
    hips.bone.position
      .copy(solved.pos.get('Hips')!)
      .applyMatrix4(new THREE.Matrix4().copy(hipsParent.matrixWorld).invert());
    hips.bone.updateMatrix();

    const applyOrientation = (def: JointDef, positionDirectly: boolean) => {
      const binding = this.bindings.get(def.id)!;
      const bone = binding.bone;
      const delta = solved.rot.get(def.id)!;
      const jointPos = solved.pos.get(def.id)!;
      const jointBind = this.bindWorldPositions.get(def.id)!;
      const children = this.childBindings.get(def.id);

      if (positionDirectly) {
        bone.parent!.updateWorldMatrix(true, false);
        bone.position
          .copy(jointPos)
          .applyMatrix4(new THREE.Matrix4().copy(bone.parent!.matrixWorld).invert());
        bone.updateMatrix();
      }

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

      bone.parent!.updateWorldMatrix(true, false);
      tmpParentRotation.extractRotation(bone.parent!.matrixWorld);
      tmpParentQuat.setFromRotationMatrix(tmpParentRotation);
      bone.quaternion.copy(tmpParentQuat.invert().multiply(targetWorld));
      bone.updateMatrix();
      bone.updateWorldMatrix(false, false);
    };

    const applyAxialStretch = (detail: boolean) => {
      for (const def of JOINT_DEFS) {
        if (isDetailJoint(def.id) !== detail) continue;
        const binding = this.bindings.get(def.id)!;
        if (!binding.stretchAxis) continue;
        const child = this.childBindings.get(def.id)![0];
        const stretch = stretchOf.get(child.id) ?? 1;
        if (Math.abs(stretch - 1) < 1e-6) continue;
        axialScale(scaleM, binding.stretchAxis, stretch);
        axialScale(invScaleM, binding.stretchAxis, 1 / stretch);
        binding.bone.matrix.multiply(scaleM);
        child.bone.matrix.premultiply(invScaleM);
      }
    };

    // Body root -> leaves: compute each bone's world orientation directly
    // from bind data, then convert to bone-local.
    for (const def of JOINT_DEFS) {
      if (isDetailJoint(def.id)) continue;
      applyOrientation(def, false);
    }

    // Apply body stretch before placing details because the MPFB skeleton has
    // helper bones between several mapped body joints.
    applyAxialStretch(false);

    // The detailed controls may skip helper/metacarpal bones in the asset.
    // Place each one in world space after its body ancestors are posed, then
    // orient it. Parent-before-child order keeps finger chains coherent.
    this.root.updateWorldMatrix(true, true);
    for (const def of JOINT_DEFS) {
      if (!isDetailJoint(def.id)) continue;
      applyOrientation(def, true);
    }

    // Finger joints are directly parented, so their stretch/counter-stretch
    // pass can safely run after their exact world positions are established.
    applyAxialStretch(true);

    this.root.updateWorldMatrix(true, true);
  }
}

/** Scale matrix that stretches by `s` along unit `axis` only: I + (s-1) * a * a^T. */
function axialScale(out: THREE.Matrix4, axis: THREE.Vector3, s: number): THREE.Matrix4 {
  const k = s - 1;
  const { x, y, z } = axis;
  return out.set(
    1 + k * x * x, k * x * y, k * x * z, 0,
    k * y * x, 1 + k * y * y, k * y * z, 0,
    k * z * x, k * z * y, 1 + k * z * z, 0,
    0, 0, 0, 1,
  );
}

const BONE_ALIASES: Partial<Record<JointId, string>> = {
  Hips: 'root',
  Spine: 'spine04',
  Spine1: 'spine02',
  Spine2: 'spine01',
  Neck: 'neck01',
  Head: 'head',
  LeftShoulder: 'clavicleL',
  LeftArm: 'upperarm01L',
  LeftForeArm: 'lowerarm01L',
  LeftHand: 'wristL',
  RightShoulder: 'clavicleR',
  RightArm: 'upperarm01R',
  RightForeArm: 'lowerarm01R',
  RightHand: 'wristR',
  LeftUpLeg: 'upperleg01L',
  LeftLeg: 'lowerleg01L',
  LeftFoot: 'footL',
  RightUpLeg: 'upperleg01R',
  RightLeg: 'lowerleg01R',
  RightFoot: 'footR',
  LeftThumb1: 'finger1-1L',
  LeftThumb2: 'finger1-2L',
  LeftThumb3: 'finger1-3L',
  LeftIndex1: 'finger2-1L',
  LeftIndex2: 'finger2-2L',
  LeftIndex3: 'finger2-3L',
  LeftMiddle1: 'finger3-1L',
  LeftMiddle2: 'finger3-2L',
  LeftMiddle3: 'finger3-3L',
  LeftRing1: 'finger4-1L',
  LeftRing2: 'finger4-2L',
  LeftRing3: 'finger4-3L',
  LeftPinky1: 'finger5-1L',
  LeftPinky2: 'finger5-2L',
  LeftPinky3: 'finger5-3L',
  RightThumb1: 'finger1-1R',
  RightThumb2: 'finger1-2R',
  RightThumb3: 'finger1-3R',
  RightIndex1: 'finger2-1R',
  RightIndex2: 'finger2-2R',
  RightIndex3: 'finger2-3R',
  RightMiddle1: 'finger3-1R',
  RightMiddle2: 'finger3-2R',
  RightMiddle3: 'finger3-3R',
  RightRing1: 'finger4-1R',
  RightRing2: 'finger4-2R',
  RightRing3: 'finger4-3R',
  RightPinky1: 'finger5-1R',
  RightPinky2: 'finger5-2R',
  RightPinky3: 'finger5-3R',
  Jaw: 'jaw',
  LeftEye: 'eyeL',
  RightEye: 'eyeR',
  LeftBrow: 'oculi01L',
  RightBrow: 'oculi01R',
  UpperLip: 'oris05',
  LowerLip: 'oris01',
  LeftMouthCorner: 'risorius03L',
  RightMouthCorner: 'risorius03R',
  LeftCheek: 'levator05L',
  RightCheek: 'levator05R',
};

/** Find either a native character bone alias or a Mixamo joint name. */
function findBone(root: THREE.Object3D, id: JointId): THREE.Bone | null {
  let found: THREE.Bone | null = null;
  const alias = BONE_ALIASES[id]?.replace(/[^A-Za-z0-9]/g, '');
  root.traverse((obj) => {
    if (found || !(obj as THREE.Bone).isBone) return;
    const clean = obj.name.replace(/[^A-Za-z0-9]/g, '');
    if (clean === alias || clean.endsWith(id)) found = obj as THREE.Bone;
  });
  return found;
}
