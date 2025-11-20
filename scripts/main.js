/**
 * Lockpicking Minigame - main.js
 * Foundry VTT v11
 */

const LOCKPICKING_NAMESPACE = "lockpicking-minigame";

/* --- Icon-Pfade für JPG --- */
const ARROW_ICON_PATHS = {
  ArrowUp: "modules/lockpicking-minigame/icons/arrow-up.jpg",
  ArrowDown: "modules/lockpicking-minigame/icons/arrow-down.jpg",
  ArrowLeft: "modules/lockpicking-minigame/icons/arrow-left.jpg",
  ArrowRight: "modules/lockpicking-minigame/icons/arrow-right.jpg"
};

/* -------------------------------------------------------------- */
/* Hooks                                                          */
/* -------------------------------------------------------------- */

Hooks.once("ready", () => {
  game.lockpickingMinigame = {
    openConfig() {
      if (!game.user.isGM) return ui.notifications.warn("Nur der SL kann das öffnen.");
      new LockpickingConfigApp().render(true);
    }
  };

  Hooks.on("createChatMessage", (msg) => {
    const data = msg.flags?.[LOCKPICKING_NAMESPACE];
    if (!data) return;
    if (data.userId !== game.user.id) return;

    const actor = game.actors.get(data.actorId);
    if (!actor) return;

    new LockpickingGameApp(actor, data).render(true);
  });
});

/* -------------------------------------------------------------- */
/* Hilfsfunktionen                                                */
/* -------------------------------------------------------------- */

function getThievesToolsInfo(actor) {
  const getP = foundry.utils.getProperty;
  let hasTool = false;
  let profLevel = 0;

  // Suche nach Tool-Item
  const item = actor.items.find(i =>
    i.type === "tool" &&
    (i.name.toLowerCase().includes("diebes") || i.name.toLowerCase().includes("thieves"))
  );

  if (item) {
    hasTool = true;
    const p = Number(getP(item, "system.proficient") ?? 0);
    profLevel = Math.max(profLevel, p);
  }

  // system.tools (alternative Stelle)
  const tools = getP(actor, "system.tools") ?? {};
  for (const key of Object.keys(tools)) {
    const t = tools[key];
    const label = (t.label ?? "").toLowerCase();
    if (label.includes("diebes") || label.includes("thieves")) {
      hasTool = true;
      const v = Number(t.value ?? 0);
      profLevel = Math.max(profLevel, v);
    }
  }

  let profMultiplier = 0;
  if (profLevel >= 2) profMultiplier = 2;
  else if (profLevel >= 1) profMultiplier = 1;
  else if (profLevel > 0) profMultiplier = 0.5;

  return { hasTool, profLevel, profMultiplier };
}

/* -------------------------------------------------------------- */
/*  GM-Konfiguration                                              */
/* -------------------------------------------------------------- */

class LockpickingConfigApp extends FormApplication {
  static get defaultOptions() {
    return {
      ...super.defaultOptions,
      id: "lockpicking-config",
      title: "Schlossknacken",
      template: "modules/lockpicking-minigame/templates/lock-config.hbs",
      width: 420,
      height: "auto",
      classes: ["lockpicking-config"]
    };
  }

  getData() {
    const users = game.users.contents.filter(u => u.active && !u.isGM);
    const groups = [];

    for (const user of users) {
      const actors = game.actors.contents.filter(a =>
        a.type === "character" && a.testUserPermission(user, "OWNER")
      );

      if (actors.length)
        groups.push({
          userId: user.id,
          userName: user.name,
          options: actors.map(a => ({ actorId: a.id, actorName: a.name }))
        });
    }

    return { groups, defaultDc: 15 };
  }

