# Character Poser — OpenPose Concept

Direct-manipulation posing prototype (second interaction-model concept, after `HikConcept`).
There is no IK solver: the body is a tree of free-floating control points that are moved
directly, OpenPose-style, and the mesh stretches to fit the points wherever they go.
See `Design.md` for the design brief.

## Running

```
npm install
npm run dev     # dev server at http://localhost:5173
npm run build   # production build to dist/
```

## Interaction

- **Left-drag** a control point: move it alone in the view XY plane.
- **Right-drag** a control point: move it and all of its children rigidly.
- **Mousewheel while dragging** (either button): move the point (or subtree) in z-depth instead.
- **Select** a point (click it, or use the sidebar body map) to show the two helper widgets:
  - **Twist ring** (teal): drag along it to roll the node and its subtree around the node's aim axis.
  - **Direction helper** (orange dot): drag it to aim the node at it; children follow rigidly.
    Mousewheel while dragging the helper moves the aim target in depth.
  - Both widgets live in the node's local frame: the helper always sits along the node's
    current aim (world +Z at rest), and the ring lies perpendicular to it.
- **Middle-drag** pans the canvas; **mousewheel** (not dragging) zooms. The camera never orbits.
- **Escape** deselects; **Reset Pose** returns to the bind pose.

## Architecture

- `src/pose.ts` — the pose model. 13 control points (`CONTROL_JOINTS`) in the design's control
  tree (`CONTROL_PARENT`), each with a world position and an accumulated world-rotation delta.
  Operations: translate (with/without subtree), `aimAt`, `twist` — rotations pivot on the node
  and carry the whole subtree. `solveSkeleton()` derives all 20 Mixamo joints: sockets/neck ride
  rigidly on their control, spine mids interpolate (and slerp twist) along Hips→Chest.
- `src/rig.ts` — FBX loading, Mixamo bone mapping, and fitting bones to a solved skeleton.
  Stateless per call: each bone's length scales to span its solved joints exactly (that's where
  squash/stretch comes from) and its orientation = aim-correction × rotation-delta × bind.
  Leaf bones (head/hands/feet) follow their node's rotation delta exactly.
- `src/interaction.ts` — control spheres, the two widgets, and all pointer/wheel handling.
- `src/ui.ts`, `src/state.ts`, `src/main.ts` — HIK-style body-map sidebar, selection state,
  scene bootstrap.

Debug query params: `?testdrag`, `?testsubtree`, `?testaim`, `?testtwist` apply scripted
manipulations; `?debug` prints joint positions; `?select=<JointId>` preselects a node.
`window.poser` exposes `{ pose, rig, state, camera, interaction }` for scripted testing.
