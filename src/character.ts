import * as THREE from 'three';
import { ControlPoints } from './control-points.ts';
import { applySceneControls, ControlTransformDocument } from './documents.ts';
import { CharacterModel } from './models.ts';
import { JointId, PoseGraph } from './pose.ts';
import { CharacterRig } from './rig.ts';

let nextCharacterNumber = 1;

export interface CharacterLoadOptions {
  /** Id from a saved scene; a fresh one is made otherwise. */
  id?: string;
  /** Saved control transforms to start from instead of the base pose. */
  controls?: Record<JointId, ControlTransformDocument>;
  /** Where to stand the base pose (world offset of the whole character). */
  offset?: THREE.Vector3;
}

/** A posable character in the scene: its model, loaded rig, pose graph, and control points. */
export class Character {
  readonly points: ControlPoints;

  private constructor(
    readonly id: string,
    readonly model: CharacterModel,
    readonly rig: CharacterRig,
    readonly pose: PoseGraph,
  ) {
    this.points = new ControlPoints(id, pose);
  }

  static async load(model: CharacterModel, options: CharacterLoadOptions = {}): Promise<Character> {
    const rig = await CharacterRig.load(model.url);
    const id = options.id ?? `character-${Date.now().toString(36)}-${nextCharacterNumber++}`;
    const character = new Character(id, model, rig, new PoseGraph(rig.bindWorldPositions));
    if (options.controls) applySceneControls(character.pose, options.controls);
    else if (options.offset) character.pose.translate('Hips', options.offset, true);
    character.applyPose();
    return character;
  }

  /** Fit the mesh to the current pose. */
  applyPose() {
    this.rig.applyPose(this.pose.solveSkeleton());
  }

  /** Release GPU resources once the character has left the scene. */
  dispose() {
    this.rig.dispose();
    this.points.dispose();
  }
}
