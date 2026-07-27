import { JointId } from './solver.ts';

export const COLORS = {
  free: 0x4da6ff,
  pinned: 0xff5566,
  lockedFree: 0x2a5f9e,
  lockedPinned: 0xa8323f,
  selected: 0xffd24d,
  selectedPinned: 0xff9a3d,
};

/** Control-point color for a given selection/pin/lock state. */
export function pointColor(selected: boolean, pinned: boolean, locked: boolean): number {
  if (selected) return pinned ? COLORS.selectedPinned : COLORS.selected;
  if (pinned) return locked ? COLORS.lockedPinned : COLORS.pinned;
  return locked ? COLORS.lockedFree : COLORS.free;
}

/** Shared selection/tool state, observed by both the 3D view and the sidebar. */
export class AppState {
  selected: JointId | null = null;
  rotateMode = false;
  affectChildren = false;
  stretchy = false;

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

  setAffectChildren(on: boolean) {
    if (this.affectChildren === on) return;
    this.affectChildren = on;
    this.emit();
  }

  setStretchy(on: boolean) {
    if (this.stretchy === on) return;
    this.stretchy = on;
    this.emit();
  }
}
