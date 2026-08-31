import * as THREE from 'three';
import { Character } from './character.ts';
import { ControlTransformDocument } from './documents.ts';
import { CharacterModel } from './models.ts';
import { JointId } from './pose.ts';
import { AppState } from './state.ts';

/** Puts characters on screen: the mesh in the 3D scene, the control points in the overlay. */
export interface CharacterHost {
  attach(character: Character): void;
  detach(character: Character): void;
}

/** Gap between a new character and the one standing furthest along +X. */
const SPAWN_SPACING = 1.25;

/**
 * The characters in the scene. Adding loads a model in its base pose beside
 * the others (or exactly as saved) and makes it active if nothing is;
 * removing hands active status to another character.
 */
export class CharacterScene {
  characters: Character[] = [];
  private listeners: (() => void)[] = [];

  constructor(
    private state: AppState,
    private host: CharacterHost,
  ) {}

  get active(): Character | null {
    return this.get(this.state.activeCharacter);
  }

  get(id: string | null): Character | null {
    return this.characters.find((character) => character.id === id) ?? null;
  }

  /** Fires after a character is added or removed. */
  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  async add(
    model: CharacterModel,
    saved?: { id: string; controls: Partial<Record<JointId, ControlTransformDocument>> },
  ): Promise<Character> {
    const character = await Character.load(model, saved ?? { offset: this.spawnOffset() });
    this.characters.push(character);
    this.host.attach(character);
    if (this.state.activeCharacter === null) this.state.setActiveCharacter(character.id);
    this.emit();
    return character;
  }

  remove(character: Character) {
    const index = this.characters.indexOf(character);
    if (index < 0) return;
    this.characters.splice(index, 1);
    this.host.detach(character);
    character.dispose();
    if (this.state.activeCharacter === character.id) {
      this.state.setActiveCharacter(this.characters[0]?.id ?? null);
    }
    this.emit();
  }

  clear() {
    for (const character of [...this.characters]) this.remove(character);
  }

  /** Fit every character's mesh to its pose. */
  applyPoses() {
    for (const character of this.characters) character.applyPose();
  }

  /** Control spheres that can currently be picked, across all characters. */
  pickMeshes(): THREE.Mesh[] {
    return this.characters.flatMap((character) => character.points.meshes);
  }

  /** World bounds of every character's control points; null when the scene is empty. */
  bounds(target = new THREE.Box3()): THREE.Box3 | null {
    if (this.characters.length === 0) return null;
    target.makeEmpty();
    for (const character of this.characters) {
      for (const node of character.pose.nodes.values()) target.expandByPoint(node.pos);
    }
    return target;
  }

  private spawnOffset(): THREE.Vector3 {
    if (this.characters.length === 0) return new THREE.Vector3();
    const furthest = Math.max(...this.characters.map((character) => character.pose.get('Hips').pos.x));
    return new THREE.Vector3(furthest + SPAWN_SPACING, 0, 0);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}
