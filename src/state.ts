import { ControlView, JointId } from './pose.ts';

export const COLORS = {
  free: 0x4da6ff,
  freeHover: 0x86c5ff,
  selected: 0xffd24d,
  selectedHover: 0xffe88a,
  ring: 0xc8cdd4,
  ringHover: 0xffffff,
  stretchRing: 0xc9a6ff,
  helper: 0xff8a3d,
  helperHover: 0xffb27d,
};

export function pointColor(selected: boolean, hovered = false): number {
  if (selected) return hovered ? COLORS.selectedHover : COLORS.selected;
  return hovered ? COLORS.freeHover : COLORS.free;
}

const ALWAYS_SHOW_KEY = 'characterPoser.alwaysShowPoints';

function loadAlwaysShowPoints(): boolean {
  try {
    return localStorage.getItem(ALWAYS_SHOW_KEY) !== '0';
  } catch {
    return true;
  }
}

function defaultSelections(): Record<ControlView, JointId | null> {
  return {
    body: null,
    leftHand: 'LeftHand',
    rightHand: 'RightHand',
    face: 'Head',
  };
}

/**
 * Shared selection state, observed by both the 3D view and the sidebar.
 * The selection is a joint of the active character; picking a joint on
 * another character makes that one active. Detail views (hands, face) only
 * ever show the active character.
 */
export class AppState {
  /** Id of the character whose joint is selected and whose details are shown. */
  activeCharacter: string | null = null;
  selected: JointId | null = null;
  activeView: ControlView = 'body';
  /**
   * Draw every control point all the time; when off, a character's points
   * only show while the mouse is over it (per-browser preference).
   */
  alwaysShowPoints = loadAlwaysShowPoints();

  private listeners: (() => void)[] = [];
  private selections = defaultSelections();

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  setAlwaysShowPoints(on: boolean) {
    if (this.alwaysShowPoints === on) return;
    this.alwaysShowPoints = on;
    try {
      localStorage.setItem(ALWAYS_SHOW_KEY, on ? '1' : '0');
    } catch {
      /* private mode etc. */
    }
    this.emit();
  }

  /** Select a joint, on the active character unless `characterId` names another. */
  select(id: JointId | null, characterId: string | null = this.activeCharacter) {
    if (id !== null && characterId === null) return;
    const characterChanged = id !== null && characterId !== this.activeCharacter;
    if (!characterChanged && this.selected === id) return;
    if (characterChanged) {
      this.activeCharacter = characterId;
      this.selections = defaultSelections();
    }
    this.selected = id;
    this.selections[this.activeView] = id;
    this.emit();
  }

  /** Make a character active with its view's default selection (after add/delete). */
  setActiveCharacter(id: string | null) {
    if (this.activeCharacter === id) return;
    this.activeCharacter = id;
    this.selections = defaultSelections();
    this.selected = id === null ? null : this.selections[this.activeView];
    this.emit();
  }

  setView(view: ControlView) {
    if (this.activeView === view) return;
    this.activeView = view;
    this.selected = this.activeCharacter === null ? null : this.selections[view];
    this.emit();
  }
}
