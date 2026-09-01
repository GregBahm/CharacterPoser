export interface ShotTrayEntry {
  id: string;
  thumbnail?: string;
}

export interface ShotTrayActions {
  select(id: string): Promise<void>;
  add(): Promise<void>;
  duplicate(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  reorder(orderedIds: string[]): Promise<void>;
}

interface PointerDrag {
  card: HTMLElement;
  shotId: string;
  pointerId: number;
  startX: number;
  startY: number;
  grabOffsetX: number;
  originalIds: string[];
  placeholder: HTMLElement | null;
  lastX: number;
  scrollVelocity: number;
  scrollFrame: number | null;
}

const DRAG_THRESHOLD = 5;
const REORDER_MS = 150;
const AUTO_SCROLL_EDGE = 52;
const AUTO_SCROLL_MAX = 13;

export class ShotTray {
  private tray = document.getElementById('shot-tray') as HTMLElement;
  private list = document.getElementById('shot-list') as HTMLElement;
  private addButton = document.getElementById('btn-add-shot') as HTMLButtonElement;
  private shots: ShotTrayEntry[] = [];
  private activeId: string | null = null;
  private busy = false;
  private drag: PointerDrag | null = null;
  private suppressClick = false;

  constructor(
    private actions: ShotTrayActions,
    private onError: (cause: unknown) => void,
  ) {
    this.addButton.addEventListener('click', () => {
      void this.run(() => this.actions.add());
    });
  }

  setShots(shots: ShotTrayEntry[], activeId: string) {
    this.shots = shots;
    this.activeId = activeId;
    this.tray.hidden = false;
    this.render();
  }

  private render() {
    if (this.drag) this.cancelDrag();
    this.list.replaceChildren();
    for (const [index, shot] of this.shots.entries()) {
      const card = document.createElement('div');
      card.className = 'shot-card';
      card.dataset.shotId = shot.id;
      card.classList.toggle('active', shot.id === this.activeId);
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `Shot ${index + 1}`);

      if (shot.id === this.activeId) {
        const activeFill = document.createElement('div');
        activeFill.className = 'shot-active-fill';
        card.appendChild(activeFill);
      } else if (shot.thumbnail) {
        const image = document.createElement('img');
        image.src = shot.thumbnail;
        image.alt = '';
        image.draggable = false;
        image.addEventListener('error', () => {
          image.replaceWith(this.placeholder());
        });
        card.appendChild(image);
      } else {
        card.appendChild(this.placeholder());
      }

      const actions = document.createElement('div');
      actions.className = 'shot-actions';
      const duplicate = this.iconButton('Duplicate shot', 'duplicate');
      duplicate.disabled = this.busy;
      duplicate.addEventListener('click', (event) => {
        event.stopPropagation();
        void this.run(() => this.actions.duplicate(shot.id));
      });
      const remove = this.iconButton('Delete shot', 'delete');
      remove.disabled = this.busy || this.shots.length <= 1;
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        void this.run(() => this.actions.delete(shot.id));
      });
      actions.append(duplicate, remove);
      card.appendChild(actions);