  async _updateObject(event, data) {
    const selection = data.selection;
    if (!selection) return ui.notifications.error("Bitte einen Charakter wählen.");

    const [actorId, userId] = selection.split("|");
    const actor = game.actors.get(actorId);
    const user = game.users.get(userId);
    const dc = Number(data.dc) || 15;

    const { hasTool, profMultiplier } = getThievesToolsInfo(actor);
    if (!hasTool) return ui.notifications.warn(`${actor.name} hat keine Diebeswerkzeuge.`);

    const dex = actor.system.abilities.dex.mod;
    const prof = actor.system.attributes.prof;

    let bonus = dex;
    let disadvantage = true;

    if (profMultiplier > 0) {
      bonus = dex + prof * profMultiplier;
      disadvantage = false;
    }

    const maxRoll = bonus + 20;
    if (maxRoll < dc)
      return ui.notifications.warn(`${actor.name} kann DC ${dc} nicht erreichen.`);

    await ChatMessage.create({
      speaker: { alias: "Lockpicking" },
      content: `Lockpicking-Minispiel für ${actor.name} gestartet (DC ${dc}, Bonus ${bonus}).`,
      flags: {
        [LOCKPICKING_NAMESPACE]: {
          action: "openGame",
          actorId,
          userId,
          dc,
          bonus,
          disadvantage
        }
      }
    });
  }
}

/* -------------------------------------------------------------- */
/* Minigame-App                                                   */
/* -------------------------------------------------------------- */

class LockpickingGameApp extends Application {
  constructor(actor, config) {
    super();
    this.actor = actor;
    this.config = config;

    this.sequence = [];
    this.currentIndex = 0;

    this.totalTimeMs = 0;
    this.remainingMs = 0;
    this.gameStarted = false;
    this.finished = false;

    this._raf = null;
    this._lastTs = null;
    this._keyHandler = this._onKeyDown.bind(this);
  }

  static get defaultOptions() {
    return {
      ...super.defaultOptions,
      id: "lockpicking-game",
      template: "modules/lockpicking-minigame/templates/lock-game.hbs",
      width: 420,
      height: "auto",
      resizable: false,
      classes: ["lockpicking-game"]
    };
  }

  getData() {
    return {
      actorName: this.actor.name,
      dc: this.config.dc,
      bonus: this.config.bonus,
      disadvantage: this.config.disadvantage
    };
  }

  /* --- Sequenz erzeugen --- */
  _generateSequence(length) {
    const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    return Array.from({ length }, () => keys[Math.floor(Math.random() * keys.length)]);
  }

  /* --- Schwierigkeit skalieren --- */
  _setupDifficulty() {
    const { dc, bonus, disadvantage } = this.config;

    const diff = Math.max(0, dc - bonus);
    let steps = Math.max(3, Math.min(8, 3 + Math.floor(dc / 4) + Math.floor(diff / 4)));

    let total = 7000 + steps * 900;
    total += bonus * 150;

    if (disadvantage) total *= 0.75;
    else total *= 1.05;

    this.sequence = this._generateSequence(steps);
    this.totalTimeMs = Math.round(total);
    this.remainingMs = this.totalTimeMs;
  }

  activateListeners(html) {
    this._html = html;

    this._timerFill = html[0].querySelector(".lp-timer-fill");
    this._sequenceContainer = html[0].querySelector(".lp-sequence-steps");
    this._currentKeyIcon = html[0].querySelector(".lp-current-key-icon-inner");
    this._statusText = html[0].querySelector(".lp-status-text");

    this._startButton = html[0].querySelector("[data-action='start-game']");
    this._cancelButton = html[0].querySelector("[data-action='cancel-game']");

    this._startButton.addEventListener("click", this._onClickStart.bind(this));
    this._cancelButton.addEventListener("click", () => this._finish(false, "Abgebrochen"));

    document.addEventListener("keydown", this._keyHandler);
  }

  close() {
    document.removeEventListener("keydown", this._keyHandler);
    if (this._raf) cancelAnimationFrame(this._raf);
    return super.close();
  }

