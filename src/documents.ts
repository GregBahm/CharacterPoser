import * as THREE from 'three';
import {
  BODY_CONTROL_JOINTS,
  CONTROL_JOINTS,
  CONTROL_JOINTS_BY_VIEW,
  ControlView,
  FACE_JOINTS,
  isLegRootControlJoint,
  JointId,
  LEFT_HAND_JOINTS,
  PoseGraph,
  RIGHT_HAND_JOINTS,
} from './pose.ts';
import { CameraPose } from './camera-bookmark.ts';
import {
  AmbientLightSettings,
  DirectionalLightSettings,
  LIGHT_RANGES,
  LightingSettings,
  MAX_LIGHTS,
} from './lighting.ts';

export const POSE_DOCUMENT_VERSION = 1;
export const SCENE_DOCUMENT_VERSION = 2;
export const SCENE_KIND = 'character-poser-scene';
export const POSE_KIND = 'character-poser-pose';

export type Vector3Tuple = [number, number, number];
export type QuaternionTuple = [number, number, number, number];

export interface ControlTransformDocument {
  position: Vector3Tuple;
  rotation: QuaternionTuple;
}

export interface PoseDocument {
  kind: typeof POSE_KIND;
  version: typeof POSE_DOCUMENT_VERSION;
  id: string;
  name: string;
  scope: ControlView;
  coordinateSpace: 'world' | 'anchor';
  anchor?: JointId;
  controls: Partial<Record<JointId, ControlTransformDocument>>;
  createdAt: string;
  updatedAt: string;
}

export interface SceneCameraDocument {
  id: string;
  position: Vector3Tuple;
  target: Vector3Tuple;
  fov: number;
  resolution: {
    width: number;
    height: number;
  };
}

export interface SceneCharacterDocument {
  id: string;
  model: string;
  controls: Partial<Record<JointId, ControlTransformDocument>>;
}

export interface ReferenceImageDocument {
  opacity: number;
}

export interface ShotDocument {
  id: string;
  characters: SceneCharacterDocument[];
  activeCharacterId?: string;
  lighting?: LightingSettings;
  mainCamera?: CameraPose;
  referenceImage?: ReferenceImageDocument;
  cameras: [SceneCameraDocument];
  activeCameraId: string;
  activeView: ControlView;
}

export interface SceneDocument {
  kind: typeof SCENE_KIND;
  version: typeof SCENE_DOCUMENT_VERSION;
  id: string;
  name: string;
  shots: ShotDocument[];
  activeShotId: string;
  createdAt: string;
  updatedAt: string;
  /** Runtime-only marker; omitted when the migrated document is saved. */
  migratedFromVersion?: 1;
}

const JOINT_IDS = new Set<string>(CONTROL_JOINTS);
const LEGACY_BODY_CONTROL_JOINTS = BODY_CONTROL_JOINTS.filter((id) => !isLegRootControlJoint(id));
const LEGACY_CONTROL_JOINTS = CONTROL_JOINTS.filter((id) => !isLegRootControlJoint(id));
const CONTROL_VIEWS = new Set<string>(['body', 'leftHand', 'rightHand', 'face']);
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DETAIL_ANCHORS: Record<Exclude<ControlView, 'body'>, JointId> = {
  leftHand: 'LeftHand',
  rightHand: 'RightHand',
  face: 'Head',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function requireDocumentId(value: unknown, path: string): string {
  const id = requireString(value, path);
  if (!DOCUMENT_ID_PATTERN.test(id)) throw new Error(`${path} must match ${DOCUMENT_ID_PATTERN}`);
  return id;
}

function requireTimestamp(value: unknown, path: string): string {
  const timestamp = requireString(value, path);
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`${path} must be an ISO timestamp`);
  return timestamp;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}

function requireTuple(value: unknown, length: 3, path: string): Vector3Tuple;
function requireTuple(value: unknown, length: 4, path: string): QuaternionTuple;
function requireTuple(value: unknown, length: 3 | 4, path: string): Vector3Tuple | QuaternionTuple {
  if (!Array.isArray(value) || value.length !== length) throw new Error(`${path} must contain ${length} numbers`);
  return value.map((item, index) => requireNumber(item, `${path}[${index}]`)) as Vector3Tuple | QuaternionTuple;
}

