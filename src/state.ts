import { ControlView, JointId } from './pose.ts';

export const COLORS = {
  free: 0x4da6ff,
  selected: 0xffd24d,
  ring: 0x39e0d0,
  stretchRing: 0xc9a6ff,
  helper: 0xff8a3d,
};

export function pointColor(selected: boolean): number {
  return selected ? COLORS.selected : COLORS.free;
}

/** Shared selection state, observed by both the 3D view and the sidebar. */
export class AppState {
  selected: JointId | null = null;
  activeView: ControlView = 'body';

  private listeners: (() => void)[] = [];
  private selections: Record<ControlView, JointId | null> = {
    body: null,
    leftHand: 'LeftHand',
    rightHand: 'RightHand',
    face: 'Head',
  };

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  select(id: JointId | null) {
    if (this.selected === id) return;
    this.selected = id;
    this.selections[this.activeView] = id;
    this.emit();
  }

  setView(view: ControlView) {
    if (this.activeView === view) return;
    this.activeView = view;
    this.selected = this.selections[view];
    this.emit();
  }
}
