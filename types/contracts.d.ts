export type TimerStatus = "idle" | "running" | "paused" | "awaiting" | "settling" | "settlement-failed";
export type TimerStage = "focus" | "break";
export type WorkMode = "standard" | "cycle";
export type CycleSlot = 0 | 1;

export interface Settings {
  [key: string]: any;
  focusMin: number;
  breakMin: number;
  longBreakMin: number;
  longEvery: number;
  autoNext: boolean;
  dayStartHHMM: string;
  fallbackPattern: string;
  allowCreateDaily: boolean;
  fmKey: string;
  allowAutoCreateTask: boolean;
  tasksHeading: string;
  defaultTaskName: string;
  captureHeading: string;
  projectEnable: boolean;
  projectTag: string;
  projectStatusKey: string;
  projectStatusWhitelist: string;
  projectFmKey: string;
  currentProjectPath: string;
  showProjectSelector: boolean;
  dailyGoal: number;
  enableSound: boolean;
  enableNotify: boolean;
  soundWaveform: "sine" | "square" | "triangle";
  focusStartSound: string;
  breakStartSound: string;
  focusEndSound: string;
  breakEndSound: string;
  focusAlertSound: string;
  breakAlertSound: string;
  strongAlertDelaySec: number;
  strongAlertIntervalSec: number;
  longFocusDefaultMin: number;
  persistentAlertSound: boolean;
  ribbonClickAutoNext: boolean;
  focusStartCommandId: string;
  breakStartCommandId: string;
  breakBlackoutEnabled: boolean;
  workMode: WorkMode;
  cycleTaskA: string;
  cycleMinA: number;
  cycleWorkspaceCommandA: string;
  cycleTaskB: string;
  cycleMinB: number;
  cycleWorkspaceCommandB: string;
  respectModalInputFocus: boolean;
  schemaVersion?: number;
}

export interface Attention {
  type: TimerStage;
  isLong: boolean;
  cycleSlot: CycleSlot | null;
  nextStarted: boolean;
  durationMs: number;
  taskName?: string;
}

export interface FailureRecord {
  operation?: string;
  sessionId?: string | null;
  stage?: TimerStage | null;
  target?: string | null;
  step?: string | null;
  atMs?: number;
  message: string;
}

export interface Runtime {
  [key: string]: any;
  schemaVersion: number;
  status: TimerStatus;
  stage: TimerStage | null;
  mode: WorkMode;
  cycleSlot: CycleSlot;
  durationMs: number;
  startedAtMs: number;
  elapsedMs: number;
  remainingMs: number;
  pausedAtMs: number;
  sessionId: string | null;
  plannedTomatoCredit: number;
  attention: Attention | null;
  pendingSettlement: SettlementJournal | null;
  pendingBreakTransition: BreakTransition | null;
  quarantinedSettlement: Record<string, any> | null;
  projectQueue: Array<Record<string, any>>;
  frontmatterQueue: Array<Record<string, any>>;
  sessionCount: number;
  currentTaskName: string;
  longFocusMinutes: number;
  dayKey: string;
  viewWasOpen: boolean;
  failure?: FailureRecord | null;
}

export interface BreakTransition {
  schemaVersion: 1;
  status: "break-completing";
  autoNext: boolean;
  durationMs: number;
  createdAtMs: number;
}

export interface TaskMutationPlan {
  kind: "line" | "insert";
  targetIndex: number | null;
  lineBefore: string | null;
  lineAfter: string;
  heading?: string;
  beforeHash: string;
  expectedSum: number;
  eol: "\n" | "\r\n";
}

export interface DailySettlementPlan extends TaskMutationPlan {
  path: string;
  taskName: string;
  frontmatterKey: string;
  rowStatus: "pending" | "applied";
  frontmatterStatus: "pending" | "applied";
  alreadyApplied?: boolean;
  frontmatterError?: string;
}

export interface StageTransition {
  mode: WorkMode;
  durationMs: number;
  autoNext: boolean;
  isLong?: boolean;
  cycleSlot?: CycleSlot;
  taskName?: string;
}

export interface ProjectSettlementPlan {
  [key: string]: any;
  path: string;
  key: string;
  amount: number;
  status: "skipped" | "missing" | "pending" | "applied" | "conflict";
}

export interface SettlementJournal {
  [key: string]: any;
  schemaVersion: 1;
  sessionId: string;
  stage: "focus";
  durationMs: number;
  taskName: string;
  amount: number;
  manual: boolean;
  sessionCountAfter: number;
  transition: StageTransition;
  status: "prepared" | "dailyApplied" | "projectApplied" | "runtimeFinalizing" | "settled";
  createdAtMs: number;
  daily: DailySettlementPlan;
  project: ProjectSettlementPlan;
  notified?: boolean;
}

export interface RuntimeEvent {
  type: string;
  [key: string]: any;
}

export interface RuntimeTransition {
  runtime: Runtime;
  effects: string[];
}
