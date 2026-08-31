import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import {
  frameQuat,
  isDetailJoint,
  isFingerJoint,
  JOINT_DEFS,
  JointId,
  SolvedSkeleton,
} from './pose.ts';

interface BoneBinding {
  id: JointId;
  parent: JointId | null;
  bone: THREE.Bone;
  bindWorldQuat: THREE.Quaternion;
  bindWorldScale: THREE.Vector3;
  /**
   * For single-child segment bones: unit direction (bone-local) toward the
   * child joint. The bone stretches along this axis to span the solved
   * joints. Null for the root/branching bones (Hips, Spine2) and leaves.
   */
  stretchAxis: THREE.Vector3 | null;
}

const CHARACTER_HEIGHT = 1.75; // meters
/**
 * Longest texture edge kept in memory. The models embed 8K diffuse maps;
 * three of those at full size (~270 MB each decoded, more with mipmaps)
 * crash the tab, and 4K is more than a posing view needs.
 */
const MAX_TEXTURE_SIZE = 4096;

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
    // The diffuse texture is embedded in the FBX and decoded asynchronously
    // after parsing; wait for it so every render mode (and the path tracer's
    // texture upload) sees a finished image.
    const manager = new THREE.LoadingManager();
    const texturesLoaded = new Promise<void>((resolve) => {
      manager.onLoad = () => resolve();
    });
    manager.onError = (item) => console.warn(`Could not load ${item}`);
    const fbx = await new FBXLoader(manager).loadAsync(url);
    await texturesLoaded;

    // One standard material per mesh carrying the model's diffuse map; the
    // render modes derive their untextured/textured variants from it.
    const maps: THREE.Texture[] = [];
    fbx.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const source = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshPhongMaterial;
      const map = source.map ?? null;
      if (map) {
        map.colorSpace = THREE.SRGBColorSpace;
        maps.push(map);
      }
      mesh.material = new THREE.MeshStandardMaterial({
        color: map ? 0xffffff : 0xb8bdc7,
        map,
        roughness: 0.65,
        metalness: 0.05,
      });
      for (const material of Array.isArray(mesh.material) ? mesh.material : [source]) {
        for (const value of Object.values(material)) {
          if ((value as THREE.Texture)?.isTexture && value !== map) (value as THREE.Texture).dispose();
        }
        material.dispose();
      }
      mesh.castShadow = true;
      mesh.frustumCulled = false; // skinned mesh moves far from its bind bbox
    });
    for (const map of maps) await limitTextureSize(map);

    const bones = new Map<JointId, THREE.Bone>();
    for (const def of JOINT_DEFS) {
      const bone = findBone(fbx, BONE_NAMES[def.id]);
      if (!bone) throw new Error(`Could not find bone "${BONE_NAMES[def.id]}" for joint "${def.id}" in ${url}`);
      bones.set(def.id, bone);
    }

    // Stand the model up facing +Z, normalize its height, and rest the feet
    // on the ground plane.
    const group = new THREE.Group();
    group.add(orientUpright(fbx, bones));
    const bounds = bindPoseBounds(group);
    const scale = CHARACTER_HEIGHT / (bounds.max.y - bounds.min.y);
    group.scale.setScalar(scale);
    group.position.y = -bounds.min.y * scale;
    group.updateWorldMatrix(true, true);

    const rig = new CharacterRig(group);
    for (const def of JOINT_DEFS) {
      const bone = bones.get(def.id)!;
      rig.bindings.set(def.id, {
        id: def.id,
        parent: def.parent,
        bone,
        bindWorldQuat: bone.getWorldQuaternion(new THREE.Quaternion()),
        bindWorldScale: bone.getWorldScale(new THREE.Vector3()),
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
      const binding = rig.bindings.get(id)!;
      const axis = new THREE.Vector3()
        .subVectors(rig.bindWorldPositions.get(children[0].id)!, rig.bindWorldPositions.get(id)!)
        .applyQuaternion(binding.bindWorldQuat.clone().invert());
      if (axis.lengthSq() > 1e-10) rig.bindings.get(id)!.stretchAxis = axis.normalize();
    }

    return rig;
  }

  getBone(id: JointId): THREE.Bone {
    return this.bindings.get(id)!.bone;
  }

  /** Release GPU resources; call after the rig has left the scene. */
  dispose() {
    this.root.traverse((obj) => {
      const mesh = obj as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        (material as THREE.MeshStandardMaterial).map?.dispose();
        material.dispose();
      }
      if (mesh.isSkinnedMesh) mesh.skeleton.dispose();
    });
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
   * shortens to meet the control points. Every downstream mapped joint gets
   * an exact world transform so inherited scale stops at the segment.
   */
  applyPose(solved: SolvedSkeleton) {
    const v0 = new THREE.Vector3();
    const v1 = new THREE.Vector3();
    const s0 = new THREE.Vector3();
    const s1 = new THREE.Vector3();
    const desiredWorld = new THREE.Matrix4();
    const parentInverse = new THREE.Matrix4();
    const scaleM = new THREE.Matrix4();

    // Every mapped joint gets an exact world transform. This cancels any
    // scale inherited through unmapped helper bones before applying the
    // joint's own axial stretch, so scaling one segment cannot lengthen
    // descendants. Unmapped bones (twist helpers, toes, bone tips) simply
    // ride along with their mapped parent.
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

      bone.parent!.updateWorldMatrix(true, false);
      desiredWorld.compose(jointPos, targetWorld, binding.bindWorldScale);
      parentInverse.copy(bone.parent!.matrixWorld).invert();
      bone.matrix.copy(parentInverse).multiply(desiredWorld);

      if (binding.stretchAxis && children?.length === 1) {
        const child = children[0];
        const bindLength = this.bindWorldPositions.get(child.id)!.distanceTo(jointBind);
        const solvedLength = solved.pos.get(child.id)!.distanceTo(jointPos);
        if (bindLength > 1e-6) {
          axialScale(scaleM, binding.stretchAxis, solvedLength / bindLength);
          bone.matrix.multiply(scaleM);
        }
      }

      bone.updateWorldMatrix(false, false);
    }

    this.root.updateWorldMatrix(true, true);
  }
}

