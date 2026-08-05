declare module "obsidian" {
  export class Plugin {
    app: any;
    registerView(viewType: string, creator: (leaf: any) => any): any;
    addCommand(command: any): any;
    addRibbonIcon(icon: string, title: string, callback: (event?: any) => any): any;
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

  export class ItemView {
    app: any;
    containerEl: any;
    constructor(leaf: any);
  }

  export class PluginSettingTab {
    app: any;
    plugin: any;
    containerEl: any;
    constructor(app: any, plugin: any);
  }

  export class Setting {
    constructor(containerEl: any);
    setName(name: string): this;
    setDesc(description: string): this;
    addText(callback: (component: any) => any): this;
    addToggle(callback: (component: any) => any): this;
    addDropdown(callback: (component: any) => any): this;
  }
}

interface Window {
  webkitAudioContext?: typeof AudioContext;
}
