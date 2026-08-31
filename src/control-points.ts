import * as THREE from 'three';
import { BODY_CONTROL_JOINTS, CONTROL_JOINTS, CONTROL_JOINTS_BY_VIEW, JointId, PoseGraph } from './pose.ts';
import { AppState, COLORS, pointColor } from './state.ts';

/** Draggable control-point spheres drawn on top of one character. */
export class ControlPoints {
  group = new THREE.Group();
  private geometry = new THREE.SphereGeometry(1, 20, 14);
  private spheres = new Map<JointId, THREE.Mesh>();
  private hovered: JointId | null = null;

  constructor(
    private characterId: string,
    private pose: PoseGraph,
  ) {
    for (const id of CONTROL_JOINTS) {
      const mat = new THREE.MeshBasicMaterial({
        color: COLORS.free,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      });
      const sphere = new THREE.Mesh(this.geometry, mat);
      sphere.renderOrder = 10;
      sphere.userData.jointId = id;
      sphere.userData.characterId = characterId;
      this.spheres.set(id, sphere);
      this.group.add(sphere);
    }
  }

  /**
   * The body view shows every character's body points; the detail views
   * show only the active character's controls.
   */
  update(state: AppState) {
    const active = state.activeCharacter === this.characterId;
    const shown = state.activeView === 'body'
      ? BODY_CONTROL_JOINTS
      : active ? CONTROL_JOINTS_BY_VIEW[state.activeView] : [];
    const visible = new Set(shown);
    const detailSize = state.activeView === 'face' ? 0.006 : 0.005;
    for (const [id, sphere] of this.spheres) {
      sphere.visible = visible.has(id);
      const anchor = id === 'Head' || id === 'LeftHand' || id === 'RightHand';
      sphere.scale.setScalar(state.activeView === 'body' ? 0.024 : anchor ? 0.009 : detailSize);
      sphere.position.copy(this.pose.get(id).pos);
      (sphere.material as THREE.MeshBasicMaterial).color.setHex(
        pointColor(active && state.selected === id, this.hovered === id),
      );
    }
  }

  setHovered(id: JointId | null) {
    this.hovered = id;
  }

  get meshes(): THREE.Mesh[] {
    return [...this.spheres.values()].filter((sphere) => sphere.visible);
  }

  dispose() {
    for (const sphere of this.spheres.values()) (sphere.material as THREE.Material).dispose();
    this.geometry.dispose();
  }
}
