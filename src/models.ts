/** A character model shipped in public/, referenced by URL in scene documents. */
export interface CharacterModel {
  /** Display name in the character dropdown. */
  label: string;
  /** Served path of the FBX file; also the model reference stored in scenes. */
  url: string;
}

export const CHARACTER_MODELS: readonly CharacterModel[] = [
  { label: 'Carla', url: '/rp_carla_rigged_001_zup_a.fbx' },
  { label: 'Claudia', url: '/rp_claudia_rigged_002_yup_a.fbx' },
  { label: 'Eric', url: '/rp_eric_rigged_001_yup_a.fbx' },
];

export const DEFAULT_CHARACTER_MODEL = CHARACTER_MODELS[0];

export function findCharacterModel(url: string): CharacterModel | undefined {
  return CHARACTER_MODELS.find((model) => model.url === url);
}
