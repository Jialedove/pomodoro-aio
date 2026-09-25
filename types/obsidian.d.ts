declare module "obsidian" {
  export class Plugin {
    app: any;
    manifest: { id: string; dir?: string };
    constructor(...args: any[]);
    registerView(viewType: string, creator: (leaf: any) => any): any;
    addCommand(command: { id: string; name: string; callback: (event?: Event) => any }): any;
    addRibbonIcon(icon: string, title: string, callback: (event: MouseEvent) => any): any;
    addSettingTab(tab: any): any;
    loadData(): Promise<any>;
    saveData(value: any): Promise<any>;
  }

  export class Notice {
    constructor(message: any);
  }

  export class TFile {
    path: string;
    basename: string;
  }

  export function getFrontMatterInfo(content: string): {
    exists: boolean;
    frontmatter: string;
  };

  export function parseYaml(yaml: string): any;

  export function normalizePath(path: string): string;

  export class ItemView {
    app: any;
    containerEl: ObsidianElement;
    constructor(leaf: any);
  }

  export class Modal {
    app: any;
    contentEl: ObsidianElement;
    constructor(app: any);
    open(): void;
    close(): void;
  }

  export class PluginSettingTab {
    app: any;
    plugin: any;
    containerEl: ObsidianElement;
    constructor(app: any, plugin: any);
  }

  export class Setting {
    constructor(containerEl: any);
    setName(name: string): this;
    setDesc(description: string): this;
    addText(callback: (component: TextComponent) => any): this;
    addToggle(callback: (component: ToggleComponent) => any): this;
    addDropdown(callback: (component: DropdownComponent) => any): this;
  }

  export class TextComponent {
    inputEl: HTMLInputElement;
    setValue(value: string): this;
    onChange(callback: (value: string) => any): this;
  }

  export class ToggleComponent {
    setValue(value: boolean): this;
    onChange(callback: (value: boolean) => any): this;
  }

  export class DropdownComponent {
    addOptions(options: Record<string, string>): this;
    setValue(value: string): this;
    onChange(callback: (value: string) => any): this;
  }
}

interface Window {
  webkitAudioContext?: typeof AudioContext;
}

interface ObsidianElement extends HTMLElement {
  empty(): void;
  addClass(...classes: string[]): void;
  removeClass(...classes: string[]): void;
  setText(text: string): void;
  createDiv(options?: Record<string, any>): ObsidianElement;
  createSpan(options?: Record<string, any>): ObsidianElement;
  createEl<K extends keyof HTMLElementTagNameMap>(tag: K, options?: Record<string, any>): HTMLElementTagNameMap[K] & ObsidianElement;
}
