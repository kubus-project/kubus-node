/**
 * ARCore camera pose -> Nerfstudio camera-to-world matrix.
 *
 * ARCore's `Pose` is right-handed, +Y up, and the camera looks down its own
 * local -Z axis (see `third_party/arcore_flutter_plugin/.../ArCoreView.kt`,
 * which serializes `pose.translation`/`pose.rotationQuaternion` verbatim —
 * the phone never re-expresses them in another convention). Nerfstudio's
 * `transforms.json` camera-to-world matrices use the same convention
 * (right-handed, +Y up, camera looks down local -Z; the OpenGL/Blender
 * convention nerfstudio documents). Both the rotation and the translation
 * are therefore already expressed in the target frame: the conversion is a
 * direct quaternion-to-matrix expansion plus translation placement, with no
 * axis remap, handedness flip, or scale correction.
 */

export interface ArCorePose {
  /** Camera position in ARCore world space, metres: [x, y, z]. */
  translation: readonly [number, number, number];
  /** ARCore quaternion order: [x, y, z, w]. */
  rotation: readonly [number, number, number, number];
}

/** 4x4 row-major camera-to-world matrix, as nerfstudio's `transform_matrix` expects. */
export type Mat4Rows = [
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isValidArCorePose(value: unknown): value is ArCorePose {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ArCorePose>;
  return (
    Array.isArray(candidate.translation) &&
    candidate.translation.length === 3 &&
    candidate.translation.every(isFiniteNumber) &&
    Array.isArray(candidate.rotation) &&
    candidate.rotation.length === 4 &&
    candidate.rotation.every(isFiniteNumber)
  );
}

/** Reads a pose straight off a `frames.json` frame entry, or returns null if absent/malformed. */
export function poseFromFramePayload(frame: Record<string, unknown>): ArCorePose | null {
  const translation = frame.poseTranslation;
  const rotation = frame.poseRotation;
  const candidate = { translation, rotation };
  return isValidArCorePose(candidate) ? candidate : null;
}

/**
 * Converts a unit (or near-unit) quaternion `[x, y, z, w]` to a row-major
 * rotation matrix. Standard local-to-world expansion for a unit quaternion.
 */
export function quaternionToRotationMatrix(
  x: number,
  y: number,
  z: number,
  w: number,
): [[number, number, number], [number, number, number], [number, number, number]] {
  const lengthSquared = x * x + y * y + z * z + w * w;
  if (!Number.isFinite(lengthSquared) || lengthSquared <= 0) {
    throw new Error('pose_rotation_degenerate');
  }
  // Normalize defensively: capture pose quaternions are expected unit-length,
  // but never trust that without checking - a non-unit quaternion here would
  // silently scale the reconstructed scene.
  const inverseLength = 1 / Math.sqrt(lengthSquared);
  const nx = x * inverseLength;
  const ny = y * inverseLength;
  const nz = z * inverseLength;
  const nw = w * inverseLength;

  const xx = nx * nx;
  const yy = ny * ny;
  const zz = nz * nz;
  const xy = nx * ny;
  const xz = nx * nz;
  const yz = ny * nz;
  const wx = nw * nx;
  const wy = nw * ny;
  const wz = nw * nz;

  return [
    [1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
    [2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
    [2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
  ];
}

/** Builds the 4x4 nerfstudio `transform_matrix` (camera-to-world, row-major) for one ARCore pose. */
export function arCorePoseToCameraToWorldMatrix(pose: ArCorePose): Mat4Rows {
  const [x, y, z, w] = pose.rotation;
  const [tx, ty, tz] = pose.translation;
  const rotation = quaternionToRotationMatrix(x, y, z, w);
  return [
    [rotation[0][0], rotation[0][1], rotation[0][2], tx],
    [rotation[1][0], rotation[1][1], rotation[1][2], ty],
    [rotation[2][0], rotation[2][1], rotation[2][2], tz],
    [0, 0, 0, 1],
  ];
}
