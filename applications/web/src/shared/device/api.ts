import type {
  DeviceState,
  FileRef,
  Metadata as FileMetadata,
  Resource as PermissionResource,
} from './contract';
import type { DeviceNavigation } from './navigation';

export { DeviceError } from './contract';

export { StorageArea } from './storage';

import type { DeviceStorage, StorageArea } from './storage';

export type StorageService = Pick<DeviceStorage, 'getRoot' | 'getUsage'>;

export { NavigationEvent, NavigationOutcome } from './navigation';

export type {
  DeviceLocation,
  NavigationResult,
  NavigationState,
  NavigationEvents,
} from './navigation';

export type NavigationService = Pick<
  DeviceNavigation,
  'getState' | 'navigate' | 'revalidate' | 'on'
>;

export interface DeviceCore<THttp = unknown> {
  readonly http: THttp;
  readonly session: SessionService<THttp>;
  readonly transport: TransportService;
  readonly calls: CallsService;
  readonly notifications: NotificationsService;
  readonly updates: UpdatesService;
  readonly lifecycle: LifecycleService;
  readonly system: SystemService;
  readonly permissions: PermissionsService;
  readonly files: FilesService;
  readonly storage: StorageService;
  readonly camera: CameraService;
  readonly audio: AudioService;
  readonly navigation: NavigationService;
}

export type PermissionReading = DeviceState['microphone'] | DeviceState['geolocation'];

export interface CallOptions {
  signal?: AbortSignal;
}

export type Unsubscribe = () => void;

export interface Versioned {
  readonly revision: number;
}

export interface EventSource<Events extends object> {
  on<E extends keyof Events>(event: E, handler: (data: Events[E]) => void): Unsubscribe;
}

export type Selection<T> = { outcome: 'completed'; value: T } | { outcome: 'cancelled' };

export interface PageRequest {
  cursor: string | null;
  limit: number;
}

export interface Page<T> {
  entries: T[];
  nextCursor: string | null;
}

import { DeviceErrorCode } from './error-code';

export { DeviceErrorCode } from './error-code';

export interface DeviceErrorDetails {
  settingsHint?: 'appSettings' | 'siteSettings' | 'none';
  outcome?: 'unknown' | 'partial';
  completedIds?: string[];
  destinationId?: string;
  reasonCode?: string;
  retryAfter?: number;
}

export interface DeviceFailure {
  code: DeviceErrorCode;
  service: string;
  operation: string;
  message: string;
  details?: DeviceErrorDetails;
}

export enum CheckStatus {
  Passed = 'passed',
  Failed = 'failed',
  NotChecked = 'notChecked',
}

export type CheckItem = {
  service: string;
  check: string;
} & (
  | { status: CheckStatus.Passed }
  | { status: CheckStatus.Failed; error: DeviceFailure }
  | { status: CheckStatus.NotChecked; reason: string }
);

export interface CheckReport {
  checks: CheckItem[];
}

export interface SystemService {
  check(options?: CallOptions): Promise<CheckReport>;
}

export enum LifecycleEvent {
  StateChanged = 'stateChanged',
  VisibilityChanged = 'visibilityChanged',
}

export interface LifecycleState extends Versioned {
  phase: 'starting' | 'ready' | 'error' | 'stopped';
  visibility: 'foreground' | 'background';
  error: DeviceFailure | null;
}

export interface LifecycleEvents {
  [LifecycleEvent.StateChanged]: LifecycleState;
  [LifecycleEvent.VisibilityChanged]: Versioned & {
    visibility: LifecycleState['visibility'];
  };
}

export interface LifecycleService extends EventSource<LifecycleEvents> {
  start(options?: CallOptions): Promise<void>;
  getState(options?: CallOptions): Promise<LifecycleState>;
  retry(options?: CallOptions): Promise<void>;
  stop(): Promise<void>;
}

export enum PermissionEvent {
  Changed = 'changed',
}

