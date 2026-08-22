import { describe, expect, it } from 'vitest';
import {
  arCorePoseToCameraToWorldMatrix,
  isValidArCorePose,
  poseFromFramePayload,
  quaternionToRotationMatrix,
} from '../src/spatial/poseConversion.js';

const SQRT1_2 = Math.SQRT1_2;

function expectMatrixClose(actual: number[][], expected: number[][], precision = 9): void {
  for (let row = 0; row < expected.length; row++) {
    const expectedRow = expected[row] ?? [];
    const actualRow = actual[row] ?? [];
    for (let col = 0; col < expectedRow.length; col++) {
      expect(actualRow[col], `row ${row} col ${col}`).toBeCloseTo(expectedRow[col] ?? NaN, precision);
    }
  }
}

describe('arCorePoseToCameraToWorldMatrix', () => {
  it('identity pose maps to the identity camera-to-world matrix', () => {
    const matrix = arCorePoseToCameraToWorldMatrix({
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
    });
    expectMatrixClose(matrix, [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ]);
  });

  it('a pure forward translation places the camera at -Z, unrotated', () => {
    // ARCore's camera looks down its own local -Z; at identity rotation that
    // is also world -Z, so moving "forward" 2m is translation (0, 0, -2).
    const matrix = arCorePoseToCameraToWorldMatrix({
      translation: [0, 0, -2],
      rotation: [0, 0, 0, 1],
    });
    expectMatrixClose(matrix, [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, -2],
      [0, 0, 0, 1],
    ]);
  });

  it('a known arbitrary translation with identity rotation passes through untouched', () => {
    const matrix = arCorePoseToCameraToWorldMatrix({
      translation: [1, 2, 3],
      rotation: [0, 0, 0, 1],
    });
    expectMatrixClose(matrix, [
      [1, 0, 0, 1],
      [0, 1, 0, 2],
      [0, 0, 1, 3],
      [0, 0, 0, 1],
    ]);
  });

  it('a 90 degree yaw (rotation about world +Y) turns forward from -Z to -X', () => {
    // Quaternion for +90 deg about Y: [0, sin(45deg), 0, cos(45deg)].
    const matrix = arCorePoseToCameraToWorldMatrix({
      translation: [0, 0, 0],
      rotation: [0, SQRT1_2, 0, SQRT1_2],
    });
    expectMatrixClose(matrix, [
      [0, 0, 1, 0],
      [0, 1, 0, 0],
      [-1, 0, 0, 0],
      [0, 0, 0, 1],
    ]);
    const rotation = matrix.slice(0, 3).map((row) => row.slice(0, 3));
    const forward = matrixVecMul(rotation as number[][], [0, 0, -1]);
    expect(forward[0]).toBeCloseTo(-1, 9);
    expect(forward[1]).toBeCloseTo(0, 9);
    expect(forward[2]).toBeCloseTo(0, 9);
  });

  it('a 90 degree pitch (rotation about world +X) turns forward from -Z to +Y', () => {
    // Quaternion for +90 deg about X: [sin(45deg), 0, 0, cos(45deg)].
    const matrix = arCorePoseToCameraToWorldMatrix({
      translation: [0, 0, 0],
      rotation: [SQRT1_2, 0, 0, SQRT1_2],
    });
    expectMatrixClose(matrix, [
      [1, 0, 0, 0],
      [0, 0, -1, 0],
      [0, 1, 0, 0],
      [0, 0, 0, 1],
    ]);
    const rotation = matrix.slice(0, 3).map((row) => row.slice(0, 3));
    const forward = matrixVecMul(rotation as number[][], [0, 0, -1]);
    expect(forward[0]).toBeCloseTo(0, 9);
    expect(forward[1]).toBeCloseTo(1, 9);
    expect(forward[2]).toBeCloseTo(0, 9);
  });

  it('rejects a degenerate (zero-length) rotation quaternion', () => {
    expect(() =>
      arCorePoseToCameraToWorldMatrix({ translation: [0, 0, 0], rotation: [0, 0, 0, 0] }),
    ).toThrow('pose_rotation_degenerate');
  });

  it('normalizes a non-unit quaternion instead of silently scaling the scene', () => {
    // Same rotation as identity, scaled by 2 - length-2 quaternion.
    const scaled = arCorePoseToCameraToWorldMatrix({ translation: [0, 0, 0], rotation: [0, 0, 0, 2] });
    expectMatrixClose(scaled, [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ]);
  });
});

describe('quaternionToRotationMatrix', () => {
  it('produces an orthonormal matrix for an arbitrary unit quaternion', () => {
    const q = normalize([0.2, 0.4, 0.1, 0.9]);
    const rotation = quaternionToRotationMatrix(q[0], q[1], q[2], q[3]);
    // Each row should be unit length and rows mutually orthogonal.
    for (let i = 0; i < 3; i++) {
      const row = rotation[i] ?? [0, 0, 0];
      const length = Math.sqrt(row[0] * row[0] + row[1] * row[1] + row[2] * row[2]);
      expect(length).toBeCloseTo(1, 9);
    }
    const dot01 = rotation[0][0] * rotation[1][0] + rotation[0][1] * rotation[1][1] + rotation[0][2] * rotation[1][2];
    expect(dot01).toBeCloseTo(0, 9);
  });
});

describe('poseFromFramePayload / isValidArCorePose', () => {
  it('reads a well-formed frame', () => {
    const pose = poseFromFramePayload({ poseTranslation: [1, 2, 3], poseRotation: [0, 0, 0, 1], other: 'x' });
    expect(pose).toEqual({ translation: [1, 2, 3], rotation: [0, 0, 0, 1] });
  });

  it('returns null when the pose fields are missing or malformed', () => {
    expect(poseFromFramePayload({})).toBeNull();
    expect(poseFromFramePayload({ poseTranslation: [1, 2], poseRotation: [0, 0, 0, 1] })).toBeNull();
    expect(poseFromFramePayload({ poseTranslation: [1, 2, 'x'], poseRotation: [0, 0, 0, 1] })).toBeNull();
    expect(isValidArCorePose(null)).toBe(false);
  });
});

function normalize(q: [number, number, number, number]): [number, number, number, number] {
  const length = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

function matrixVecMul(matrix: number[][], vector: [number, number, number]): number[] {
  return matrix.map((row) => (row[0] ?? 0) * vector[0] + (row[1] ?? 0) * vector[1] + (row[2] ?? 0) * vector[2]);
}