function parseTransform(value: unknown, path: string): ControlTransformDocument {
  const record = requireRecord(value, path);
  const rotation = requireTuple(record.rotation, 4, `${path}.rotation`);
  const lengthSq = rotation.reduce((sum, component) => sum + component * component, 0);
  if (lengthSq < 1e-12) throw new Error(`${path}.rotation must be a valid quaternion`);
  return {
    position: requireTuple(record.position, 3, `${path}.position`),
    rotation,
  };
}

function parseControls(
  value: unknown,
  requiredIds: readonly JointId[],
  path: string,
): Partial<Record<JointId, ControlTransformDocument>> {
  const record = requireRecord(value, path);
  const controls: Partial<Record<JointId, ControlTransformDocument>> = {};
  for (const [id, transform] of Object.entries(record)) {
    if (!JOINT_IDS.has(id)) throw new Error(`${path} contains unknown joint "${id}"`);
    controls[id as JointId] = parseTransform(transform, `${path}.${id}`);
  }
  for (const id of requiredIds) {
    if (!controls[id]) throw new Error(`${path} is missing joint "${id}"`);
  }
  return controls;
}

function parseView(value: unknown, path: string): ControlView {
  if (typeof value !== 'string' || !CONTROL_VIEWS.has(value)) {
    throw new Error(`${path} must be body, leftHand, rightHand, or face`);
  }
  return value as ControlView;
}

function parseCamera(value: unknown, path: string): SceneCameraDocument {
  const record = requireRecord(value, path);
  const resolution = requireRecord(record.resolution, `${path}.resolution`);
  const width = requireNumber(resolution.width, `${path}.resolution.width`);
  const height = requireNumber(resolution.height, `${path}.resolution.height`);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`${path}.resolution must contain positive integer dimensions`);
  }
  const fov = requireNumber(record.fov, `${path}.fov`);
  if (fov <= 0 || fov >= 180) throw new Error(`${path}.fov must be between 0 and 180`);
  return {
    id: requireDocumentId(record.id, `${path}.id`),
    position: requireTuple(record.position, 3, `${path}.position`),
    target: requireTuple(record.target, 3, `${path}.target`),
    fov,
    resolution: { width, height },
  };
}

export function parsePoseDocument(value: unknown): PoseDocument {
  const record = requireRecord(value, 'pose');
  if (record.kind !== POSE_KIND) throw new Error(`pose.kind must be "${POSE_KIND}"`);
  if (record.version !== POSE_DOCUMENT_VERSION) {
    throw new Error(
      `Unsupported pose version "${String(record.version)}"; expected ${POSE_DOCUMENT_VERSION}`,
    );
  }
  const scope = parseView(record.scope, 'pose.scope');
  const requiredIds = scope === 'body' ? LEGACY_BODY_CONTROL_JOINTS : CONTROL_JOINTS_BY_VIEW[scope].slice(1);
  const coordinateSpace = record.coordinateSpace;
  const expectedSpace = scope === 'body' ? 'world' : 'anchor';
  if (coordinateSpace !== expectedSpace) throw new Error(`pose.coordinateSpace must be "${expectedSpace}"`);
  const anchor = scope === 'body' ? undefined : DETAIL_ANCHORS[scope];
  if (anchor && record.anchor !== anchor) throw new Error(`pose.anchor must be "${anchor}"`);
  return {
    kind: POSE_KIND,
    version: POSE_DOCUMENT_VERSION,
    id: requireString(record.id, 'pose.id'),
    name: requireString(record.name, 'pose.name'),
    scope,
    coordinateSpace: expectedSpace,
    anchor,
    controls: parseControls(record.controls, requiredIds, 'pose.controls'),
    createdAt: requireTimestamp(record.createdAt, 'pose.createdAt'),
    updatedAt: requireTimestamp(record.updatedAt, 'pose.updatedAt'),
  };
}

function requireColor(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${path} must be a #rrggbb color`);
  return value.toLowerCase();
}

