import { JointId } from './solver.ts';

export const COLORS = {
  free: 0x4da6ff,
  pinned: 0xff5566,
  selected: 0xffd24d,
  selectedPinned: 0xff9a3d,
};

/** Shared selection/tool state, observed by both the 3D view and the sidebar. */
export class AppState {
  selected: JointId | null = null;
  rotateMode = false;

  private listeners: (() => void)[] = [];

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  emit() {
    for (const fn of this.listeners) fn();
  }

  select(id: JointId | null) {
    if (this.selected === id) return;
    this.selected = id;
    this.emit();
  }

  setRotateMode(on: boolean) {
    if (this.rotateMode === on) return;
    this.rotateMode = on;
    this.emit();
  }
}
