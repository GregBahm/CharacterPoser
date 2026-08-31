import { CHARACTER_MODELS, findCharacterModel } from './models.ts';
import { CharacterScene } from './scene.ts';
import { AppState } from './state.ts';

/**
 * Adding and deleting characters: the Scene tab's model dropdown with its
 * Add button, and the Controls tab's Delete button for the active character
 * while one of its control nodes is selected.
 */
export class CharactersPanel {
  private select = document.getElementById('model-list') as HTMLSelectElement;
  private addButton = document.getElementById('btn-add-character') as HTMLButtonElement;
  private deleteButton = document.getElementById('btn-delete-character') as HTMLButtonElement;
  private status = document.getElementById('character-status') as HTMLElement;

  constructor(
    private state: AppState,
    private scene: CharacterScene,
  ) {
    for (const model of CHARACTER_MODELS) {
      const option = document.createElement('option');
      option.value = model.url;
      option.textContent = model.label;
      this.select.appendChild(option);
    }
    this.addButton.addEventListener('click', () => void this.add());
    this.deleteButton.addEventListener('click', () => this.remove());

    this.state.onChange(() => this.render());
    this.scene.onChange(() => this.render());
    this.render();
  }

  private async add() {
    const model = findCharacterModel(this.select.value);
    if (!model) return;
    this.addButton.disabled = true;
    this.setStatus(`Loading ${model.label}…`);
    try {
      const character = await this.scene.add(model);
      this.state.setActiveCharacter(character.id);
      this.setStatus('');
    } catch (cause) {
      this.setStatus(`Could not load ${model.label}: ${cause instanceof Error ? cause.message : String(cause)}`, true);
    } finally {
      this.addButton.disabled = false;
    }
  }

  private remove() {
    const character = this.scene.active;
    if (!character || this.state.selected === null) return;
    this.scene.remove(character);
    this.setStatus('');
  }

  private setStatus(message: string, error = false) {
    this.status.textContent = message;
    this.status.classList.toggle('error', error);
  }

  private render() {
    // Shown alongside the active character's controls (the panel itself hides with no character).
    const active = this.scene.active;
    this.deleteButton.hidden = active === null;
    if (active) this.deleteButton.textContent = `Delete ${active.model.label}`;
  }
}
