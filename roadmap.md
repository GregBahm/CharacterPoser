# Character Poser Roadmap

Immediate goals for the posing tool. Items are worked one at a time — discussed, built, and
tested in the browser until they feel right — roughly in the order below.

The tool is ultimately meant to be **strongly coupled to ComfyUI AI workflows**: poses built here
are pushed straight into a running ComfyUI as OpenPose controlnet input.

## Architecture decisions

Settled up front so later items don't have to be bolted on:

- **Local file server.** A small Node backend runs alongside Vite. Sessions, the pose library,
  and character/environment assets are plain files on disk, so work can be moved between
  computers and backed up. Not browser-only storage.
- **Scene document.** The unit of save/load is a `Scene`: `characters[]` (each with a model
  reference and its own pose graph), an environment reference, and `cameras[]` (each carrying
  resolution and FOV so exports match the generation size). Introduced with sessions (below),
  not after multi-character support.
- **ComfyUI integration lives server-side.** Pushing poses, running pose estimation on photos,
  and the ComfyUI connection settings all go through the backend (ComfyUI/Python), not the
  browser.
- **Face rig.** The bundled Renderpeople characters share one skeleton whose finger and facial
  bones (jaw, eyes, brows, mouth corners) drive the detailed hand/face controls.

## Interaction

- [x] **Shift-drag cascades down the body.** Holding Shift while dragging a point, twisting the
      ring, or moving the direction helper carries the node's children as if parented to it.
      (Right mouse button currently does the same; may be freed up later.)
- [x] **Swap the character model.** The MPFB character replaced X Bot, then three Renderpeople
      models (Carla, Claudia, Eric) replaced MPFB. A character keeps its model for life; the
      model is chosen when it is added to the scene.
- [x] **Hands and face.** Zoom in on the hands and face and pose them with the same
      control-point model (finger bones; facial bones/blendshapes on the new model).
- [x] **Manipulator hover feedback.** Brighten the exact point, twist ring, or direction helper
      that will receive the next drag.
- [x] **Pose undo/redo.** Keep 50 gesture-level pose edits with Ctrl+Z/Ctrl+Shift+Z while
      leaving camera navigation outside pose history.

## Persistence (local file server)

- [x] **Pose library.** Save and load full-body poses, hand poses, and face poses as files.
- [x] **Sessions.** Save the scene state on every edit; create new sessions and load existing
      ones. This is where the `Scene` document is introduced.

## Scene

- [x] **Rendering modes.** Untextured (Lambert clay), Textured (Lambert with the models'
      embedded textures), and progressive GPU path tracing via `three-gpu-pathtracer` that
      converges while the scene is still and drops to a raster frame mid-drag. A
      scene-construction aid, not ComfyUI input.
- [x] **Lighting.** Ambient color/intensity, add/remove directional lights (color, intensity,
      direction, softness — soft shadows when path traced; the first light shadows in raster),
      and a screen-space ambient occlusion toggle. Saved with the session.
- [x] **Multiple characters** in one scene. Add/Delete in the Characters section; the body
      view picks across all characters, the detail views follow the active one.
- [ ] **Environment asset** added to the scene.
- [ ] **Saved cameras.** Save camera positions (with resolution/FOV) and switch between the
      free camera and saved cameras.
- [ ] **Multiple views.** Several active, editable camera views at once (quad-view style).

## ComfyUI

- [ ] **Pose from photo.** Upload an image of a person, extract the OpenPose skeleton in
      ComfyUI, and match that pose in the tool.
- [ ] **Export to ComfyUI.** Push the current pose into a running ComfyUI as an OpenPose
      controlnet input via its API.
