import {
  CONTROL_JOINTS_BY_VIEW,
  ControlView,
  JointId,
} from './pose.ts';
import { AppState, pointColor } from './state.ts';

const JOINT_LABELS: Partial<Record<JointId, string>> = {
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
  Jaw: 'Jaw',
  LeftEye: 'Left Eye',
  RightEye: 'Right Eye',
  LeftBrow: 'Left Brow',
  RightBrow: 'Right Brow',
  UpperLip: 'Upper Lip',
  LowerLip: 'Lower Lip',
  LeftMouthCorner: 'Left Mouth Corner',
  RightMouthCorner: 'Right Mouth Corner',
  LeftCheek: 'Left Cheek',
  RightCheek: 'Right Cheek',
};

for (const side of ['Left', 'Right'] as const) {
  for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const) {
    for (const segment of [1, 2, 3] as const) {
      const id = `${side}${finger}${segment}` as JointId;
      JOINT_LABELS[id] = `${side} ${finger} ${segment}`;
    }
  }
}

type MapPosition = [number, number];
type ViewMap = {
  title: string;
  height: number;
  positions: Partial<Record<JointId, MapPosition>>;
  segments: [JointId, JointId][];
};

const BODY_POSITIONS: Partial<Record<JointId, MapPosition>> = {
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

const BODY_SEGMENTS: [JointId, JointId][] = [
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

function handMap(side: 'Left' | 'Right'): ViewMap {
  const x = (value: number) => side === 'Left' ? value : 120 - value;
  const id = (finger: string, segment: number) => `${side}${finger}${segment}` as JointId;
  const hand = `${side}Hand` as JointId;
  const positions: Partial<Record<JointId, MapPosition>> = {
    [hand]: [60, 174],
    [id('Thumb', 1)]: [x(44), 150],
    [id('Thumb', 2)]: [x(34), 132],
    [id('Thumb', 3)]: [x(24), 116],
    [id('Index', 1)]: [x(48), 127],
    [id('Index', 2)]: [x(45), 94],
    [id('Index', 3)]: [x(43), 62],
    [id('Middle', 1)]: [60, 121],
    [id('Middle', 2)]: [60, 83],
    [id('Middle', 3)]: [60, 45],
    [id('Ring', 1)]: [x(72), 127],
    [id('Ring', 2)]: [x(76), 94],
    [id('Ring', 3)]: [x(79), 63],
    [id('Pinky', 1)]: [x(84), 137],
    [id('Pinky', 2)]: [x(92), 111],
    [id('Pinky', 3)]: [x(99), 87],
  };
  const segments: [JointId, JointId][] = [];
  for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
    segments.push([hand, id(finger, 1)], [id(finger, 1), id(finger, 2)], [id(finger, 2), id(finger, 3)]);
  }
  return { title: `${side} Hand Controls`, height: 190, positions, segments };
}

const VIEW_MAPS: Record<ControlView, ViewMap> = {
  body: {
    title: 'Body Controls',
    height: 200,
    positions: BODY_POSITIONS,
    segments: BODY_SEGMENTS,
  },
  leftHand: handMap('Left'),
  rightHand: handMap('Right'),
  face: {
    title: 'Face Controls',
    height: 150,
    positions: {
      Head: [60, 20],
      LeftBrow: [78, 45],
      RightBrow: [42, 45],
      LeftEye: [78, 63],
      RightEye: [42, 63],
      LeftCheek: [83, 85],
      RightCheek: [37, 85],
      LeftMouthCorner: [75, 106],
      RightMouthCorner: [45, 106],
      UpperLip: [60, 101],
      LowerLip: [60, 114],
      Jaw: [60, 137],
    },
    segments: [
      ['Head', 'LeftBrow'],
      ['Head', 'RightBrow'],
      ['LeftBrow', 'LeftEye'],
      ['RightBrow', 'RightEye'],
      ['LeftEye', 'LeftCheek'],
      ['RightEye', 'RightCheek'],
      ['LeftCheek', 'LeftMouthCorner'],
      ['RightCheek', 'RightMouthCorner'],
      ['LeftMouthCorner', 'UpperLip'],
      ['RightMouthCorner', 'UpperLip'],
      ['UpperLip', 'LowerLip'],
      ['LowerLip', 'Jaw'],
    ],
  },
};

const VIEW_BUTTONS: Record<ControlView, string> = {
  body: 'btn-view-body',
  leftHand: 'btn-view-left-hand',
  rightHand: 'btn-view-right-hand',
  face: 'btn-view-face',
};

/** Sidebar maps for body, hand, and face controls plus selection and reset. */
export class UI {
  private circles = new Map<JointId, SVGCircleElement>();
  private jointName = document.getElementById('joint-name') as HTMLElement;
  private mapTitle = document.getElementById('control-view-title') as HTMLElement;
  private renderedView: ControlView | null = null;

  constructor(
    private state: AppState,
    onReset: () => void,
    private onViewChange: (view: ControlView) => void,
  ) {
    document.getElementById('btn-reset')!.addEventListener('click', onReset);
    for (const [view, buttonId] of Object.entries(VIEW_BUTTONS) as [ControlView, string][]) {
      document.getElementById(buttonId)!.addEventListener('click', () => this.switchView(view));
    }

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.state.select(null);
    });

    this.state.onChange(() => this.render());
    this.render();
  }

  private switchView(view: ControlView) {
    this.state.setView(view);
    this.onViewChange(view);
  }

  private buildControlMap() {
    const view = this.state.activeView;
    const map = VIEW_MAPS[view];
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 120 ${map.height}`);
    svg.setAttribute('width', '170');
    svg.setAttribute('height', String(Math.round(170 * map.height / 120)));

    for (const [a, b] of map.segments) {
      const [x1, y1] = map.positions[a]!;
      const [x2, y2] = map.positions[b]!;
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', String(x1));
      line.setAttribute('y1', String(y1));
      line.setAttribute('x2', String(x2));
      line.setAttribute('y2', String(y2));
      line.classList.add('figure');
      svg.appendChild(line);
    }

    this.circles.clear();
    for (const id of CONTROL_JOINTS_BY_VIEW[view]) {
      const [cx, cy] = map.positions[id]!;
      const circle = document.createElementNS(svgNS, 'circle');
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', view === 'body' ? '5.5' : '4.5');
      circle.classList.add('ctl');
      circle.addEventListener('click', () => this.state.select(id));
      if (view === 'body') {
        const detailView = id === 'Head' ? 'face' : id === 'LeftHand' ? 'leftHand' : id === 'RightHand' ? 'rightHand' : null;
        if (detailView) {
          circle.addEventListener('dblclick', () => this.switchView(detailView));
        }
      }
      const title = document.createElementNS(svgNS, 'title');
      title.textContent = JOINT_LABELS[id] ?? id;
      circle.appendChild(title);
      this.circles.set(id, circle);
      svg.appendChild(circle);
    }

    const bodyMap = document.getElementById('bodymap')!;
    bodyMap.replaceChildren(svg);
    this.mapTitle.textContent = map.title;
    this.renderedView = view;
  }

  private render() {
    if (this.renderedView !== this.state.activeView) this.buildControlMap();

    const selected = this.state.selected;
    for (const [id, circle] of this.circles) {
      const isSelected = selected === id;
      circle.setAttribute('fill', `#${pointColor(isSelected).toString(16).padStart(6, '0')}`);
      circle.classList.toggle('selected', isSelected);
    }
    for (const [view, buttonId] of Object.entries(VIEW_BUTTONS) as [ControlView, string][]) {
      document.getElementById(buttonId)!.classList.toggle('active', view === this.state.activeView);
    }
    this.jointName.textContent = selected ? JOINT_LABELS[selected] ?? selected : 'none';
  }
}