  /* ----------------------------------------------------------- */
  /* START-BUTTON                                                */
  /* ----------------------------------------------------------- */
  _onClickStart() {
    if (this.gameStarted || this.finished) return;

    this._setupDifficulty();
    this._renderSequencePlaceholders();
    this.currentIndex = 0;
    this._updateCurrentKeyIcon();

    this.gameStarted = true;
    this.finished = false;

    this._statusText.textContent = "Minispiel läuft – drücke die angezeigten Pfeiltasten.";
    this._startButton.disabled = true;
    this._startButton.textContent = "Läuft...";

    this._raf = requestAnimationFrame(this._tick.bind(this));
  }

  /* ----------------------------------------------------------- */
  /* ICONS RENDERN                                               */
  /* ----------------------------------------------------------- */

  _renderSequencePlaceholders() {
    this._sequenceContainer.innerHTML = "";

    this.sequence.forEach((key, idx) => {
      const step = document.createElement("div");
      step.className = "lp-sequence-step lp-sequence-step--pending";
      step.dataset.index = idx;

      const icon = document.createElement("div");
      icon.className = "lp-sequence-step-icon";
      icon.dataset.key = key;

      const path = ARROW_ICON_PATHS[key];
      if (path) icon.style.backgroundImage = `url("${path}")`;

      step.appendChild(icon);
      this._sequenceContainer.appendChild(step);
    });
  }

  _updateCurrentKeyIcon() {
    const key = this.sequence[this.currentIndex];
    this._currentKeyIcon.dataset.key = key;

    const path = ARROW_ICON_PATHS[key];
    this._currentKeyIcon.style.backgroundImage = path ? `url("${path}")` : "none";
  }

  /* ----------------------------------------------------------- */
  /* TIMER                                                       */
  /* ----------------------------------------------------------- */

  _tick(ts) {
    if (!this.gameStarted || this.finished) return;

    if (!this._lastTs) this._lastTs = ts;
    const dt = ts - this._lastTs;
    this._lastTs = ts;

    this.remainingMs -= dt;
    if (this.remainingMs < 0) this.remainingMs = 0;

    const pct = this.remainingMs / this.totalTimeMs * 100;
    this._timerFill.style.width = `${pct}%`;

    if (this.remainingMs <= 0) return this._finish(false, "Zeit abgelaufen");

    this._raf = requestAnimationFrame(this._tick.bind(this));
  }

  /* ----------------------------------------------------------- */
  /* KEYDOWN                                                     */
  /* ----------------------------------------------------------- */

  _onKeyDown(ev) {
    if (!this.gameStarted || this.finished) return;

    const valid = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (!valid.includes(ev.key)) return;

    ev.preventDefault();

    const expected = this.sequence[this.currentIndex];
    if (ev.key !== expected)
      return this._finish(false, "Falsche Taste gedrückt");

    this._markStepSuccess(this.currentIndex);
    this.currentIndex++;

    if (this.currentIndex >= this.sequence.length)
      return this._finish(true, "Alle Eingaben korrekt!");

    this._updateCurrentKeyIcon();
  }

  _markStepSuccess(index) {
    const el = this._sequenceContainer.querySelector(`[data-index="${index}"]`);
    if (!el) return;

    el.classList.remove("lp-sequence-step--pending");
    el.classList.add("lp-sequence-step--success");
  }

  /* ----------------------------------------------------------- */
  /* FERTIG                                                     */
  /* ----------------------------------------------------------- */

  async _finish(success, reason) {
    this.finished = true;
    this.gameStarted = false;

    if (this._raf) cancelAnimationFrame(this._raf);

    this._statusText.textContent = success ?
      "Schloss geknackt!" :
      `Fehlschlag: ${reason}`;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content:
        `${this.actor.name} versucht ein Schloss zu knacken.<br>` +
        `Ergebnis: <b>${success ? "Erfolg" : "Misserfolg"}</b><br>` +
        `Hinweis: ${reason}`
    });

    setTimeout(() => this.close(), 1500);
  }
}
