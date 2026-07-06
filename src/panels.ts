import * as THREE from 'three';

export interface ViewDef {
  key: string;
  title: string;
  position: THREE.Vector3;
  lookAt: THREE.Vector3;
}

export const VIEW_DEFS: Record<string, ViewDef> = {
  front: { key: 'front', title: 'Front', position: new THREE.Vector3(0, 1.0, 3.6), lookAt: new THREE.Vector3(0, 0.9, 0) },
  back: { key: 'back', title: 'Back', position: new THREE.Vector3(0, 1.0, -3.6), lookAt: new THREE.Vector3(0, 0.9, 0) },
  left: { key: 'left', title: 'Left', position: new THREE.Vector3(-3.6, 1.0, 0), lookAt: new THREE.Vector3(0, 0.9, 0) },
  right: { key: 'right', title: 'Right', position: new THREE.Vector3(3.6, 1.0, 0), lookAt: new THREE.Vector3(0, 0.9, 0) },
  top: { key: 'top', title: 'Top', position: new THREE.Vector3(0, 4.2, 0.01), lookAt: new THREE.Vector3(0, 0.9, 0) },
};

export interface ViewPanel {
  def: ViewDef;
  element: HTMLElement;
  content: HTMLElement;
  camera: THREE.PerspectiveCamera;
}

/**
 * Floating alternative-angle panels. Panel chrome is DOM; the 3D content is
 * rendered into the main canvas underneath each panel's content rect using
 * scissored viewports, so all views share one renderer and one scene.
 */
export class PanelManager {
  panels: ViewPanel[] = [];
  private layer: HTMLElement;
  private spawnOffset = 0;

  constructor(layer: HTMLElement) {
    this.layer = layer;
  }

  open(key: string) {
    const def = VIEW_DEFS[key];
    if (!def) return;

    const element = document.createElement('div');
    element.className = 'view-panel';
    element.style.left = `${16 + this.spawnOffset}px`;
    element.style.top = `${16 + this.spawnOffset}px`;
    this.spawnOffset = (this.spawnOffset + 28) % 168;

    const header = document.createElement('header');
    const title = document.createElement('span');
    title.textContent = def.title;
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '✕';
    header.append(title, close);

    const content = document.createElement('div');
    content.className = 'content';
    element.append(header, content);
    this.layer.appendChild(element);

    const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
    camera.position.copy(def.position);
    camera.lookAt(def.lookAt);

    const panel: ViewPanel = { def, element, content, camera };
    this.panels.push(panel);

    close.addEventListener('click', () => this.close(panel));
    this.makeDraggable(panel, header);
    return panel;
  }

  close(panel: ViewPanel) {
    panel.element.remove();
    this.panels = this.panels.filter((p) => p !== panel);
  }

  /** The panel whose content rect contains the given client point, topmost first. */
  panelAt(clientX: number, clientY: number): ViewPanel | null {
    for (let i = this.panels.length - 1; i >= 0; i--) {
      const rect = this.panels[i].content.getBoundingClientRect();
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        return this.panels[i];
      }
    }
    return null;
  }

  private makeDraggable(panel: ViewPanel, header: HTMLElement) {
    header.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = panel.element.offsetLeft;
      const startTop = panel.element.offsetTop;
      const area = this.layer.getBoundingClientRect();

      const move = (ev: PointerEvent) => {
        const left = Math.min(Math.max(startLeft + ev.clientX - startX, 0), area.width - 60);
        const top = Math.min(Math.max(startTop + ev.clientY - startY, 0), area.height - 30);
        panel.element.style.left = `${left}px`;
        panel.element.style.top = `${top}px`;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);

      // Bring to front (render order + hit-test order).
      this.panels = [...this.panels.filter((p) => p !== panel), panel];
      this.layer.appendChild(panel.element);
    });
  }
}
