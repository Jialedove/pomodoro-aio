import type { Attention, BreakTransition, Runtime, Settings, SettlementJournal, StageTransition } from "./contracts";

export type WorkMode = "standard" | "cycle" | "modules";
export type CycleSlot = 0 | 1;
export interface LegacySettings extends Settings {
  workMode?: WorkMode;
  cycleTaskA?: string;
  cycleTaskB?: string;
  cycleMinA?: number;
  cycleMinB?: number;
  cycleBreakEvery?: number;
  longFocusDefaultMin?: number;
  focusMin?: number;
  breakMin?: number;
}
export interface LegacyAttention extends Attention {
  isLong: boolean;
  cycleSlot: CycleSlot | null;
  taskName?: string;
}
export interface BreakContinuation {
  mode: "cycle";
  cycleSlot: CycleSlot;
  taskName: string;
  durationMs: number;
}
export interface LegacyRuntime extends Omit<Runtime, "mode" | "attention" | "pendingSettlement" | "pendingBreakTransition"> {
  mode: WorkMode;
  attention: LegacyAttention | null;
  pendingSettlement: LegacySettlementJournal | null;
  pendingBreakTransition: LegacyBreakTransition | null;
  cycleSlot: CycleSlot;
  cycleRoundCount: number;
  currentTaskName: string;
  longFocusMinutes: number;
  breakContinuation: BreakContinuation | null;
}
export interface LegacyStageTransition extends Omit<StageTransition, "mode"> {
  mode: WorkMode;
  isLong?: boolean;
  cycleSlot?: CycleSlot;
  taskName?: string;
  cycleRoundCountAfter?: number;
  cycleRestDurationMs?: number;
}
export interface LegacyBreakTransition extends Omit<BreakTransition, "mode"> {
  mode?: WorkMode;
  cycleSlot?: CycleSlot;
  taskName?: string;
}
export interface LegacySettlementJournal extends Omit<SettlementJournal, "transition"> {
  transition: LegacyStageTransition;
}

export interface LegacyRuntimeTransition {
  runtime: LegacyRuntime;
  effects: string[];
}
