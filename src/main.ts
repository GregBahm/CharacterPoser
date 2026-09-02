import * as THREE from 'three';
import { CameraBookmark, CameraPanel } from './camera-bookmark.ts';
import { CharactersPanel } from './character-ui.ts';
import { SceneCharacterDocument } from './documents.ts';
import { Interaction, Widgets } from './interaction.ts';
import { defaultLighting, SceneLighting } from './lighting.ts';
import { LightingPanel } from './lighting-ui.ts';
import { DEFAULT_CHARACTER_MODEL, findCharacterModel } from './models.ts';
import { CONTROL_JOINTS_BY_VIEW, ControlView } from './pose.ts';
import { PopupViews } from './popup-views.ts';
import { AppState } from './state.ts';
import { UI } from './ui.ts';
import { PersistenceController } from './persistence-controller.ts';
import { ReferenceImageOverlay } from './reference-image.ts';
import { bindRenderModeButtons, SceneRenderer } from './render-modes.ts';
import { CharacterScene } from './scene.ts';

const canvas = document.getElementById('scene-canvas') as HTMLCanvasElement;
const viewportArea = document.getElementById('viewport-area') as HTMLElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x22262e);

// Front-facing camera by default; alt-drag orbits it around cameraTarget.
const cameraTarget = new THREE.Vector3(0, 0.95, 0);
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
camera.position.set(0, 0.95, 4.2);
camera.lookAt(cameraTarget);

// Lighting (editable in the Scene tab) + ground
const lighting = new SceneLighting();
scene.add(lighting.group);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.95 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(10, 20, 0x4a5162, 0x353b48);
grid.position.y = 0.001;
scene.add(grid);