/** Shrink an oversized texture in place (off-thread resize) so several characters fit in memory. */
async function limitTextureSize(texture: THREE.Texture) {
  const image = texture.image as { width?: number; height?: number } | undefined;
  if (!image?.width || !image.height || Math.max(image.width, image.height) <= MAX_TEXTURE_SIZE) return;
  const scale = MAX_TEXTURE_SIZE / Math.max(image.width, image.height);
  // WebGL ignores UNPACK_FLIP_Y for ImageBitmaps, so bake the flip in here.
  const bitmap = await createImageBitmap(texture.image as ImageBitmapSource, {
    resizeWidth: Math.round(image.width * scale),
    resizeHeight: Math.round(image.height * scale),
    resizeQuality: 'high',
    imageOrientation: texture.flipY ? 'flipY' : 'none',
  });
  texture.image = bitmap;
  texture.flipY = false;
  texture.needsUpdate = true;
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

/**
 * Wrap the loaded model so it stands on +Y facing +Z whichever axes the file
 * used (Renderpeople ships Z-up and Y-up exports; FBXLoader converts
 * neither). Up is read from hips->head and left from the shoulder line,
 * each snapped to the nearest world axis so an upright model stays exactly
 * upright.
 */
function orientUpright(fbx: THREE.Group, bones: Map<JointId, THREE.Bone>): THREE.Object3D {
  fbx.updateWorldMatrix(true, true);
  const at = (id: JointId) => bones.get(id)!.getWorldPosition(new THREE.Vector3());
  const up = snapToAxis(at('Head').sub(at('Hips')));
  const left = snapToAxis(at('LeftArm').sub(at('RightArm')));
  if (Math.abs(up.dot(left)) > 0.5) throw new Error('Could not determine which way the model is standing');
  const forward = new THREE.Vector3().crossVectors(left, up);
  // The model's (left, up, forward) frame in file axes; undoing it maps
  // left -> +X, up -> +Y, forward -> +Z.
  const fileFrame = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(left, up, forward));
  const oriented = new THREE.Group();
  oriented.quaternion.copy(fileFrame.invert());
  oriented.add(fbx);
  return oriented;
}

