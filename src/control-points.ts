import * as THREE from 'three';
import {
  BODY_CONTROL_JOINTS,
  CONTROL_JOINTS,
  CONTROL_JOINTS_BY_VIEW,
  CONTROL_PARENT,
  JointId,
  PoseGraph,
} from './pose.ts';
import { AppState, COLORS, pointColor } from './state.ts';

/**
 * Draggable control-point spheres drawn on top of one character. Which
 * points exist for picking depends on the view and the active character;
 * which are drawn depends on the selection (only the selected point while
 * one is selected) and the always-show preference (off: only a revealed,
 * mouse-over character's points). The hovered point always shows, and
 * undrawn points stay pickable.
 */
export class ControlPoints {
  group = new THREE.Group();
  private geometry = new THREE.SphereGeometry(1, 20, 14);
  private spheres = new Map<JointId, THREE.Mesh>();
  private connectionGeometry = new THREE.BufferGeometry();
  private connectionPositions = new Float32Array(CONTROL_JOINTS.length * 6);
  private connections: THREE.LineSegments;
  private planeIndicator = new THREE.Mesh(
    new THREE.BoxGeometry(1, 0.04, 1),
    new THREE.MeshBasicMaterial({
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.8,
    }),
  );
  private hovered: JointId | null = null;
  private planeLocked: JointId | null = null;
  private revealed = false;
  private displayColor = new THREE.Color();
  private stretchColor = new THREE.Color(COLORS.stretchRing);

  constructor(
    private characterId: string,
    private pose: PoseGraph,
  ) {
    this.connectionGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.connectionPositions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    this.connections = new THREE.LineSegments(
      this.connectionGeometry,
      new THREE.LineBasicMaterial({
        color: COLORS.free,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.5,
      }),
    );
    this.connections.renderOrder = 9;
    this.group.add(this.connections);
    this.planeIndicator.renderOrder = 10;
    this.planeIndicator.visible = false;
    this.group.add(this.planeIndicator);

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
    const pickable = new Set(shown);
    // While a point is selected (on any character) only it is drawn, so the
    // widgets work uncluttered; otherwise all points show, or only a revealed
    // character's when always-show is off. Undrawn points stay pickable and
    // show individually under the mouse.
    const drawAll = state.selected === null && (state.alwaysShowPoints || this.revealed);
    const detailSize = state.activeView === 'face' ? 0.006 : 0.005;
    for (const [id, sphere] of this.spheres) {
      const selected = active && state.selected === id;
      sphere.userData.pickable = pickable.has(id);
      sphere.visible = sphere.userData.pickable && (drawAll || selected || this.hovered === id);
      (sphere.material as THREE.Material).visible = this.planeLocked !== id;
      const anchor = id === 'Head' || id === 'LeftHand' || id === 'RightHand';
      sphere.scale.setScalar(state.activeView === 'body' ? 0.024 : anchor ? 0.009 : detailSize);
      sphere.position.copy(this.pose.get(id).pos);
      (sphere.material as THREE.MeshBasicMaterial).color.copy(
        this.controlColor(id, state, selected, this.hovered === id),
      );
    }
    const planeSphere = this.planeLocked ? this.spheres.get(this.planeLocked) : null;
    this.planeIndicator.visible = planeSphere?.visible === true;
    if (planeSphere && this.planeIndicator.visible) {
      this.planeIndicator.position.copy(planeSphere.position);
      this.planeIndicator.scale.setScalar(planeSphere.scale.x * 3);
      (this.planeIndicator.material as THREE.MeshBasicMaterial).color.copy(
        this.controlColor(
          this.planeLocked!,
          state,
          active && state.selected === this.planeLocked,
          this.hovered === this.planeLocked,
        ),
      );
    }
    this.updateConnections();
  }

  private controlColor(id: JointId, state: AppState, selected: boolean, hovered: boolean): THREE.Color {
    this.displayColor.setHex(pointColor(selected, hovered));
    if (state.selected !== null || selected || !this.pose.hasStretchSegment(id)) return this.displayColor;
    const deviation = Math.abs(this.pose.segmentStretch(id) - 1);
    return this.displayColor.lerp(this.stretchColor, THREE.MathUtils.clamp(deviation / 0.3, 0, 1));
  }

  private updateConnections() {
    let offset = 0;
    for (const id of CONTROL_JOINTS) {
      const parentId = CONTROL_PARENT[id];
      if (!parentId) continue;
      const sphere = this.spheres.get(id)!;
      const parentSphere = this.spheres.get(parentId)!;
      if (!sphere.visible || !parentSphere.visible) continue;

      parentSphere.position.toArray(this.connectionPositions, offset);
      offset += 3;
      sphere.position.toArray(this.connectionPositions, offset);
      offset += 3;
    }

    this.connectionGeometry.setDrawRange(0, offset / 3);
    (this.connectionGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.connections.visible = offset > 0;
  }

  setHovered(id: JointId | null) {
    this.hovered = id;
  }

  setPlaneLocked(id: JointId | null) {
    this.planeLocked = id;
  }

  /** Mouse is over this character: draw its points even when always-show is off. */
  setRevealed(revealed: boolean) {
    this.revealed = revealed;
  }

  /** Spheres that can be picked right now, drawn or not. */
  get meshes(): THREE.Mesh[] {
    return [...this.spheres.values()].filter((sphere) => sphere.userData.pickable);
  }

  sphere(id: JointId): THREE.Mesh {
    return this.spheres.get(id)!;
  }

  dispose() {
    for (const sphere of this.spheres.values()) (sphere.material as THREE.Material).dispose();
    (this.connections.material as THREE.Material).dispose();
    (this.planeIndicator.material as THREE.Material).dispose();
    this.planeIndicator.geometry.dispose();
    this.connectionGeometry.dispose();
    this.geometry.dispose();
  }
}
