/**
 * Shared 3D conventions of Ccut: the camera tracker (`tracking/camera3d`),
 * 3D layers, the camera element and the renderer all use these shapes.
 * Plain data, no framework imports.
 *
 * **Axes** (After Effects and computer vision agree): x right, y down,
 * z forward, away from the viewer. Right-handed: x cross y = z. A camera
 * looks along its own +z; a point is in front of it when its camera-space
 * z is > 0.
 *
 * **Frame pixels**: continuous pixel coordinates of a picture W x H with
 * the origin at its top-left CORNER, so the picture spans [0, W] x [0, H]
 * and its centre is (W / 2, H / 2). The 2D tracker stores pixel INDEX
 * coordinates of a smaller analysis frame (centre of pixel i at x = i, see
 * `tracking/camera/types.ts`); convert with
 * `x_frame = (x_index + 0.5) * W / analysisWidth`.
 *
 * **Layers**: a planar layer's content lies in its local z = 0 plane, local
 * x right, local y down, anchored at the content centre; its front face looks
 * along local -z (towards a default camera standing at negative z).
 */

export type Vec3 = readonly [number, number, number];

/** Unit quaternion `[w, x, y, z]`. */
export type Quat = readonly [number, number, number, number];

/** Row-major 3x3 matrix. */
export type Mat3 = readonly [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
];

/**
 * Row-major 2x3 affine map:
 * `x' = m[0] x + m[1] y + m[2]`, `y' = m[3] x + m[4] y + m[5]`.
 */
export type Affine2 = readonly [number, number, number, number, number, number];

/**
 * A pinhole camera at one instant. Square pixels, principal point at the
 * frame centre, no lens distortion (the same model as AE's 3D camera).
 */
export interface CameraState {
	/** World-to-camera rotation R: `X_camera = R (X_world - position)`. */
	rotation: Quat;
	/** Camera centre in world units. */
	position: Vec3;
	/**
	 * Focal length in frame pixels of the frame this camera images.
	 * Horizontal angle of view = `2 atan(frameWidth / (2 focalPx))`.
	 */
	focalPx: number;
}

/**
 * The camera a frame is rendered through, ready to project world points
 * onto the canvas: world -> camera -> frame pixels -> canvas pixels.
 */
export interface ViewCamera extends CameraState {
	/** The picture the camera images (the tracked video's source frame, or the canvas for the default camera). */
	frameWidth: number;
	frameHeight: number;
	/**
	 * Frame pixels -> canvas pixels. For a tracked camera this is where the
	 * tracked video clip is drawn on the canvas at that time (its 2D
	 * transform, contain-fit, flips); for the default camera the identity.
	 */
	frameToCanvas: Affine2;
	/** `tracked`: reproduces a camera solve. `default`: the AE-like comp camera that makes z = 0 look 2D. */
	kind: "tracked" | "default";
}

/**
 * Transform of a 3D layer (AE: Position, Orientation, X/Y/Z Rotation,
 * Scale). Local -> world:
 * `X_world = position + R_orientation R_rotation (scale * X_local)`,
 * each R = Rz(z) Ry(y) Rx(x) (x applied first), angles in degrees.
 * Units: world units; for the default camera world units are canvas pixels
 * with the origin at the canvas centre.
 */
export interface Transform3D {
	position: Vec3;
	orientationDeg: Vec3;
	rotationDeg: Vec3;
	/** Factors (1 = 100 %), applied to the layer's local content units. */
	scale: Vec3;
}

/** An oriented plane: `normal` is unit length. */
export interface Plane {
	point: Vec3;
	normal: Vec3;
}

/**
 * The AE "target" (bullseye) drawn on a plane through selected or hovered
 * track points. `normal` is unit length and points towards the camera that
 * was used to build it (the visible side). `radius` is in world units.
 */
export interface Target {
	center: Vec3;
	normal: Vec3;
	radius: number;
}
