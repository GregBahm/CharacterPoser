import { CONTROL_JOINTS, JointId } from './pose.ts';
import { AppState, pointColor } from './state.ts';

const JOINT_LABELS: Record<string, string> = {
  Hips: 'Hips',
  Spine2: 'Chest',
  Head: 'Head',
  LeftArm: 'Left Shoulder',
  LeftForeArm: 'Left Elbow',
  LeftHand: 'Left Hand',
  RightArm: 'Right Shoulder',
  RightForeArm: 'Right Elbow',
  RightHand: 'Right Hand',
  LeftLeg: 'Left Knee',
  LeftFoot: 'Left Foot',
  RightLeg: 'Right Knee',
  RightFoot: 'Right Foot',
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
  LeftLeg: [70, 140],
  LeftFoot: [72, 180],
  RightLeg: [50, 140],
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
  ['Hips', 'LeftLeg'],
  ['LeftLeg', 'LeftFoot'],
  ['Hips', 'RightLeg'],
  ['RightLeg', 'RightFoot'],
];

/** Sidebar: HIK-style quick-select body map plus selection info and reset. */
export class UI {
  private state: AppState;
  private circles = new Map<JointId, SVGCircleElement>();
  private jointName = document.getElementById('joint-name') as HTMLElement;

  constructor(state: AppState, onReset: () => void) {
    this.state = state;
    this.buildBodyMap();

    document.getElementById('btn-reset')!.addEventListener('click', onReset);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') state.select(null);
    });

    state.onChange(() => this.render());
    this.render();
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
      const selected = sel === id;
      circle.setAttribute('fill', `#${pointColor(selected).toString(16).padStart(6, '0')}`);
      circle.classList.toggle('selected', selected);
    }
    this.jointName.textContent = sel ? JOINT_LABELS[sel] : 'none';
  }
}