export interface PermissionEvents {
  [PermissionEvent.Changed]: Versioned & {
    resource: PermissionResource;
    state: PermissionReading;
  };
}

export interface PermissionsService extends EventSource<PermissionEvents> {
  read(resource: PermissionResource, options?: CallOptions): Promise<PermissionReading>;
  request(resource: PermissionResource, options?: CallOptions): Promise<PermissionReading>;
  openSettings(options?: CallOptions): Promise<void>;
}

export enum FileEvent {
  AccessChanged = 'accessChanged',
  Changed = 'changed',
}

export interface FileEvents {
  [FileEvent.AccessChanged]: Versioned & { refs: FileRef[] };
  [FileEvent.Changed]: Versioned & { ref: FileRef };
}

export interface ReadChunk {
  data: Uint8Array;
  bytesRead: number;
  eof: boolean;
  version: string | null;
}

export interface WriteSession {
  write(offset: number, data: Uint8Array, options?: CallOptions): Promise<{ bytesWritten: number }>;
  commit(options?: CallOptions): Promise<FileMetadata>;
  abort(): Promise<void>;
}

export interface FilesService extends EventSource<FileEvents> {
  check(ref?: FileRef, options?: CallOptions): Promise<CheckReport>;
  test(options?: CallOptions): Promise<CheckReport>;
  pick(
    selection: { multiple: boolean; accept: string[] },
    options?: CallOptions,
  ): Promise<Selection<FileMetadata[]>>;
  pickDirectory(options?: CallOptions): Promise<Selection<FileMetadata>>;
  listAccesses(page: PageRequest, options?: CallOptions): Promise<Page<FileRef>>;
  restoreAccess(ref: FileRef, options?: CallOptions): Promise<FileMetadata>;
  forgetAccess(ref: FileRef, options?: CallOptions): Promise<void>;
  stat(ref: FileRef, options?: CallOptions): Promise<FileMetadata>;
  list(directory: FileRef, page: PageRequest, options?: CallOptions): Promise<Page<FileMetadata>>;
  read(
    file: FileRef,
    range: { offset: number; length: number },
    options?: CallOptions,
  ): Promise<ReadChunk>;
  create(directory: FileRef, name: string, options?: CallOptions): Promise<FileMetadata>;
  createDirectory(directory: FileRef, name: string, options?: CallOptions): Promise<FileMetadata>;
  beginWrite(
    file: FileRef,
    write: { mode: 'replace' | 'update'; expectedVersion: string | null },
    options?: CallOptions,
  ): Promise<WriteSession>;
  copy(
    ref: FileRef,
    destination: { directory: FileRef; name: string },
    options?: CallOptions,
  ): Promise<FileMetadata>;
  move(
    ref: FileRef,
    destination: { directory: FileRef; name: string },
    options?: CallOptions,
  ): Promise<FileMetadata>;
  rename(ref: FileRef, name: string, options?: CallOptions): Promise<FileMetadata>;
  remove(ref: FileRef, remove: { recursive: boolean }, options?: CallOptions): Promise<void>;
  saveAs(
    file: FileRef,
    suggestedName: string,
    options?: CallOptions,
  ): Promise<Selection<FileMetadata>>;
  export(file: FileRef, suggestedName: string, options?: CallOptions): Promise<Selection<void>>;
}

export enum CameraFacing {
  Front = 'front',
  Back = 'back',
}

export enum CameraLifetime {
  View = 'view',
  Call = 'call',
}

export enum CameraEvent {
  StateChanged = 'stateChanged',
  StreamInterrupted = 'streamInterrupted',
  RecordingSaved = 'recordingSaved',
  PictureInPictureChanged = 'pictureInPictureChanged',
  Error = 'error',
}

export interface CameraState extends Versioned {
  facing: CameraFacing;
  status: 'starting' | 'streaming' | 'interrupted' | 'error' | 'released';
  recording: 'idle' | 'recording' | 'stopping';
  format: { width: number; height: number; frameRate: number } | null;
  error: DeviceFailure | null;
}

