import {
  cloneLighting,
  defaultLight,
  DirectionalLightSettings,
  LIGHT_RANGES,
  LightingSettings,
  MAX_LIGHTS,
  SceneLighting,
} from './lighting.ts';

export type LightingChange = 'ambient' | 'lights';

interface Range {
  min: number;
  max: number;
  step: number;
}

/**
 * The Scene tab's Lighting section: ambient color/intensity, one block per
 * directional light (color, intensity, azimuth, elevation, softness, remove),
 * and Add Light. Edits go straight to the SceneLighting; the callback lets
 * the renderer and autosave react.
 */
export class LightingPanel {
  private ambientBlock = document.getElementById('ambient-light') as HTMLElement;
  private lightList = document.getElementById('light-list') as HTMLElement;
  private addButton = document.getElementById('btn-add-light') as HTMLButtonElement;
  private settings: LightingSettings;

  constructor(
    private lighting: SceneLighting,
    private onChange: (change: LightingChange) => void,
  ) {
    this.settings = cloneLighting(lighting.settings);
    this.addButton.addEventListener('click', () => {
      if (this.settings.lights.length >= MAX_LIGHTS) return;
      this.settings.lights.push(defaultLight());
      this.commit('lights');
      this.rebuild();
    });
    this.rebuild();
  }

  /** Re-read the lighting (after a session load) and rebuild the controls. */
  refresh() {
    this.settings = cloneLighting(this.lighting.settings);
    this.rebuild();
  }

  private commit(change: LightingChange) {
    this.lighting.apply(this.settings);
    this.onChange(change);
  }

  private rebuild() {
    const ambient = this.settings.ambient;
    this.ambientBlock.replaceChildren(
      header('Ambient', ambient.color, (color) => {
        ambient.color = color;
        this.commit('ambient');
      }),
      sliderRow('Intensity', ambient.intensity, LIGHT_RANGES.ambientIntensity, 2, (value) => {
        ambient.intensity = value;
        this.commit('ambient');
      }),
    );

    this.lightList.replaceChildren(
      ...this.settings.lights.map((light, index) => this.lightBlock(light, index)),
    );
    this.addButton.disabled = this.settings.lights.length >= MAX_LIGHTS;
  }

  private lightBlock(light: DirectionalLightSettings, index: number): HTMLElement {
    const block = document.createElement('div');
    block.className = 'light-block';
    const title = index === 0 ? 'Light 1 (shadows)' : `Light ${index + 1}`;
    const remove = document.createElement('button');
    remove.className = 'remove-light';
    remove.title = 'Remove this light';
    remove.setAttribute('aria-label', `Remove light ${index + 1}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      this.settings.lights.splice(index, 1);
      this.commit('lights');
      this.rebuild();
    });
    const update = () => this.commit('lights');
    block.append(
      header(title, light.color, (color) => {
        light.color = color;
        update();
      }, remove),
      sliderRow('Intensity', light.intensity, LIGHT_RANGES.intensity, 2, (value) => {
        light.intensity = value;
        update();
      }),
      sliderRow('Azimuth', light.azimuth, LIGHT_RANGES.azimuth, 0, (value) => {
        light.azimuth = value;
        update();
      }, '°'),
      sliderRow('Elevation', light.elevation, LIGHT_RANGES.elevation, 0, (value) => {
        light.elevation = value;
        update();
      }, '°'),
      sliderRow('Softness', light.softness, LIGHT_RANGES.softness, 1, (value) => {
        light.softness = value;
        update();
      }, '°', 'Angular size of the light; soft shadows in Path Traced mode only'),
    );
    return block;
  }
}

function header(title: string, color: string, onColor: (color: string) => void, extra?: HTMLElement): HTMLElement {
  const el = document.createElement('header');
  const name = document.createElement('span');
  name.textContent = title;
  const input = document.createElement('input');
  input.type = 'color';
  input.value = color;
  input.title = `${title} color`;
  input.setAttribute('aria-label', `${title} color`);
  input.addEventListener('input', () => onColor(input.value));
  el.append(name, input);
  if (extra) el.append(extra);
  return el;
}

function sliderRow(
  label: string,
  value: number,
  range: Range,
  decimals: number,
  onInput: (value: number) => void,
  unit = '',
  title?: string,
): HTMLElement {
  const row = document.createElement('label');
  row.className = 'slider-row';
  if (title) row.title = title;
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(range.min);
  input.max = String(range.max);
  input.step = String(range.step);
  input.value = String(value);
  const output = document.createElement('output');
  const show = (v: number) => {
    output.textContent = `${v.toFixed(decimals)}${unit}`;
  };
  show(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    show(v);
    onInput(v);
  });
  row.append(name, input, output);
  return row;
}
