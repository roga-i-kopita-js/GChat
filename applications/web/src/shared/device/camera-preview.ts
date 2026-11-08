import type { CameraState, CameraStreamRef } from './api';

export interface CallCameraPreviewState {
  revision: number;
  source: CameraStreamRef | null;
  status: CameraState['status'];
}
