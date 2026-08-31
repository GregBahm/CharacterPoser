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

`npm run dev` starts Vite and the local persistence API together. Session and pose files are
written under `data/` using atomic JSON-file replacement. Set `CHARACTER_POSER_DATA_DIR` before
launching to keep them elsewhere for backup or transfer to another computer.

## Persistence

- The current session autosaves after pose, camera, reset, framing, and control-view changes.
  On startup, the most recently updated valid session is loaded; if none exists, a default
  session is created.
- Use **New** to start a reset session or select a saved session and choose **Load**.
- The pose library saves the currently active control scope. Full-body poses preserve the
  character's current hand and facial details when loaded. Hand and face poses are stored
  relative to their hand/head anchor, so they can be applied after those anchors move.
- Invalid or unsupported files are reported in the sidebar instead of being overwritten.

## Characters

Three Renderpeople models ship in `public/`: **Carla**, **Claudia**, and **Eric**. A scene holds
any number of characters, each keeping its model for life:

- **Add** (Characters section) puts the chosen model into the scene in its base pose, standing
  beside the others, and makes it the active character.
- **Delete** appears while one of a character's control points is selected and removes that
  character.
- In the **Body** view every character's body points are shown and pickable; picking one makes
  its character active. The **Face** and **Hand** views show only the active character's
  controls, and the pose library saves/loads the active character.
- The characters, their poses, and which one is active are saved with the session. Adding or
  removing a character clears pose history.
- The FBX files in `public/` are the `SourceArt/` originals with their embedded 8K diffuse textures
  shrunk to 2K by `tools/shrink-textures.ps1` (which drives `tools/fbx-texture.mjs`, a binary-FBX
  texture swapper); re-run it after replacing a source file.

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
- Unity-style camera controls: **Alt + left-drag** orbits, **middle-drag** pans,
  and **Alt + right-drag left/right** zooms. **Mousewheel** (not dragging) also zooms.
- Hovering brightens the exact control point, twist ring, or direction helper that will be
  manipulated. **Ctrl+Z** undoes pose edits and **Ctrl+Shift+Z** redoes them (up to 50 steps);
  camera navigation is not included in pose history.
- **Escape** deselects; **Reset Pose** returns to the bind pose.
- The sidebar has two tabs. **Controls** is the selected character: the Body/Face/Hand control
  maps, the pose library, Reset Pose, and Delete. It is empty until a control point is selected
  and opens by itself when one is. **Scene** holds sessions, adding characters, and rendering.
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
- `src/models.ts`, `src/character.ts`, `src/scene.ts` — the bundled model list, one posable
  character (rig + pose graph + control points), and the `CharacterScene` that adds/removes them
  and tracks the active one.
- `src/rig.ts` — FBX loading (keeping the embedded diffuse texture), Renderpeople bone mapping
  (auto-oriented from the file's Z-up or Y-up axes), and fitting bones to a solved skeleton.
  Stateless per call: each bone's orientation = aim-correction × rotation-delta × bind, and each
  segment bone is scaled along its child axis by solvedLength / bindLength (plain axial stretch,
  no volume preservation), with downstream joints restored to exact world transforms so the
  stretch doesn't propagate.
  Leaf bones (head/hands/feet) follow their node's rotation delta exactly.
- `src/control-points.ts`, `src/interaction.ts` — per-character control spheres, the widgets,
  and all pointer/wheel handling; pose history snapshots every character.
- `src/render-modes.ts` — the three render modes. Untextured (clay) and Textured are Lambert
  shading without/with the models' embedded diffuse textures, optionally with N8AO screen-space
  ambient occlusion (neural denoise, accumulating over frames while the view is still); Path Traced runs `three-gpu-pathtracer` progressively with the textures,
  pausing on pose/camera/light changes and rebuilding or relighting once they settle.
- `src/lighting.ts`, `src/lighting-ui.ts` — the scene's lighting (ambient color/intensity plus
  up to 8 directional lights with color, intensity, azimuth, elevation, softness) and its panel.
  The first light casts the raster shadows. Softness only shows when path traced: each soft light
  is stood in for by a distant circular area light of the same irradiance, since the path
  tracer's directional lights have no angular size. Lighting is saved with the session. Control points and widgets draw in an overlay scene on top of
  every mode. The chosen mode is a per-browser preference (localStorage), not session state.
- `src/ui.ts`, `src/character-ui.ts`, `src/state.ts`, `src/main.ts` — body-map sidebar, the
  Characters add/delete panel, selection state (active character + joint), scene bootstrap.
- `src/documents.ts` — versioned scene/pose formats, strict validation, and pose conversion.
- `src/persistence-controller.ts` — pose-library operations and serialized session autosave.
- `server.mjs` — localhost-only Vite host and constrained atomic JSON file API.

Debug query params: `?testdrag`, `?testsubtree`, `?testaim`, `?testtwist` apply scripted
manipulations; `?debug` prints joint positions; `?select=<JointId>` preselects a node.
`window.poser` exposes `{ scene, state, camera, interaction, sceneRenderer }` plus `character`,
`pose`, and `rig` getters for the active character, for scripted testing.
