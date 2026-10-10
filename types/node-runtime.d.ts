declare const process: { platform: string };

declare module "node:path" {
  export function resolve(...paths: string[]): string;
}

declare module "node:child_process" {
  export function spawn(command: string, args: string[], options: Record<string, any>): any;
}

declare module "node:timers" {
  export function setTimeout(callback: () => void, delay: number): unknown;
  export function clearTimeout(handle: unknown): void;
  export function setInterval(callback: () => void, delay: number): unknown;
  export function clearInterval(handle: unknown): void;
}
