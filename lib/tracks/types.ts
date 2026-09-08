export interface TrackData {
  id: string;
  name: string;
  lengthMeters: number;
  /** Closed loop of [x, y, z] points in meters, uniformly spaced. */
  centerline: [number, number, number][];
  /** Track width in meters, one entry per centerline point. */
  width: number[];
  startPos: { x: number; z: number; headingRad: number };
}
