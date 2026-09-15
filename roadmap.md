# Character Poser Roadmap

Immediate goals for the posing tool. Items are worked one at a time — discussed, built, and
tested in the browser until they feel right — roughly in the order below.

The tool is ultimately meant to create **storyboards with consistent characters** and be strongly
coupled to ComfyUI and other AI image-generation workflows: composed shots built here can be sent
to generation pipelines with their character poses and camera framing intact.

## Architecture decisions

Settled up front so later items don't have to be bolted on:

- **Local file server.** A small Node backend runs alongside Vite. Sessions, the pose library,
  and character/environment assets are plain files on disk, so work can be moved between
  computers and backed up. Not browser-only storage.
- **Storyboard document.** A session contains an ordered array of self-contained shots. Every shot
  stores `characters[]` (each with a model reference and pose graph), lighting/environment state,
  camera framing, and a thumbnail. Existing single-scene sessions migrate into their first shot.
- **ComfyUI integration lives server-side.** Pushing poses, running pose estimation on photos,
  and the ComfyUI connection settings all go through the backend (ComfyUI/Python), not the
  browser.
- **Face rig.** The bundled Renderpeople characters share one skeleton whose finger and facial
  bones (jaw, eyes, brows, mouth corners) drive the detailed hand/face controls.

## Interaction

- [x] **Right-drag cascades down the body.** Using the right mouse button while dragging a point,
      twisting the ring, or moving the direction helper carries the node's children as if parented.
- [x] **Shift constrains point drags to XZ.** Holding Shift before or during a point drag locks
      movement to the world XZ plane in the main, Side, and Top views.
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
- [x] **Storyboard shots.** A thumbnail tray selects, duplicates, deletes, and smoothly
      drag-reorders self-contained scenes inside a session. The active shot appears as a solid
      blue card, autosaves, and receives its thumbnail when the user leaves it. New blank shots
      begin with the default character.
- [x] **Shot reference images.** Drop an image onto a shot, adjust its viewport-overlay opacity
      from the active card, and automatically hide the overlay when the camera leaves its saved
      main angle. Reference image files live beside the other session data.

## Scene

- [x] **Rendering modes.** Untextured (Lambert clay), Textured (Lambert with the models'
      external editable textures), and progressive GPU path tracing via `three-gpu-pathtracer` that
      converges while the scene is still and drops to a raster frame mid-drag. A
      scene-construction aid, not ComfyUI input.
- [x] **Lighting.** Ambient color/intensity, add/remove directional lights (color, intensity,
      direction, softness — soft shadows when path traced; the first light shadows in raster),
      and a screen-space ambient occlusion toggle. Saved with the session.
- [x] **Multiple characters** in one scene. Add/Delete in the Characters section; the body
      view picks across all characters, the detail views follow the active one.
- [ ] **Environment asset** added to the scene.
- [x] **Main view** (was "saved cameras"). One bookmarked camera per scene rather than a list:
      **Set as Main** remembers the view, the button becomes **Set to Main** and snaps back once the
      camera has wandered (a dashed frame around the viewport shows it has), and a hold-to-confirm
      **Clear** forgets it. Saved with the session. Output resolution/FOV per shot is deferred to
      the ComfyUI export item, where it is actually needed.
- [x] **Side/Top insets** (was "multiple views"). Instead of a quad layout, selecting a control
      point pops two inset views spanning the viewport's height: the scene from the side and from
      above (or the far side / below via right-click), at the main camera's distance scaled to the
      inset size, showing only the selected point. Dragging it there moves it in that view's
      plane, so a point can be placed in all three dimensions without leaving the main view.

## ComfyUI

- [ ] **Pose from photo.** Upload an image of a person, extract the OpenPose skeleton in
      ComfyUI, and match that pose in the tool.
- [ ] **Export to ComfyUI.** Push the current pose into a running ComfyUI as an OpenPose
      controlnet input via its API.
