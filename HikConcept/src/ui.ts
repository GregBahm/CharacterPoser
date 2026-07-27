import * as THREE from 'three';
import { CharacterRig } from './rig.ts';
import { CONTROL_JOINTS, ROTATABLE_JOINTS, JointId } from './solver.ts';
import { AppState, pointColor } from './state.ts';

const JOINT_LABELS: Record<string, string> = {
  Hips: 'Hips',
  Spine2: 'Chest',
  Head: 'Head',
  LeftArm: 'Left Shoulder',
  LeftForeArm: 'Left Elbow',
  LeftHand: 'Left Wrist',
  RightArm: 'Right Shoulder',
  RightForeArm: 'Right Elbow',
  RightHand: 'Right Wrist',
  LeftUpLeg: 'Left Hip',
  LeftLeg: 'Left Knee',
  LeftFoot: 'Left Ankle',
  RightUpLeg: 'Right Hip',
  RightLeg: 'Right Knee',
  RightFoot: 'Right Ankle',
};

// Body map positions (viewBox 0 0 120 200). Character faces the viewer,
// so the character's left side is on the viewer's right.
const MAP_POS: Record<string, [number, number]> = {
  Head: [60, 20],
  Spine2: [60, 58],
  Hips: [60, 95],
  LeftArm: [81, 52],
  LeftForeArm: [92, 78],
  LeftHand: [99, 104],
  RightArm: [39, 52],
  RightForeArm: [28, 78],
  RightHand: [21, 104],
  LeftUpLeg: [71, 103],
  LeftLeg: [72, 142],
  LeftFoot: [72, 180],
  RightUpLeg: [49, 103],
  RightLeg: [48, 142],
  RightFoot: [48, 180],
};

const FIGURE_SEGMENTS: [string, string][] = [
  ['Head', 'Spine2'],
  ['Spine2', 'Hips'],
  ['Spine2', 'LeftArm'],
  ['LeftArm', 'LeftForeArm'],
  ['LeftForeArm', 'LeftHand'],
  ['Spine2', 'RightArm'],
  ['RightArm', 'RightForeArm'],
  ['RightForeArm', 'RightHand'],
  ['Hips', 'LeftUpLeg'],
  ['LeftUpLeg', 'LeftLeg'],
  ['LeftLeg', 'LeftFoot'],
  ['Hips', 'RightUpLeg'],
  ['RightUpLeg', 'RightLeg'],
  ['RightLeg', 'RightFoot'],
];

export class UI {
  private state: AppState;
  private rig: CharacterRig;
  private circles = new Map<JointId, SVGCircleElement>();
  private btnPin = document.getElementById('btn-pin') as HTMLButtonElement;
  private btnLock = document.getElementById('btn-lock') as HTMLButtonElement;
  private btnRotate = document.getElementById('btn-rotate') as HTMLButtonElement;
  private chkAffectChildren = document.getElementById('chk-affect-children') as HTMLInputElement;
  private btnStretchy = document.getElementById('btn-stretchy') as HTMLButtonElement;
  private jointName = document.getElementById('joint-name') as HTMLElement;

  constructor(state: AppState, rig: CharacterRig) {
    this.state = state;
    this.rig = rig;
    this.buildBodyMap();

    this.btnPin.addEventListener('click', () => this.togglePin());
    this.btnLock.addEventListener('click', () => this.toggleLock());
    this.btnRotate.addEventListener('click', () => state.setRotateMode(!state.rotateMode));
    this.chkAffectChildren.addEventListener('change', () => state.setAffectChildren(this.chkAffectChildren.checked));
    this.btnStretchy.addEventListener('click', () => {
      const on = !state.stretchy;
      rig.setStretchyPinning(on);
      state.setStretchy(on);
    });
    document.getElementById('btn-reset')!.addEventListener('click', () => {
      rig.resetPose();
      rig.solver.setPinned('LeftFoot', true);
      rig.solver.setPinned('RightFoot', true);
      state.emit();
    });

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      switch (e.key.toLowerCase()) {
        case 'p':
          this.togglePin();
          break;
        case 'o':
          this.toggleLock();
          break;
        case 'r':
          state.setRotateMode(!state.rotateMode);
          break;
        case 'escape':
          state.select(null);
          break;
      }
    });

    state.onChange(() => this.render());
    this.render();
  }

  private togglePin() {
    const id = this.state.selected;
    if (!id) return;
    this.rig.solver.setPinned(id, !this.rig.solver.get(id).pinned);
    this.state.emit();
  }

  private toggleLock() {
    const id = this.state.selected;
    if (!id) return;
    if (this.rig.orientOverrides.has(id)) {
      this.rig.clearOrientOverride(id);
      this.rig.applyPose();
    } else {
      const quat = this.rig.getJointWorldQuat(id, new THREE.Quaternion());
      this.rig.setOrientOverride(id, quat);
    }
    this.state.emit();
  }

  private buildBodyMap() {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 120 200');
    svg.setAttribute('width', '170');
    svg.setAttribute('height', '283');

    for (const [a, b] of FIGURE_SEGMENTS) {
      const line = document.createElementNS(svgNS, 'line');
      const [x1, y1] = MAP_POS[a];
      const [x2, y2] = MAP_POS[b];
      line.setAttribute('x1', String(x1));
      line.setAttribute('y1', String(y1));
      line.setAttribute('x2', String(x2));
      line.setAttribute('y2', String(y2));
      line.classList.add('figure');
      svg.appendChild(line);
    }

    for (const id of CONTROL_JOINTS) {
      const circle = document.createElementNS(svgNS, 'circle');
      const [cx, cy] = MAP_POS[id];
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', '5.5');
      circle.classList.add('ctl');
      circle.addEventListener('click', () => this.state.select(id));
      const title = document.createElementNS(svgNS, 'title');
      title.textContent = JOINT_LABELS[id];
      circle.appendChild(title);
      this.circles.set(id, circle);
      svg.appendChild(circle);
    }
    document.getElementById('bodymap')!.appendChild(svg);
  }

  private render() {
    const sel = this.state.selected;
    for (const [id, circle] of this.circles) {
      const pinned = this.rig.solver.get(id).pinned;
      const locked = this.rig.orientOverrides.has(id);
      const selected = sel === id;
      const color = pointColor(selected, pinned, locked);
      circle.setAttribute('fill', `#${color.toString(16).padStart(6, '0')}`);
      circle.classList.toggle('selected', selected);
    }

    this.jointName.textContent = sel ? JOINT_LABELS[sel] : 'none';
    this.btnPin.disabled = !sel;
    this.btnLock.disabled = !sel;
    this.btnRotate.disabled = !sel || !ROTATABLE_JOINTS.includes(sel);
    this.btnPin.classList.toggle('active', !!sel && this.rig.solver.get(sel).pinned);
    this.btnLock.classList.toggle('active', !!sel && this.rig.orientOverrides.has(sel));
    this.btnRotate.classList.toggle('active', this.state.rotateMode && !this.btnRotate.disabled);
    const rotateUsable = this.state.rotateMode && !this.btnRotate.disabled;
    this.chkAffectChildren.disabled = !rotateUsable;
    this.chkAffectChildren.checked = this.state.affectChildren;
    this.btnStretchy.classList.toggle('active', this.state.stretchy);
    this.btnStretchy.textContent = this.state.stretchy ? 'Stretchy Mode: On' : 'Stretchy Mode';
  }
}
