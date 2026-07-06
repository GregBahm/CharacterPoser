# Character Poser

Character Poser is a tool for posing 3D models of characters. The core functionality is the character control rig based on the "Human IK" system in Maya. The user is can drag points of a character's body around and the IK solver will attempt to adjust the full body pose to compesate. Like in the HIK system, any given joint can be locked in terms of position and orientation.

The user can eventually add multiple character assets, loaded as FBX models with standard Mixamo style skeletons. In the inital prototype, only the default asset "X Bot.fbx" is used.

The user will also eventually be able to add environment models. But this feature will be added later.

The user is presented a quick selection interface of the 15 main points of body manipulation. Later, the user will be able to "zoom in" on hands and face control, but the initial prototype is just for head/torso/arms/legs and the rotation of hands/feet.

The application presents a primary view of the scene with a fixed camera angle. The application also offers multiple alternative angles that can be broken off of the main application into floating panels and discarded as desired.

## Running

```
npm install
npm run dev     # dev server at http://localhost:5173
npm run build   # production build to dist/
```

## Usage

- **Drag** any control point (blue sphere) in the main view or any floating panel — the full-body IK solver poses the rest of the body to compensate.
- **Select** a point by clicking it in 3D or on the body map in the sidebar.
- **Pin Position** (`P`) locks the selected joint in place during solves. Feet start pinned so the body stays grounded.
- **Lock Orientation** (`O`) holds the selected joint's world orientation through solves. Head and feet start locked (head stays upright, feet stay flat).
- **Rotate Tool** (`R`) shows a rotation gizmo for the head, hands, and feet.
- **Views** buttons open floating panels with alternative camera angles; drag their title bars to move them, resize from the corner, or close them with ✕.

## Architecture

- `src/solver.ts` — multi-chain FABRIK full-body solver over the 20-joint humanoid tree (HumanIK-style). Pinned joints act as standing targets, unreachable pulls drag the hips, pelvis/shoulder girdles are rigid bodies, and knees/elbows get bend-direction hints only when their chain is compressed.
- `src/rig.ts` — FBX loading, Mixamo bone mapping, and conversion of solved joint positions back into bone rotations each frame (stateless from the bind pose, so no drift).
- `src/interaction.ts` — control spheres, picking/dragging across all views, rotate gizmo.
- `src/panels.ts` — floating view panels rendered as scissored viewports sharing one canvas/scene.
- `src/ui.ts`, `src/state.ts`, `src/main.ts` — sidebar quick-select UI, shared selection state, scene bootstrap.

Debug query params (e.g. `?testcrouch&front&debug`): `testdrag`/`testcrouch` apply scripted solves, `front` uses a front camera, `debug` prints solver positions, `panels=front,right` opens panels, `testrotate` enables the rotate tool on the head.