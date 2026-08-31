// n8ao ships no type declarations; this covers the parts of N8AOPass we use.
declare module 'n8ao' {
  import type { Camera, Color, Scene } from 'three';
  import { Pass } from 'three/addons/postprocessing/Pass.js';

  export type N8AOQualityMode =
    | 'Performance'
    | 'Low'
    | 'Medium'
    | 'High'
    | 'Ultra'
    | 'Neural-Low'
    | 'Neural-Medium'
    | 'Neural-High';

  export interface N8AOConfiguration {
    /** Occlusion reach in world units (or pixels with screenSpaceRadius). */
    aoRadius: number;
    distanceFalloff: number;
    /** Artistic strength: the AO term is raised to this power. */
    intensity: number;
    color: Color;
    aoSamples: number;
    denoiseSamples: number;
    denoiseRadius: number;
    denoiseIterations: number;
    neuralDenoise: boolean;
    halfRes: boolean;
    depthAwareUpsampling: boolean;
    screenSpaceRadius: boolean;
    /** Average AO over frames while the camera is still. */
    accumulate: boolean;
    /** Convert to sRGB itself; false when an OutputPass follows. */
    gammaCorrection: boolean;
    transparencyAware: boolean;
    autoRenderBeauty: boolean;
    stencil: boolean;
  }

  /** Renders the scene (it replaces RenderPass) and composites screen-space ambient occlusion over it. */
  export class N8AOPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: N8AOConfiguration;
    /** Set to force the accumulation buffer to restart on the next frame. */
    needsFrame: boolean;
    setQualityMode(mode: N8AOQualityMode): void;
    setDisplayMode(mode: 'Combined' | 'AO' | 'No AO' | 'Split' | 'Split AO'): void;
    setSize(width: number, height: number): void;
  }
}
