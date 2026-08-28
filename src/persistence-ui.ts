import { ControlView } from './pose.ts';
import { StoredDocumentSummary } from './persistence.ts';

export interface PersistenceActions {
  savePose(name: string): Promise<void>;
  loadPose(id: string): Promise<void>;
  createSession(name: string): Promise<void>;
  loadSession(id: string): Promise<void>;
}

export class PersistenceUI {
  private poseName = document.getElementById('pose-name') as HTMLInputElement;
  private poseList = document.getElementById('pose-list') as HTMLSelectElement;
  private poseScope = document.getElementById('pose-scope') as HTMLElement;
  private sessionName = document.getElementById('session-name') as HTMLInputElement;
  private sessionList = document.getElementById('session-list') as HTMLSelectElement;
  private currentSession = document.getElementById('current-session') as HTMLElement;
  private status = document.getElementById('persistence-status') as HTMLElement;
  private actionButtons = [
    document.getElementById('btn-save-pose') as HTMLButtonElement,
    document.getElementById('btn-load-pose') as HTMLButtonElement,
    document.getElementById('btn-new-session') as HTMLButtonElement,
    document.getElementById('btn-load-session') as HTMLButtonElement,
  ];

  constructor(private actions: PersistenceActions) {
    document.getElementById('btn-save-pose')!.addEventListener('click', () => {
      const name = this.poseName.value.trim();
      if (!name) {
        this.setStatus('Enter a pose name first.', true);
        return;
      }
      void this.run(() => this.actions.savePose(name));
    });
    document.getElementById('btn-load-pose')!.addEventListener('click', () => {
      const id = this.poseList.value;
      if (!id) {
        this.setStatus('Select a pose first.', true);
        return;
      }
      void this.run(() => this.actions.loadPose(id));
    });
    document.getElementById('btn-new-session')!.addEventListener('click', () => {
      const name = this.sessionName.value.trim();
      if (!name) {
        this.setStatus('Enter a session name first.', true);
        return;
      }
      void this.run(() => this.actions.createSession(name));
    });
    document.getElementById('btn-load-session')!.addEventListener('click', () => {
      const id = this.sessionList.value;
      if (!id) {
        this.setStatus('Select a session first.', true);
        return;
      }
      void this.run(() => this.actions.loadSession(id));
    });
  }

  setScope(scope: ControlView) {
    const labels: Record<ControlView, string> = {
      body: 'Full Body',
      leftHand: 'Left Hand',
      rightHand: 'Right Hand',
      face: 'Face',
    };
    this.poseScope.textContent = labels[scope];
  }

  setPoses(poses: StoredDocumentSummary[]) {
    this.replaceOptions(this.poseList, poses, 'No saved poses');
  }

  setSessions(sessions: StoredDocumentSummary[], selectedId?: string) {
    this.replaceOptions(this.sessionList, sessions, 'No saved sessions');
    if (selectedId && sessions.some((session) => session.id === selectedId)) {
      this.sessionList.value = selectedId;
    }
  }

  setCurrentSession(name: string) {
    this.currentSession.textContent = name;
  }

  setStatus(message: string, error = false) {
    this.status.textContent = message;
    this.status.classList.toggle('error', error);
  }

  private replaceOptions(select: HTMLSelectElement, entries: StoredDocumentSummary[], emptyLabel: string) {
    select.replaceChildren();
    if (entries.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = emptyLabel;
      select.appendChild(option);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    for (const entry of entries) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.invalid ? `[Invalid] ${entry.name}` : entry.name;
      option.title = entry.error ?? new Date(entry.updatedAt).toLocaleString();
      select.appendChild(option);
    }
  }

  private async run(action: () => Promise<void>) {
    for (const button of this.actionButtons) button.disabled = true;
    try {
      this.setStatus('Working...');
      await action();
    } catch (cause) {
      this.setStatus(cause instanceof Error ? cause.message : String(cause), true);
    } finally {
      for (const button of this.actionButtons) button.disabled = false;
    }
  }
}
