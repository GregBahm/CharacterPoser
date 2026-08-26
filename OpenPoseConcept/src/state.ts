import { JointId } from './pose.ts';

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
}
