export class ReferenceImageOverlay {
  private image = document.getElementById('reference-image') as HTMLImageElement;
  private available = false;
  private loaded = false;

  constructor() {
    this.image.addEventListener('load', () => {
      this.loaded = true;
    });
    this.image.addEventListener('error', () => {
      this.loaded = false;
      this.image.hidden = true;
    });
  }

  set(source: string | null, opacity = 0.5) {
    this.available = source !== null;
    this.loaded = false;
    if (source) this.image.src = source;
    else this.image.removeAttribute('src');
    this.setOpacity(opacity);
    if (!source) this.image.hidden = true;
  }

  setOpacity(opacity: number) {
    this.image.style.opacity = String(Math.min(1, Math.max(0, opacity)));
  }

  update(cameraMatchesReference: boolean) {
    this.image.hidden = !this.available || !this.loaded || !cameraMatchesReference;
  }
}