      card.addEventListener('click', () => {
        if (this.suppressClick) return;
        if (shot.id !== this.activeId) void this.run(() => this.actions.select(shot.id));
      });
      card.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        if (shot.id !== this.activeId) void this.run(() => this.actions.select(shot.id));
      });
      card.addEventListener('pointerdown', (event) => this.beginPointerDrag(event, card, shot.id));
      card.addEventListener('pointermove', this.movePointerDrag);
      card.addEventListener('pointerup', this.endPointerDrag);
      card.addEventListener('pointercancel', this.cancelPointerDrag);
      this.list.appendChild(card);
    }
    this.addButton.disabled = this.busy;
  }

  private beginPointerDrag(event: PointerEvent, card: HTMLElement, shotId: string) {
    if (
      this.busy ||
      event.button !== 0 ||
      (event.target as Element).closest('.shot-action')
    ) {
      return;
    }
    const rect = card.getBoundingClientRect();
    this.drag = {
      card,
      shotId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grabOffsetX: event.clientX - rect.left,
      originalIds: this.shots.map((shot) => shot.id),
      placeholder: null,
      lastX: event.clientX,
      scrollVelocity: 0,
      scrollFrame: null,
    };
    card.setPointerCapture(event.pointerId);
  }

  private movePointerDrag = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.lastX = event.clientX;
    if (!drag.placeholder) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance < DRAG_THRESHOLD) return;
      this.startReorder(drag);
    }
    event.preventDefault();
    drag.card.style.left = `${event.clientX - drag.grabOffsetX}px`;
    this.movePlaceholder(drag, event.clientX);
    this.updateAutoScroll(drag, event.clientX);
  };

  private startReorder(drag: PointerDrag) {
    this.suppressClick = true;
    const rect = drag.card.getBoundingClientRect();
    const placeholder = document.createElement('div');
    placeholder.className = 'shot-drop-placeholder';
    drag.placeholder = placeholder;
    drag.card.before(placeholder);
    drag.card.classList.add('dragging');
    drag.card.style.position = 'fixed';
    drag.card.style.zIndex = '1000';
    drag.card.style.left = `${rect.left}px`;
    drag.card.style.top = `${rect.top}px`;
    drag.card.style.width = `${rect.width}px`;
    drag.card.style.height = `${rect.height}px`;
    drag.card.style.pointerEvents = 'none';
    document.body.appendChild(drag.card);
    drag.card.setPointerCapture(drag.pointerId);
  }

  private movePlaceholder(drag: PointerDrag, clientX: number) {
    const placeholder = drag.placeholder;
    if (!placeholder) return;
    const cards = [...this.list.querySelectorAll<HTMLElement>('.shot-card')];
    const beforeRects = new Map(cards.map((card) => [card, card.getBoundingClientRect()]));
    const before = cards.find((card) => {
      const rect = card.getBoundingClientRect();
      return clientX < rect.left + rect.width / 2;
    }) ?? null;
    if (before ? placeholder.nextElementSibling === before : placeholder === this.list.lastElementChild) return;
    if (before) this.list.insertBefore(placeholder, before);
    else this.list.appendChild(placeholder);
    for (const card of cards) {
      const oldRect = beforeRects.get(card)!;
      const newRect = card.getBoundingClientRect();
      const delta = oldRect.left - newRect.left;
      if (Math.abs(delta) < 0.5) continue;
      for (const animation of card.getAnimations()) animation.cancel();
      card.animate(
        [{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }],
        { duration: REORDER_MS, easing: 'ease-out' },
      );
    }
  }

  private updateAutoScroll(drag: PointerDrag, clientX: number) {
    const rect = this.list.getBoundingClientRect();
    if (clientX < rect.left + AUTO_SCROLL_EDGE) {
      const strength = Math.min(1, Math.max(0, 1 - (clientX - rect.left) / AUTO_SCROLL_EDGE));
      drag.scrollVelocity = -AUTO_SCROLL_MAX * strength;
    } else if (clientX > rect.right - AUTO_SCROLL_EDGE) {
      const strength = Math.min(1, Math.max(0, 1 - (rect.right - clientX) / AUTO_SCROLL_EDGE));
      drag.scrollVelocity = AUTO_SCROLL_MAX * strength;
    } else {
      drag.scrollVelocity = 0;
    }
    if (drag.scrollVelocity !== 0 && drag.scrollFrame === null) {
      drag.scrollFrame = requestAnimationFrame(() => this.autoScroll(drag));
    }
  }

  private autoScroll(drag: PointerDrag) {
    if (this.drag !== drag || !drag.placeholder || drag.scrollVelocity === 0) {
      drag.scrollFrame = null;
      return;
    }
    const before = this.list.scrollLeft;
    this.list.scrollLeft += drag.scrollVelocity;
    this.movePlaceholder(drag, drag.lastX);
    if (this.list.scrollLeft === before) {
      drag.scrollVelocity = 0;
      drag.scrollFrame = null;
      return;
    }
    drag.scrollFrame = requestAnimationFrame(() => this.autoScroll(drag));
  }

  private endPointerDrag = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.card.hasPointerCapture(event.pointerId)) drag.card.releasePointerCapture(event.pointerId);
    if (!drag.placeholder) {
      this.drag = null;
      return;
    }
    event.preventDefault();
    const floatingRect = drag.card.getBoundingClientRect();
    drag.placeholder.replaceWith(drag.card);
    this.restoreDraggedCard(drag.card);
    const finalRect = drag.card.getBoundingClientRect();
    drag.card.animate(
      [
        { transform: `translate(${floatingRect.left - finalRect.left}px, ${floatingRect.top - finalRect.top}px)` },
        { transform: 'translate(0, 0)' },
      ],
      { duration: REORDER_MS, easing: 'ease-out' },
    );
    this.stopAutoScroll(drag);
    this.drag = null;
    const orderedIds = [...this.list.querySelectorAll<HTMLElement>('.shot-card')]
      .map((card) => card.dataset.shotId!)
      .filter(Boolean);
    const changed = orderedIds.some((id, index) => id !== drag.originalIds[index]);
    if (changed) {
      const byId = new Map(this.shots.map((shot) => [shot.id, shot]));
      this.shots = orderedIds.map((id) => byId.get(id)!);
      void this.run(async () => {
        try {
          await this.actions.reorder(orderedIds);
        } catch (cause) {
          this.shots = drag.originalIds.map((id) => byId.get(id)!);
          throw cause;
        }
      }, false);
    }
    window.setTimeout(() => {
      this.suppressClick = false;
    }, 0);
  };

  private cancelPointerDrag = (event: PointerEvent) => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.cancelDrag();
  };

  private cancelDrag() {
    const drag = this.drag;
    if (!drag) return;
    this.stopAutoScroll(drag);
    if (drag.card.hasPointerCapture(drag.pointerId)) drag.card.releasePointerCapture(drag.pointerId);
    if (drag.placeholder) {
      const originalIndex = drag.originalIds.indexOf(drag.shotId);
      const cards = [...this.list.querySelectorAll<HTMLElement>('.shot-card')];
      const before = cards[originalIndex] ?? null;
      if (before) this.list.insertBefore(drag.card, before);
      else this.list.appendChild(drag.card);
      drag.placeholder.remove();
      this.restoreDraggedCard(drag.card);
    }
    this.drag = null;
    this.suppressClick = false;
  }

  private stopAutoScroll(drag: PointerDrag) {
    if (drag.scrollFrame !== null) cancelAnimationFrame(drag.scrollFrame);
    drag.scrollFrame = null;
    drag.scrollVelocity = 0;
  }

  private restoreDraggedCard(card: HTMLElement) {
    card.classList.remove('dragging');
    card.style.removeProperty('position');
    card.style.removeProperty('z-index');
    card.style.removeProperty('left');
    card.style.removeProperty('top');
    card.style.removeProperty('width');
    card.style.removeProperty('height');
    card.style.removeProperty('pointer-events');
  }

  private placeholder(): HTMLDivElement {
    const placeholder = document.createElement('div');
    placeholder.className = 'shot-placeholder';
    return placeholder;
  }

  private iconButton(label: string, icon: 'duplicate' | 'delete'): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'shot-action';
    button.title = label;
    button.setAttribute('aria-label', label);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    if (icon === 'duplicate') {
      const back = document.createElementNS(svg.namespaceURI, 'rect');
      back.setAttribute('x', '2.5');
      back.setAttribute('y', '2.5');
      back.setAttribute('width', '8');
      back.setAttribute('height', '8');
      const front = document.createElementNS(svg.namespaceURI, 'rect');
      front.setAttribute('x', '5.5');
      front.setAttribute('y', '5.5');
      front.setAttribute('width', '8');
      front.setAttribute('height', '8');
      svg.append(back, front);
    } else {
      const lid = document.createElementNS(svg.namespaceURI, 'path');
      lid.setAttribute('d', 'M3 4.5h10M6 2.5h4');
      const bin = document.createElementNS(svg.namespaceURI, 'path');
      bin.setAttribute('d', 'M4.5 4.5l.7 9h5.6l.7-9M7 7v4M9 7v4');
      svg.append(lid, bin);
    }
    button.appendChild(svg);
    return button;
  }

  private async run(action: () => Promise<void>, renderBusy = true) {
    if (this.busy) return;
    this.busy = true;
    if (renderBusy) this.render();
    else this.addButton.disabled = true;
    try {
      await action();
    } catch (cause) {
      this.onError(cause);
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