function requireInRange(value: unknown, range: { min: number; max: number }, path: string): number {
  const number = requireNumber(value, path);
  if (number < range.min || number > range.max) throw new Error(`${path} must be between ${range.min} and ${range.max}`);
  return number;
}

function parseAmbient(value: unknown, path: string): AmbientLightSettings {
  const record = requireRecord(value, path);
  return {
    color: requireColor(record.color, `${path}.color`),
    intensity: requireInRange(record.intensity, LIGHT_RANGES.ambientIntensity, `${path}.intensity`),
  };
}

function parseLight(value: unknown, path: string): DirectionalLightSettings {
  const record = requireRecord(value, path);
  return {
    color: requireColor(record.color, `${path}.color`),
    intensity: requireInRange(record.intensity, LIGHT_RANGES.intensity, `${path}.intensity`),
    azimuth: requireInRange(record.azimuth, LIGHT_RANGES.azimuth, `${path}.azimuth`),
    elevation: requireInRange(record.elevation, LIGHT_RANGES.elevation, `${path}.elevation`),
    softness: requireInRange(record.softness, LIGHT_RANGES.softness, `${path}.softness`),
  };
}

function parseLighting(value: unknown, path: string): LightingSettings {
  const record = requireRecord(value, path);
  if (!Array.isArray(record.lights) || record.lights.length > MAX_LIGHTS) {
    throw new Error(`${path}.lights must be an array of at most ${MAX_LIGHTS} lights`);
  }
  return {
    ambient: parseAmbient(record.ambient, `${path}.ambient`),
    lights: record.lights.map((light, index) => parseLight(light, `${path}.lights[${index}]`)),
  };
}

function parseCameraPose(value: unknown, path: string): CameraPose {
  const record = requireRecord(value, path);
  const fov = requireNumber(record.fov, `${path}.fov`);
  if (fov <= 0 || fov >= 180) throw new Error(`${path}.fov must be between 0 and 180`);
  return {
    position: requireTuple(record.position, 3, `${path}.position`),
    target: requireTuple(record.target, 3, `${path}.target`),
    fov,
  };
}

function parseSceneCharacter(value: unknown, path: string): SceneCharacterDocument {
  const record = requireRecord(value, path);
  return {
    id: requireString(record.id, `${path}.id`),
    model: requireString(record.model, `${path}.model`),
    controls: parseControls(record.controls, LEGACY_CONTROL_JOINTS, `${path}.controls`),
  };
}

function parseShot(value: unknown, path: string): ShotDocument {
  const record = requireRecord(value, path);
  if (!Array.isArray(record.characters)) throw new Error(`${path}.characters must be an array`);
  const characters = record.characters.map(
    (value, index) => parseSceneCharacter(value, `${path}.characters[${index}]`),
  );
  const ids = new Set(characters.map((character) => character.id));
  if (ids.size !== characters.length) throw new Error(`${path}.characters must have unique ids`);
  let activeCharacterId: string | undefined;
  if (record.activeCharacterId !== undefined) {
    activeCharacterId = requireString(record.activeCharacterId, `${path}.activeCharacterId`);
    if (!ids.has(activeCharacterId)) throw new Error(`${path}.activeCharacterId does not reference a character`);
  }
  const lighting = record.lighting === undefined ? undefined : parseLighting(record.lighting, `${path}.lighting`);
  const mainCamera = record.mainCamera === undefined
    ? undefined
    : parseCameraPose(record.mainCamera, `${path}.mainCamera`);
  const referenceImage = record.referenceImage === undefined
    ? undefined
    : parseReferenceImage(record.referenceImage, `${path}.referenceImage`);
  if (!Array.isArray(record.cameras) || record.cameras.length !== 1) {
    throw new Error(`${path}.cameras must contain exactly one camera in this version`);
  }
  const camera = parseCamera(record.cameras[0], `${path}.cameras[0]`);
  const activeCameraId = requireString(record.activeCameraId, `${path}.activeCameraId`);
  if (activeCameraId !== camera.id) throw new Error(`${path}.activeCameraId does not reference its camera`);
  return {
    id: requireDocumentId(record.id, `${path}.id`),
    characters,
    ...(activeCharacterId !== undefined ? { activeCharacterId } : {}),
    ...(lighting !== undefined ? { lighting } : {}),
    ...(mainCamera !== undefined ? { mainCamera } : {}),
    ...(referenceImage !== undefined ? { referenceImage } : {}),
    cameras: [camera],
    activeCameraId,
    activeView: parseView(record.activeView, `${path}.activeView`),
  };
}

