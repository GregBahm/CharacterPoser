import * as THREE from 'three';
import { CharacterRig } from './rig.ts';
import { PoseGraph } from './pose.ts';
import { ControlPoints, Interaction, Widgets } from './interaction.ts';
import { AppState } from './state.ts';
import { UI } from './ui.ts';

const canvas = document.getElementById('scene-canvas') as HTMLCanvasElement;
const viewportArea = document.getElementById('viewport-area') as HTMLElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x22262e);

// Front-facing camera; orientation is fixed (the canvas pans/zooms, never orbits).
const cameraTarget = new THREE.Vector3(0, 0.95, 0);
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
camera.position.set(0, 0.95, 4.2);
camera.lookAt(cameraTarget);

// Lighting + ground
scene.add(new THREE.HemisphereLight(0xcfd8e6, 0x3a3f4a, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(3, 6, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -3;
sun.shadow.camera.right = 3;
sun.shadow.camera.top = 3;
sun.shadow.camera.bottom = -3;
scene.add(sun);

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
  const w = viewportArea.clientWidth;
  const h = viewportArea.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

async function init() {
  const params = new URLSearchParams(location.search);

  const rig = await CharacterRig.load(encodeURI('/X Bot.fbx'));
  scene.add(rig.root);

  const pose = new PoseGraph(rig.bindWorldPositions);
  rig.applyPose(pose.solveSkeleton());

  const state = new AppState();
  const points = new ControlPoints(pose, state);
  const widgets = new Widgets(pose, state);
  scene.add(points.group, widgets.group);

  const interaction = new Interaction({ canvas, camera, cameraTarget, rig, pose, state, points, widgets });
  new UI(state, () => {
    pose.reset();
    interaction.applyPose();
    state.emit();
  });

  // Scripted manipulations for automated verification.
  if (params.has('testdrag')) {
    // Left-drag equivalent: hand alone moves, forearm stretches to reach it.
    pose.moveTo('LeftHand', new THREE.Vector3(0.45, 1.6, 0.5), false);
    interaction.applyPose();
  }
  if (params.has('testsubtree')) {
    // Right-drag equivalent: shoulder moves with elbow+hand rigidly.
    pose.moveTo('LeftArm', new THREE.Vector3(0.25, 1.75, 0.3), true);
    interaction.applyPose();
  }
  if (params.has('testaim')) {
    // Direction helper equivalent: aim the chest up-and-forward.
    pose.aimAt('Spine2', pose.get('Spine2').pos.clone().add(new THREE.Vector3(0, 0.8, 0.6)));
    interaction.applyPose();
  }
  if (params.has('testtwist')) {
    // Twist ring equivalent: roll the hips around their forward axis.
    pose.twist('Hips', 0.6);
    interaction.applyPose();
  }
  if (params.has('select')) {
    state.select((params.get('select') as never) || 'Head');
  }

  document.getElementById('loading')!.hidden = true;
  document.getElementById('controls')!.hidden = false;

  // Debug hook for scripted/automated testing.
  (window as unknown as { poser?: unknown }).poser = { pose, rig, state, camera, interaction };

  if (params.has('debug')) {
    const el = document.getElementById('loading')!;
    const fmt = (v: THREE.Vector3) => v.toArray().map((n) => n.toFixed(3)).join(', ');
    const lines = [
      `Hips: ${fmt(pose.get('Hips').pos)}`,
      `Chest: ${fmt(pose.get('Spine2').pos)}`,
      `LHand node: ${fmt(pose.get('LeftHand').pos)}`,
      `LHand bone: ${fmt(rig.getBone('LeftHand').getWorldPosition(new THREE.Vector3()))}`,
      `LFoot bone: ${fmt(rig.getBone('LeftFoot').getWorldPosition(new THREE.Vector3()))}`,
    ];
    el.textContent = lines.join(' || ');
    el.hidden = false;
  }

  renderer.setAnimationLoop(() => {
    interaction.update();
    camera.lookAt(cameraTarget);
    renderer.render(scene, camera);
  });
}

init().catch((err) => {
  document.getElementById('loading')!.textContent = `Failed to load character: ${err.message ?? err}`;
  console.error(err);
});
