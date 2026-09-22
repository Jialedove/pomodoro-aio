const { Modal } = require("obsidian");

class QuickCaptureModal extends Modal {
  /** @param {any} app @param {(text:string, kind:"todo"|"idea")=>Promise<any>} onSubmit */
  constructor(app, onSubmit) {
    super(app);
    this.onSubmitCapture = onSubmit;
  }

  onOpen() {
    const content = this.contentEl;
    content.empty();
    content.addClass("pmd-capture-modal");
    content.createEl("h2", { text:"快速记录" });
    const input = content.createEl("textarea", {
      cls:"pmd-capture-modal-input",
      attr:{ rows:"3", placeholder:"记下稍后处理的想法或待办", "aria-label":"快速记录内容" }
    });
    const actions = content.createDiv({ cls:"pmd-capture-modal-actions" });
    const todoButton = actions.createEl("button", { text:"记为待办", cls:"mod-cta", attr:{ type:"button" } });
    const ideaButton = actions.createEl("button", { text:"记为想法", attr:{ type:"button" } });
    let submitting = false;
    /** @param {"todo"|"idea"} kind */
    const submit = async kind => {
      if (submitting) return;
      submitting = true;
      todoButton.disabled = true;
      ideaButton.disabled = true;
      try {
        await this.onSubmitCapture(input.value, kind);
        this.close();
      } catch {
        input.focus();
      } finally {
        submitting = false;
        todoButton.disabled = false;
        ideaButton.disabled = false;
      }
    };
    todoButton.onclick = () => submit("todo");
    ideaButton.onclick = () => submit("idea");
    input.onkeydown = event => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit("todo");
      }
    };
    window.setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = { QuickCaptureModal };