/**
 * World bounds of the model in its bind pose: each mesh's geometry bounds
 * under its current transform, which is exactly where a skinned vertex sits
 * before any bone moves. (Box3.setFromObject would measure a SkinnedMesh
 * through its skin instead, and that only agrees with the transform once a
 * render has refreshed the skin's bind matrices.)
 */
function bindPoseBounds(root: THREE.Object3D): THREE.Box3 {
  root.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3();
  const box = new THREE.Box3();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.computeBoundingBox();
    bounds.union(box.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld));
  });
  return bounds;
}

function snapToAxis(v: THREE.Vector3): THREE.Vector3 {
  const magnitudes = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
  const axis = magnitudes.indexOf(Math.max(...magnitudes));
  return new THREE.Vector3().setComponent(axis, Math.sign(v.getComponent(axis)) || 1);
}

/** Renderpeople rig bone for each joint (shared by every bundled model). */
const BONE_NAMES: Record<JointId, string> = {
  Hips: 'hip',
  Spine: 'spine_01',
  Spine1: 'spine_02',
  Spine2: 'spine_03',
  Neck: 'neck',
  Head: 'head',
  LeftShoulder: 'shoulder_l',
  LeftArm: 'upperarm_l',
  LeftForeArm: 'lowerarm_l',
  LeftHand: 'hand_l',
  RightShoulder: 'shoulder_r',
  RightArm: 'upperarm_r',
  RightForeArm: 'lowerarm_r',
  RightHand: 'hand_r',
  LeftUpLeg: 'upperleg_l',
  LeftLeg: 'lowerleg_l',
  LeftFoot: 'foot_l',
  RightUpLeg: 'upperleg_r',
  RightLeg: 'lowerleg_r',
  RightFoot: 'foot_r',
  LeftThumb1: 'thumb_01_l',
  LeftThumb2: 'thumb_02_l',
  LeftThumb3: 'thumb_03_l',
  LeftIndex1: 'index_01_l',
  LeftIndex2: 'index_02_l',
  LeftIndex3: 'index_03_l',
  LeftMiddle1: 'middle_01_l',
  LeftMiddle2: 'middle_02_l',
  LeftMiddle3: 'middle_03_l',
  LeftRing1: 'ring_01_l',
  LeftRing2: 'ring_02_l',
  LeftRing3: 'ring_03_l',
  LeftPinky1: 'pinky_01_l',
  LeftPinky2: 'pinky_02_l',
  LeftPinky3: 'pinky_03_l',
  RightThumb1: 'thumb_01_r',
  RightThumb2: 'thumb_02_r',
  RightThumb3: 'thumb_03_r',
  RightIndex1: 'index_01_r',
  RightIndex2: 'index_02_r',
  RightIndex3: 'index_03_r',
  RightMiddle1: 'middle_01_r',
  RightMiddle2: 'middle_02_r',
  RightMiddle3: 'middle_03_r',
  RightRing1: 'ring_01_r',
  RightRing2: 'ring_02_r',
  RightRing3: 'ring_03_r',
  RightPinky1: 'pinky_01_r',
  RightPinky2: 'pinky_02_r',
  RightPinky3: 'pinky_03_r',
  Jaw: 'jaw',
  LeftEye: 'eye_l',
  RightEye: 'eye_r',
  LeftBrow: 'eyebrow_l',
  RightBrow: 'eyebrow_r',
  LeftMouthCorner: 'mouth_l',
  RightMouthCorner: 'mouth_r',
};

function findBone(root: THREE.Object3D, name: string): THREE.Bone | null {
  let found: THREE.Bone | null = null;
  root.traverse((obj) => {
    if (!found && (obj as THREE.Bone).isBone && obj.name === name) found = obj as THREE.Bone;
  });
  return found;
}
