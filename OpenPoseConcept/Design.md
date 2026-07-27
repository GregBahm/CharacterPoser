##Character Poser

The idea is to eventually hook this up to ComfyUI, either by having one tool drive the other, or by having one tool incorporated as a node into the other. I can figure that out later. Right now the task is just to get the tool right.

I want the tool to first allow me to paint the pose. I want the body to be defined by main points, and then I want to be able to drag the points around and see a 3D preview model of the character which will eventually be used as an AI image gen controlnet. 

#Control Points

Eventually, the tool will allow posing for the body, each hand, and the characters face.
The tool will also eventually allow multiple characters to be posed in a single scene.
Those features will be added later. For the first build, the goal is just to get the body posing right.

#Body Control Points

The body is composed of control points. The points are
	Hips
		Chest
			Head
			Left Shoulder
				Left Elbow
				Left Hand
			Right Shoulder
				Right Elbow
					Right Hand
		Left Knee
			Left Foot
		Right Knee
			Right Foot

Each of these control points can be selected directly on the canvas, or using the selection helper. The selection helper is modeled after the UI for the HIK Control system in Maya. An example implementation of this can be found in the older HikConcept.

#Interaction

Drag any selected points with the left mouse will move them around individually in the XY plane.
Dragging a point with the right mouse will move that point and any child points around in the same way.
While dragging with the left mouse, the mousewheel will move that control point forward and backward in z-space.
While dragging with the right mouse, the mousewheel will move that control point, and all child points, in z-space in the same way.

If not holding left or right mouse, the middle mouse scroll will instead zoom the canvas in and out. Dragging the middle mouse will pan the canvas around.

#Helper widgets

When any node is elected, two helper widgets appear. 

The first helper widget is the twist ring. Selecting and dragging the control point’s twist ring will rotate the selected node around its Z axis. Twisting the node will always rotate child nodes. 

The second helper control is the direction helper. The direction helper appears in front of the control point offset somewhat along the Z axis. Selecting and dragging the direction helper will point the control node towards the direction helper as best as possible. Child nodes will be affected.