export interface CameraStreamRef {
  readonly id: string;
}

export interface CameraPreviewProps<THttp = unknown> {
  device: DeviceCore<THttp>;
  source: CameraStreamRef;
  className?: string;
  visible?: boolean;
}

// React-вход; платформа выбирается внутри компонента.

export interface CameraEvents {
  [CameraEvent.StateChanged]: CameraState;
  [CameraEvent.StreamInterrupted]: Versioned & {
    reason: 'background' | 'resourceBusy' | 'systemPressure' | 'permissionLost' | 'unknown';
  };
  [CameraEvent.RecordingSaved]: Versioned & { file: FileRef };
  [CameraEvent.PictureInPictureChanged]: Versioned & {
    status: 'inactive' | 'starting' | 'active' | 'suspended' | 'error';
  };
  [CameraEvent.Error]: Versioned & { error: DeviceFailure };
}

export interface RecordingSession {
  stop(options?: CallOptions): Promise<FileRef>;
}

export interface CameraSession extends EventSource<CameraEvents> {
  getState(options?: CallOptions): Promise<CameraState>;
  getStream(options?: CallOptions): Promise<CameraStreamRef>;
  setFacing(facing: CameraFacing, options?: CallOptions): Promise<void>;
  takePhoto(options?: CallOptions): Promise<FileRef>;
  startRecording(options?: CallOptions): Promise<RecordingSession>;
  release(): Promise<void>;
}

export interface CameraService {
  check(facing?: CameraFacing, options?: CallOptions): Promise<CheckReport>;
  test(facing: CameraFacing, options?: CallOptions): Promise<CheckReport>;
  open(
    camera: { facing: CameraFacing; lifetime?: CameraLifetime },
    options?: CallOptions,
  ): Promise<CameraSession>;
  close(options?: CallOptions): Promise<void>;
}

export enum AudioEvent {
  StateChanged = 'stateChanged',
  VolumeChanged = 'volumeChanged',
  OutputChanged = 'outputChanged',
  OutputsChanged = 'outputsChanged',
  Error = 'error',
}

export enum AudioOutputKind {
  Speaker = 'speaker',
  Receiver = 'receiver',
  WiredHeadphones = 'wiredHeadphones',
  Bluetooth = 'bluetooth',
  Usb = 'usb',
  AirPlay = 'airPlay',
  Other = 'other',
  Unknown = 'unknown',
}

export interface AudioOutput {
  id: string;
  name: string | null;
  kind: AudioOutputKind;
}

export interface AudioState extends Versioned {
  volume: { level: number | null };
  output: AudioOutput | null;
  outputs: AudioOutput[] | null;
}

export interface AudioEvents {
  [AudioEvent.StateChanged]: AudioState;
  [AudioEvent.VolumeChanged]: Versioned & { level: number | null };
  [AudioEvent.OutputChanged]: Versioned & { output: AudioOutput | null };
  [AudioEvent.OutputsChanged]: Versioned & { outputs: AudioOutput[] | null };
  [AudioEvent.Error]: Versioned & { error: DeviceFailure };
}

export interface AudioVolumeService {
  showControl(options?: CallOptions): Promise<void>;
}

export interface AudioOutputsService {
  list(options?: CallOptions): Promise<AudioOutput[] | null>;
  pick(options?: CallOptions): Promise<Selection<AudioOutput>>;
  select(outputId: string, options?: CallOptions): Promise<void>;
}

export interface AudioService extends EventSource<AudioEvents> {
  readonly volume: AudioVolumeService;
  readonly outputs: AudioOutputsService;
  getState(options?: CallOptions): Promise<AudioState>;
  check(options?: CallOptions): Promise<CheckReport>;
  test(test: { kind: 'microphone' | 'sound' }, options?: CallOptions): Promise<CheckReport>;
}

