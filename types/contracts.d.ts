export type TimerStatus = "idle" | "running" | "paused" | "awaiting" | "settling" | "settlement-failed";
export type TimerStage = "focus" | "break";
export type ModuleType = "work" | "rest";
export interface ModuleDefinition {
  id: string;
  type: ModuleType;
  name: string;
  durationMin: number;
  blackout: boolean;
  workspaceCommandId?: string;
}
export interface ModuleRun {
  runId: string;
  moduleId: string;
  type: ModuleType;
  name: string;
  durationMin: number;
  durationMs: number;
  blackout: boolean;
  workspaceCommandId: string | null;
  projectPath: string | null;
  startedAtMs: number;
  recoveryOnly?: boolean;
}

export interface Settings {
  [key: string]: any;
  dayStartHHMM: string;
  fallbackPattern: string;
  allowCreateDaily: boolean;
  fmKey: string;
  allowAutoCreateTask: boolean;
  tasksHeading: string;
  captureHeading: string;
  capturePathPattern: string;
  projectTag: string;
  projectStatusKey: string;
  projectStatusWhitelist: string;
  projectFmKey: string;
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
  persistentAlertSound: boolean;
  ribbonClickAutoNext: boolean;
  modules: ModuleDefinition[];
  restPresets: string[];
  projectAssignments: Record<string, string>;
  loopMode: "infinite" | "once" | "count";
  loopCount: number;
  autoAdvance: boolean;
  enableProjects: boolean;
  respectModalInputFocus: boolean;
  schemaVersion?: number;
}
export interface Attention {
  type: TimerStage;
  nextStarted: boolean;
  durationMs: number;
  moduleIndex?: number;
  moduleRun?: ModuleRun;
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
  mode: "modules";
  moduleRun?: ModuleRun | null;
  currentModuleIndex?: number;
  selectedModuleId?: string | null;
  completedWorkCount?: number;
  completedRestCount?: number;
  completedLoopCount?: number;
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
  mode: "modules";
  moduleIndex?: number | null;
  moduleRun?: ModuleRun | null;
  completedRestCountAfter?: number;
  completedWorkCountAfter?: number;
  completionType?: ModuleType;
  sessionCountAfter?: number;
  completedLoopCountAfter?: number;
}

export interface TaskMutationPlan {
  kind: "line" | "insert" | "complete";
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
  mode: "modules";
  durationMs: number;
  autoNext: boolean;
  moduleIndex?: number | null;
  moduleRun?: ModuleRun | null;
  completedWorkCountAfter?: number;
  completedRestCountAfter?: number;
  completedLoopCountAfter?: number;
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
