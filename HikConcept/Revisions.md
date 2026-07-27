Revisions

The current application replicates the concept of the HIK system well. This is a great starting point. 
The following revisions shoudl be made one by one. With each revision, I want to test the design before moving on to the next pass. The Readme should be updated by you with each revision.

1. Remove alternative views:

There's an implementation of alternative views in the application currently. This should be removed. The viewport design will be revised later.

2. All nodes rotatable

Right now, the rotation tool can only be used on the hands and feet. It needs to be useable on all elements.

3. Stretchy IK

The current setup has IK working like it should. This "Regular mode" will be one of two modes. There be a second mode, called "Stretchy Mode" will make all nodes stretch or squash if the user drags a position beyond its limits. This squash/stretch will be indicated by a ring indicator around each position manipulator. If the controlled body segment is squashed, the ring indicator will shrink towards 0 size. If the body segment stretches, this body segment will grow by the percenage of stretch.

If the user switches back from "Stretchy Mode' to "Regular Mode" any limb squash/stretch will be perserved.