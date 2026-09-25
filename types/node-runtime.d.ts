declare const process: { platform: string };

declare module "node:path" {
  export function resolve(...paths: string[]): string;
}

declare module "node:child_process" {
  export function spawn(command: string, args: string[], options: Record<string, any>): any;
}