function parseReferenceImage(value: unknown, path: string): ReferenceImageDocument {
  const record = requireRecord(value, path);
  const opacity = requireNumber(record.opacity, `${path}.opacity`);
  if (opacity < 0 || opacity > 1) throw new Error(`${path}.opacity must be between 0 and 1`);
  return { opacity };
}

export function parseSceneDocument(value: unknown): SceneDocument {
  const record = requireRecord(value, 'scene');
  if (record.kind !== SCENE_KIND) throw new Error(`scene.kind must be "${SCENE_KIND}"`);
  const id = requireString(record.id, 'scene.id');
  const name = requireString(record.name, 'scene.name');
  const createdAt = requireTimestamp(record.createdAt, 'scene.createdAt');
  const updatedAt = requireTimestamp(record.updatedAt, 'scene.updatedAt');

  if (record.version === 1) {
    const shot = parseShot({ ...record, id: `shot-${id}`.slice(0, 64) }, 'scene.shots[0]');
    return {
      kind: SCENE_KIND,
      version: SCENE_DOCUMENT_VERSION,
      id,
      name,
      shots: [shot],
      activeShotId: shot.id,
      createdAt,
      updatedAt,
      migratedFromVersion: 1,
    };
  }
  if (record.version !== SCENE_DOCUMENT_VERSION) {
    throw new Error(
      `Unsupported scene version "${String(record.version)}"; expected 1 or ${SCENE_DOCUMENT_VERSION}`,
    );
  }
  if (!Array.isArray(record.shots) || record.shots.length === 0) {
    throw new Error('scene.shots must contain at least one shot');
  }
  const shots = record.shots.map((shot, index) => parseShot(shot, `scene.shots[${index}]`));
  const shotIds = new Set(shots.map((shot) => shot.id));
  if (shotIds.size !== shots.length) throw new Error('scene.shots must have unique ids');
  const activeShotId = requireString(record.activeShotId, 'scene.activeShotId');
  if (!shotIds.has(activeShotId)) throw new Error('scene.activeShotId does not reference a shot');
  return {
    kind: SCENE_KIND,
    version: SCENE_DOCUMENT_VERSION,
    id,
    name,
    shots,
    activeShotId,
    createdAt: requireTimestamp(record.createdAt, 'scene.createdAt'),
    updatedAt: requireTimestamp(record.updatedAt, 'scene.updatedAt'),
  };
}

function toPosition(value: THREE.Vector3): Vector3Tuple {
  return [value.x, value.y, value.z];
}

function toRotation(value: THREE.Quaternion): QuaternionTuple {
  return [value.x, value.y, value.z, value.w];
}

function transform(position: THREE.Vector3, rotation: THREE.Quaternion): ControlTransformDocument {
  return { position: toPosition(position), rotation: toRotation(rotation) };
}

function applyTransform(pose: PoseGraph, id: JointId, value: ControlTransformDocument) {
  const node = pose.get(id);
  node.pos.fromArray(value.position);
  node.quat.fromArray(value.rotation).normalize();
}

/** Reconstruct hip controls in documents saved before those controls existed. */
function applyMissingLegRootControls(
  pose: PoseGraph,
  controls: Partial<Record<JointId, ControlTransformDocument>>,
) {
  const hips = pose.get('Hips');
  for (const id of ['LeftUpLeg', 'RightUpLeg'] as const) {
    if (controls[id]) continue;
    const node = pose.get(id);
    node.pos
      .subVectors(pose.bindPositions.get(id)!, pose.bindPositions.get('Hips')!)
      .applyQuaternion(hips.quat)
      .add(hips.pos);
    node.quat.copy(hips.quat);
  }
}