export interface SessionIdentity {
  id: string;
  login: string;
  displayName: string;
  role: 'user' | 'admin';
}

export enum SessionEvent {
  StateChanged = 'stateChanged',
}

export interface SessionState extends Versioned {
  status: 'starting' | 'anonymous' | 'authenticated' | 'error';
  identity: SessionIdentity | null;
  generation: number;
  error: DeviceFailure | null;
}

export interface SessionService<THttp> extends EventSource<{
  [SessionEvent.StateChanged]: SessionState;
}> {
  getState(options?: CallOptions): Promise<SessionState>;
  login(credentials: { login: string; password: string }, options?: CallOptions): Promise<void>;
  logout(options?: CallOptions): Promise<void>;
  run<T>(
    operation: (http: THttp, signal: AbortSignal) => Promise<T>,
    options?: CallOptions,
  ): Promise<T>;
}

export enum TransportEvent {
  StateChanged = 'stateChanged',
}

export interface TransportState extends Versioned {
  status: 'offline' | 'connecting' | 'online';
  owner: boolean;
  error: DeviceFailure | null;
}

export interface TransportService extends EventSource<{
  [TransportEvent.StateChanged]: TransportState;
}> {
  getState(options?: CallOptions): Promise<TransportState>;
}

export type DeviceCall = import('zod').infer<typeof import('../api/call').callSchema>;

export enum CallEvent {
  StateChanged = 'stateChanged',
}

export interface CallsState extends Versioned {
  call: DeviceCall | null;
  control: 'available' | 'otherWindow' | 'unavailable';
  muted: boolean;
  busy: boolean;
  audioBlocked: boolean;
  error: DeviceFailure | null;
}

export interface CallsService extends EventSource<{
  [CallEvent.StateChanged]: CallsState;
}> {
  getState(options?: CallOptions): Promise<CallsState>;
  dial(peerId: string, options?: CallOptions): Promise<void>;
  accept(options?: CallOptions): Promise<void>;
  end(options?: CallOptions): Promise<void>;
  setMuted(muted: boolean, options?: CallOptions): Promise<void>;
  activateAudio(options?: CallOptions): Promise<void>;
  takeControl(options?: CallOptions): Promise<void>;
  dismissEnded(options?: CallOptions): Promise<void>;
  clearError(): void;
}

export type NotificationIntent =
  { id: string; kind: 'dialog'; dialogId: string } | { id: string; kind: 'call'; callId: string };

export enum NotificationEvent {
  StateChanged = 'stateChanged',
  IntentReceived = 'intentReceived',
}

export interface NotificationsState extends Versioned {
  settings: DeviceState['push'];
  pendingIntent: NotificationIntent | null;
}

export interface NotificationEvents {
  [NotificationEvent.StateChanged]: NotificationsState;
  [NotificationEvent.IntentReceived]: Versioned & { intent: NotificationIntent };
}

export interface NotificationsService extends EventSource<{
  [NotificationEvent.StateChanged]: NotificationsState;
  [NotificationEvent.IntentReceived]: Versioned & { intent: NotificationIntent };
}> {
  getState(options?: CallOptions): Promise<NotificationsState>;
  enable(options?: CallOptions): Promise<void>;
  disable(options?: CallOptions): Promise<void>;
  acknowledge(id: string, options?: CallOptions): Promise<void>;
}

export enum UpdateEvent {
  StateChanged = 'stateChanged',
}

export interface UpdatesState extends Versioned {
  status: 'unsupported' | 'idle' | 'available' | 'waiting' | 'applying' | 'error';
  error: DeviceFailure | null;
}

export interface UpdatesService extends EventSource<{
  [UpdateEvent.StateChanged]: UpdatesState;
}> {
  getState(options?: CallOptions): Promise<UpdatesState>;
  apply(options?: CallOptions): Promise<{ outcome: 'scheduled' | 'deferred' }>;
}
