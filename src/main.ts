import * as THREE from 'three';
import { CharacterRig } from './rig.ts';
import { ControlPoints, Interaction } from './interaction.ts';
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

// The primary view uses a fixed camera angle.
const mainCamera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
mainCamera.position.set(2.7, 1.7, 3.5);
mainCamera.lookAt(0, 0.9, 0);

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
  mainCamera.aspect = w / h;
  mainCamera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

async function init() {
  const params = new URLSearchParams(location.search);
  if (params.has('front')) {
    mainCamera.position.set(0, 1.0, 4.0);
    mainCamera.lookAt(0, 0.9, 0);
  }
  const rig = await CharacterRig.load(encodeURI('/X Bot.fbx'), !params.has('noik'));
  scene.add(rig.root);

  const state = new AppState();
  const points = new ControlPoints(rig, state);
  scene.add(points.group);

  const interaction = new Interaction({ canvas, scene, mainCamera, rig, state, points });
  new UI(state, rig);

  if (params.has('testrotate')) {
    state.select('Head');
    state.setRotateMode(true);
  }

  // Scripted drags for automated verification of the full-body solve.
  if (params.has('testdrag')) {
    const target = new THREE.Vector3(0.3, 1.35, 0.5); // left hand toward chest front
    for (let i = 0; i < 8; i++) rig.solver.solve(new Map([['LeftHand', target]]));
    rig.applyPose();
  }
  if (params.has('testcrouch')) {
    const target = new THREE.Vector3(0, 0.55, 0); // hips straight down, feet pinned
    for (let i = 0; i < 8; i++) rig.solver.solve(new Map([['Hips', target]]));
    rig.applyPose();
  }

  document.getElementById('loading')!.hidden = true;
  document.getElementById('controls')!.hidden = false;

  if (params.has('debug')) {
    const el = document.getElementById('loading')!;
    const fmt = (v: THREE.Vector3) => v.toArray().map((n) => n.toFixed(3)).join(', ');
    const s = rig.solver;
    const lfBone = rig.getJointWorldPos('LeftFoot', new THREE.Vector3());
    const lines = [
      `hips solved: ${fmt(s.get('Hips').pos)}`,
      `LF solved: ${fmt(s.get('LeftFoot').pos)}  pin: ${fmt(s.get('LeftFoot').pinPos)}`,
      `LF bone: ${fmt(lfBone)}`,
      `LLeg(knee) solved: ${fmt(s.get('LeftLeg').pos)}`,
      `LUpLeg solved: ${fmt(s.get('LeftUpLeg').pos)}`,
    ];
    el.textContent = lines.join(' || ');
    el.hidden = false;
  }

  renderer.setAnimationLoop(() => {
    interaction.update();

    // Main view: full canvas.
    const w = viewportArea.clientWidth;
    const h = viewportArea.clientHeight;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.render(scene, mainCamera);
  });
}

init().catch((err) => {
  document.getElementById('loading')!.textContent = `Failed to load character: ${err.message ?? err}`;
  console.error(err);
});