function resize() {
  const w = Math.max(1, viewportArea.clientWidth);
  const h = Math.max(1, viewportArea.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
let resizeRenderBuffers = () => {};
const viewportResizeObserver = new ResizeObserver(() => {
  resize();
  resizeRenderBuffers();
});
viewportResizeObserver.observe(viewportArea);
resize();

async function init() {
  const params = new URLSearchParams(location.search);
  const scriptedTest = [...params.keys()].some((key) => key.startsWith('test'));

  const state = new AppState();
  const sceneRenderer = new SceneRenderer(renderer, scene, camera, {
    lighting,
    shaded: [ground],
    rasterOnly: [grid],
    status: document.getElementById('render-status'),
  });
  bindRenderModeButtons(sceneRenderer);
  resizeRenderBuffers = () => sceneRenderer.setSize(viewportArea.clientWidth, viewportArea.clientHeight);
  resizeRenderBuffers();

  // Control points and widgets draw on top of every mode and are never path traced.
  const characters = new CharacterScene(state, {
    attach(character) {
      scene.add(character.rig.root);
      sceneRenderer.addShaded(character.rig.root);
      sceneRenderer.overlay.add(character.points.group);
    },
    detach(character) {
      scene.remove(character.rig.root);
      sceneRenderer.removeShaded(character.rig.root);
      sceneRenderer.overlay.remove(character.points.group);
    },
  });
  const widgets = new Widgets(characters, state);
  sceneRenderer.overlay.add(widgets.group);
  // Side/Top insets for placing the selected point in depth.
  const popups = new PopupViews(characters, state, camera, canvas, viewportArea);
  sceneRenderer.insets = (r) => popups.render(r, scene);

  let persistence: PersistenceController | null = null;
  const interaction = new Interaction({
    canvas,
    camera,
    cameraTarget,
    scene: characters,
    state,
    widgets,
    popups,
    onSceneChanged: () => {
      sceneRenderer.markGeometryChanged();
      persistence?.notifySceneChanged();
    },
  });
  characters.onChange(() => {
    // History snapshots cover the characters present when taken; start over.
    interaction.clearPoseHistory();
    sceneRenderer.markGeometryChanged();
    persistence?.notifySceneChanged();
  });

  const focusControls = (view: ControlView) => {
    const direction = new THREE.Vector3().subVectors(camera.position, cameraTarget);
    if (direction.lengthSq() < 1e-8) direction.set(0, 0, 1);
    direction.normalize();

    const active = characters.active;
    if (view === 'body') {
      const hips = active?.pose.get('Hips').pos;
      cameraTarget.set(hips?.x ?? 0, 0.95, hips?.z ?? 0);
      camera.position.copy(cameraTarget).addScaledVector(direction, 4.2);
    } else {
      if (!active) return;
      const ids = CONTROL_JOINTS_BY_VIEW[view].slice(1);
      cameraTarget.set(0, 0, 0);
      for (const id of ids) cameraTarget.add(active.pose.get(id).pos);
      cameraTarget.multiplyScalar(1 / ids.length);
      camera.position.copy(cameraTarget).addScaledVector(direction, view === 'face' ? 0.42 : 0.32);
    }
    camera.lookAt(cameraTarget);
    camera.updateMatrixWorld();
  };

  const resetPose = () => {
    const active = characters.active;
    if (!active) return;
    interaction.performPoseEdit(() => active.pose.reset());
    focusControls(state.activeView);
    state.emit();
    persistence?.notifySceneChanged();
  };

  const loadCharacters = async (saved: SceneCharacterDocument[]) => {
    characters.clear();
    for (const entry of saved) {
      const model = findCharacterModel(entry.model);
      if (!model) throw new Error(`Model "${entry.model}" is not available in this build`);
      await characters.add(model, { id: entry.id, controls: entry.controls });
    }
  };

  const lightingPanel = new LightingPanel(lighting, (change) => {
    if (change === 'ambient') sceneRenderer.markEnvironmentChanged();
    sceneRenderer.markLightsChanged();
    persistence?.notifySceneChanged();
  });
  const setLighting = (settings: typeof lighting.settings) => {
    lighting.apply(settings);
    sceneRenderer.markEnvironmentChanged();
    sceneRenderer.markLightsChanged();
    lightingPanel.refresh();
  };

  // The bookmarked main view; edits autosave with the scene.
  const bookmark = new CameraBookmark(camera, cameraTarget, () => persistence?.notifySceneChanged());
  const cameraPanel = new CameraPanel(bookmark);
  const referenceImage = new ReferenceImageOverlay();

  const resetScene = async () => {
    characters.clear();
    await characters.add(DEFAULT_CHARACTER_MODEL);
    setLighting(defaultLighting());
    bookmark.clear();
    state.setView('body');
    camera.fov = 40;
    camera.updateProjectionMatrix();
    focusControls('body');
    interaction.applyPose();
    state.emit();
  };

  new UI(
    state,
    characters,
    resetPose,
    (view) => {
      focusControls(view);
      persistence?.notifySceneChanged();
    },
    (view) => persistence?.notifyViewChanged(view),
  );
  new CharactersPanel(state, characters);

  persistence = new PersistenceController({
    scene: characters,
    state,
    camera,
    cameraTarget,
    resolution: () => ({
      width: Math.max(1, Math.round(viewportArea.clientWidth)),
      height: Math.max(1, Math.round(viewportArea.clientHeight)),
    }),
    captureThumbnail: () => sceneRenderer.captureThumbnail(),
    loadCharacters,
    lighting: () => lighting.settings,
    setLighting,
    mainCamera: () => bookmark.main,
    setMainCamera: (pose) => bookmark.load(pose),
    setReferenceImage: (source, opacity) => referenceImage.set(source, opacity),
    setReferenceOpacity: (opacity) => referenceImage.setOpacity(opacity),
    applyPose: () => interaction.applyPose(),
    applyPoseEdit: (edit) => interaction.performPoseEdit(edit),
    clearPoseHistory: () => interaction.clearPoseHistory(),
    resetScene,
  });
  if (scriptedTest) {
    persistence.reportStatus('Persistence disabled for scripted test mode.');
    await characters.add(DEFAULT_CHARACTER_MODEL);
  } else {
    try {
      await persistence.initialize();
    } catch (cause) {
      persistence.reportError(cause);
      if (characters.characters.length === 0) await characters.add(DEFAULT_CHARACTER_MODEL);
    }
  }

  const requestedView = params.get('view');
  if (requestedView && ['body', 'leftHand', 'rightHand', 'face'].includes(requestedView)) {
    // Frame buttons, so ?view= both switches the control map and frames the area.
    const buttonId: Record<ControlView, string> = {
      body: 'btn-frame-body',
      leftHand: 'btn-frame-left-hand',
      rightHand: 'btn-frame-right-hand',
      face: 'btn-frame-face',
    };
    persistence.withoutAutosave(() => {
      document.getElementById(buttonId[requestedView as ControlView])!.click();
    });
  }

  // Scripted manipulations for automated verification, on the active character.
  const pose = characters.active?.pose;
  if (pose && params.has('testdrag')) {
    // Left-drag equivalent: hand alone moves, forearm stretches to reach it.
    pose.moveTo('LeftHand', new THREE.Vector3(0.45, 1.6, 0.5), false);
    interaction.applyPose();
  }
  if (pose && params.has('testsubtree')) {
    // Right-drag equivalent: shoulder moves with elbow+hand rigidly.
    pose.moveTo('LeftArm', new THREE.Vector3(0.25, 1.75, 0.3), true);
    interaction.applyPose();
  }
  if (pose && params.has('testaim')) {
    // Right-drag direction helper equivalent: aim the chest up-and-forward.
    pose.aimAt('Spine2', pose.get('Spine2').pos.clone().add(new THREE.Vector3(0, 0.8, 0.6)), true);
    interaction.applyPose();
  }
  if (pose && params.has('testtwist')) {
    // Right-drag twist ring equivalent: roll the hips around their forward axis.
    pose.twist('Hips', 0.6, true);
    interaction.applyPose();
  }
  if (pose && params.has('testhand')) {
    pose.translate('LeftIndex3', new THREE.Vector3(0, 0.02, 0.015), false);
    interaction.applyPose();
  }
  if (pose && params.has('testface')) {
    pose.translate('Jaw', new THREE.Vector3(0, -0.025, 0.01), true);
    interaction.applyPose();
  }
  if (params.has('testreset')) {
    document.getElementById('btn-reset')!.click();
  }
  if (params.has('select')) {
    state.select((params.get('select') as never) || 'Head');
  }

  document.getElementById('loading')!.hidden = true;
  document.getElementById('controls')!.hidden = false;

  // Debug hook for scripted/automated testing.
  (window as unknown as { poser?: unknown }).poser = {
    scene: characters,
    state,
    camera,
    interaction,
    sceneRenderer,
    lighting,
    popups,
    bookmark,
    cameraPanel,
    get character() {
      return characters.active;
    },
    get pose() {
      return characters.active?.pose;
    },
    get rig() {
      return characters.active?.rig;
    },
  };

  if (params.has('debug')) {
    const el = document.getElementById('loading')!;
    const fmt = (v: THREE.Vector3) => v.toArray().map((n) => n.toFixed(3)).join(', ');
    const active = characters.active;
    const lines = active
      ? [
        `Hips: ${fmt(active.pose.get('Hips').pos)}`,
        `Chest: ${fmt(active.pose.get('Spine2').pos)}`,
        `LHand node: ${fmt(active.pose.get('LeftHand').pos)}`,
        `LHand bone: ${fmt(active.rig.getBone('LeftHand').getWorldPosition(new THREE.Vector3()))}`,
        `LFoot bone: ${fmt(active.rig.getBone('LeftFoot').getWorldPosition(new THREE.Vector3()))}`,
        `LIndex tip node: ${fmt(active.pose.get('LeftIndex3').pos)}`,
        `LIndex tip bone: ${fmt(active.rig.getBone('LeftIndex3').getWorldPosition(new THREE.Vector3()))}`,
        `Jaw node: ${fmt(active.pose.get('Jaw').pos)}`,
        `Jaw bone: ${fmt(active.rig.getBone('Jaw').getWorldPosition(new THREE.Vector3()))}`,
      ]
      : ['No active character'];
    el.textContent = lines.join(' || ');
    el.hidden = false;
  }

  renderer.setAnimationLoop(() => {
    interaction.update();
    camera.lookAt(cameraTarget);
    cameraPanel.update();
    referenceImage.update(bookmark.main === null || bookmark.isAtMain());
    lighting.fitShadows(characters.bounds());
    sceneRenderer.render();
  });
}

init().catch((err) => {
  document.getElementById('loading')!.textContent = `Failed to load character: ${err.message ?? err}`;
  console.error(err);
});