function detailIdsForAnchor(anchor: JointId): JointId[] {
  if (anchor === 'LeftHand') return LEFT_HAND_JOINTS;
  if (anchor === 'RightHand') return RIGHT_HAND_JOINTS;
  return FACE_JOINTS;
}

function captureAnchorRelative(pose: PoseGraph, anchor: JointId, ids: readonly JointId[]) {
  const anchorNode = pose.get(anchor);
  const inverseAnchor = anchorNode.quat.clone().invert();
  const controls: Partial<Record<JointId, ControlTransformDocument>> = {};
  for (const id of ids) {
    const node = pose.get(id);
    const position = node.pos.clone().sub(anchorNode.pos).applyQuaternion(inverseAnchor);
    const rotation = inverseAnchor.clone().multiply(node.quat);
    controls[id] = transform(position, rotation);
  }
  return controls;
}

function applyAnchorRelative(
  pose: PoseGraph,
  anchor: JointId,
  controls: Partial<Record<JointId, ControlTransformDocument>>,
) {
  const anchorNode = pose.get(anchor);
  for (const id of detailIdsForAnchor(anchor)) {
    const value = controls[id];
    if (!value) continue;
    const node = pose.get(id);
    node.pos.fromArray(value.position).applyQuaternion(anchorNode.quat).add(anchorNode.pos);
    node.quat.copy(anchorNode.quat).multiply(new THREE.Quaternion().fromArray(value.rotation)).normalize();
  }
}

export function createPoseDocument(
  id: string,
  name: string,
  scope: ControlView,
  pose: PoseGraph,
  createdAt = new Date().toISOString(),
): PoseDocument {
  if (scope === 'body') {
    const controls: Partial<Record<JointId, ControlTransformDocument>> = {};
    for (const joint of BODY_CONTROL_JOINTS) {
      const node = pose.get(joint);
      controls[joint] = transform(node.pos, node.quat);
    }
    return {
      kind: POSE_KIND,
      version: POSE_DOCUMENT_VERSION,
      id,
      name,
      scope,
      coordinateSpace: 'world',
      controls,
      createdAt,
      updatedAt: createdAt,
    };
  }

  const anchor = DETAIL_ANCHORS[scope];
  return {
    kind: POSE_KIND,
    version: POSE_DOCUMENT_VERSION,
    id,
    name,
    scope,
    coordinateSpace: 'anchor',
    anchor,
    controls: captureAnchorRelative(pose, anchor, CONTROL_JOINTS_BY_VIEW[scope].slice(1)),
    createdAt,
    updatedAt: createdAt,
  };
}

export function applyPoseDocument(pose: PoseGraph, document: PoseDocument) {
  if (document.scope !== 'body') {
    applyAnchorRelative(pose, document.anchor!, document.controls);
    return;
  }

  const preservedDetails = {
    LeftHand: captureAnchorRelative(pose, 'LeftHand', LEFT_HAND_JOINTS),
    RightHand: captureAnchorRelative(pose, 'RightHand', RIGHT_HAND_JOINTS),
    Head: captureAnchorRelative(pose, 'Head', FACE_JOINTS),
  };
  for (const id of BODY_CONTROL_JOINTS) {
    const value = document.controls[id];
    if (value) applyTransform(pose, id, value);
  }
  applyMissingLegRootControls(pose, document.controls);
  applyAnchorRelative(pose, 'LeftHand', preservedDetails.LeftHand);
  applyAnchorRelative(pose, 'RightHand', preservedDetails.RightHand);
  applyAnchorRelative(pose, 'Head', preservedDetails.Head);
}

export function serializeAllControls(pose: PoseGraph): Record<JointId, ControlTransformDocument> {
  return Object.fromEntries(CONTROL_JOINTS.map((id) => {
    const node = pose.get(id);
    return [id, transform(node.pos, node.quat)];
  })) as Record<JointId, ControlTransformDocument>;
}

export function applySceneControls(
  pose: PoseGraph,
  controls: Partial<Record<JointId, ControlTransformDocument>>,
) {
  for (const id of CONTROL_JOINTS) {
    const value = controls[id];
    if (value) applyTransform(pose, id, value);
  }
  applyMissingLegRootControls(pose, controls);
}
