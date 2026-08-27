# Character Poser

Direct-manipulation character posing in the browser. There is no IK solver: the body is a tree of
free-floating control points that are moved directly, OpenPose-style, and the mesh stretches to fit
the points wherever they go. The same model extends into close-up finger and bone-driven facial
controls. The tool will eventually drive AI image generation through ComfyUI controlnet.

## Running

Double-click `Launch.bat` — it opens a console window, starts the dev server, and opens the page in your browser. Close the console window to stop the server.

Or manually:

```
npm install
npm run dev     # dev server at http://localhost:5173
npm run build   # production build to dist/
```

## Interaction

Everywhere, a modifier picks the scope: **plain manipulation affects only the node itself;
holding Shift (or using the right mouse button) cascades it down the body, carrying all of the
node's children rigidly as if they were parented to it.**

- **Drag** a control point: move it in the view XY plane (Shift = with subtree).
- **Mousewheel while dragging** (either button): move the point (or subtree) in z-depth instead.
- **Select** a point (click it, or use the sidebar body map) to show the two helper widgets:
  - **Twist ring** (teal): drag along it to roll the node around its aim axis
    (Shift = subtree rotates with it).
  - **Direction helper** (orange dot): drag it to aim the node at it
    (Shift = subtree rotates with it).
    Mousewheel while dragging the helper moves the aim target in depth.
  - **Stretch ring** (lavender, passive): coplanar with the twist ring, radius = twist-ring
    radius x the stretch of the segment ending at this node. At natural length it hides behind
    the twist ring; it grows when the segment is longer than natural, shrinks when shorter.
  - All widgets live in the node's local frame: the helper always sits along the node's
    current aim (world +Z at rest), and the rings lie perpendicular to it.
- **Alt + left-drag** orbits (tumbles) the camera around its target, Maya/Unity style;
  **middle-drag** pans; **mousewheel** (not dragging) zooms.
- **Escape** deselects; **Reset Pose** returns to the bind pose.
- Use the **Body**, **Face**, **L Hand**, and **R Hand** tabs to switch control maps; switching
  never moves the camera. Click the **magnifying glass** beside a tab to also frame that area in
  the viewport (the detail views frame in close). You can also double-click the head or either
  hand on the body map to switch to its detail map.

## Architecture

- `src/pose.ts` — the pose model. Body, finger, and facial control points in the design's
  control tree (`CONTROL_PARENT`), each with a world position and an accumulated world-rotation delta.
  Operations: `translate`, `aimAt`, `twist` — each takes a `withChildren` flag; rotations pivot
  on the node and optionally carry the subtree. `solveSkeleton()` derives the complete body and
  detail skeleton: sockets/neck ride rigidly on their control, and spine mids interpolate (and
  slerp twist) along Hips→Chest.
- `src/rig.ts` — FBX loading, MPFB/Mixamo bone mapping, and fitting bones to a solved skeleton.
  Stateless per call: each bone's orientation = aim-correction × rotation-delta × bind, and each
  segment bone is scaled along its child axis by solvedLength / bindLength (plain axial stretch,
  no volume preservation), with the child counter-scaled so the stretch doesn't propagate.
  Leaf bones (head/hands/feet) follow their node's rotation delta exactly.
- `src/interaction.ts` — control spheres, the widgets, and all pointer/wheel handling.
- `src/ui.ts`, `src/state.ts`, `src/main.ts` — body-map sidebar, selection state, scene bootstrap.

Debug query params: `?testdrag`, `?testsubtree`, `?testaim`, `?testtwist` apply scripted
manipulations; `?debug` prints joint positions; `?select=<JointId>` preselects a node.
`window.poser` exposes `{ pose, rig, state, camera, interaction }` for scripted testing.
