/**
 * Lockpicking Minigame - main.js (aktuelle Vollversion)
 * Foundry VTT v11
 */

const LOCKPICKING_NAMESPACE = "lockpicking-minigame";

/* --- Icon-Pfade für JPG-Dateien --- */
const ARROW_ICON_PATHS = {
  ArrowUp: "modules/lockpicking-minigame/icons/arrow-up.jpg",
  ArrowDown: "modules/lockpicking-minigame/icons/arrow-down.jpg",
  ArrowLeft: "modules/lockpicking-minigame/icons/arrow-left.jpg",
  ArrowRight: "modules/lockpicking-minigame/icons/arrow-right.jpg"
};

/* ========================================================================== */
/*                                   HOOKS                                    */
/* ========================================================================== */

Hooks.once("ready", () => {
  game.lockpickingMinigame = {
    openConfig() {
      if (!game.user.isGM) return ui.notifications.warn("Nur der SL kann dies öffnen.");
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

/* ========================================================================== */
/*                     TOOL-PROFICIENCY / BONUS-BERECHNUNG                    */
/* ========================================================================== */

/**
 * Ermittelt vollständige Infos zu Thieves' Tools.
 * Liefert:
 *  - hasTool        -> besitzt Diebeswerkzeuge
 *  - profLevel      -> Rohwert 0 / 0.5 / 1 / 2
 *  - profMultiplier -> 0 / 0.5 / 1 / 2 (für Berechnung)
 *  - totalBonus     -> endgültiger Bonus inkl. Ability + Profi + Bonus
 *  - disadvantage   -> true = Nachteil, false = nicht
 */
function getThievesToolsInfo(actor) {
  const getProp = foundry.utils.getProperty;

  let hasTool = false;
  let profLevel = 0;
  let profMultiplier = 0;
  let totalBonus = 0;
  let disadvantage = true;

  const profBonus = Number(getProp(actor, "system.attributes.prof") ?? 0);

  /* --- 1) Primär: system.tools durchsuchen --- */
  const tools = getProp(actor, "system.tools") ?? {};

  for (const [key, data] of Object.entries(tools)) {
    const label = (data.label ?? "").toLowerCase();
    if (!label) continue;

    if (label.includes("thieves") || label.includes("diebes")) {
      hasTool = true;

      const abilityKey = data.ability || "dex";
      const abilityMod = Number(getProp(actor, `system.abilities.${abilityKey}.mod`) ?? 0);

      const rawProf = Number(data.prof ?? data.proficient ?? data.value ?? 0);
      profLevel = Math.max(profLevel, rawProf);

      let mult = 0;
      if (rawProf >= 2) mult = 2;
      else if (rawProf >= 1) mult = 1;
      else if (rawProf > 0) mult = 0.5;

      profMultiplier = Math.max(profMultiplier, mult);

      const miscBonus = Number(data.bonus ?? 0);
      const candidate = abilityMod + profBonus * mult + miscBonus;

      totalBonus = Math.max(totalBonus, candidate);
    }
  }

  /* --- 2) Fallback: Tool-Item durchsuchen --- */
  const item = actor.items.find(it =>
    it.type === "tool" &&
    (it.name.toLowerCase().includes("thieves") || it.name.toLowerCase().includes("diebes"))
  );

  if (item) {
    hasTool = true;

    const abilityKey = getProp(item, "system.ability") || "dex";
    const abilityMod = Number(getProp(actor, `system.abilities.${abilityKey}.mod`) ?? 0);

    const rawProf = Number(getProp(item, "system.proficient") ?? 0);
    profLevel = Math.max(profLevel, rawProf);

    let mult = 0;
    if (rawProf >= 2) mult = 2;
    else if (rawProf >= 1) mult = 1;
    else if (rawProf > 0) mult = 0.5;

    profMultiplier = Math.max(profMultiplier, mult);

    const miscBonus = Number(getProp(item, "system.bonus") ?? 0);
    const candidate = abilityMod + profBonus * mult + miscBonus;

    totalBonus = Math.max(totalBonus, candidate);
  }

  /* --- 3) Wenn kein Tool gefunden wurde --- */
  if (!hasTool) {
    return {
      hasTool: false,
      profLevel: 0,
      profMultiplier: 0,
      totalBonus: 0,
      disadvantage: true
    };
  }

  /* --- 4) Wenn totalBonus 0 ist: Dex + Prof rechnen --- */
  if (totalBonus === 0) {
    const dex = Number(getProp(actor, "system.abilities.dex.mod") ?? 0);
    totalBonus = dex + profBonus * profMultiplier;
  }

  if (profMultiplier > 0) disadvantage = false;

  return {
    hasTool,
    profLevel,
    profMultiplier,
    totalBonus,
    disadvantage
  };
}

/* ========================================================================== */
/*                        GM-KONFIGURATION (FormApplication)                  */
/* ========================================================================== */

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
        a.type === "character" &&
        a.testUserPermission(user, "OWNER")
      );

      if (actors.length) {
        groups.push({
          userId: user.id,
          userName: user.name,
          options: actors.map(a => ({ actorId: a.id, actorName: a.name }))
        });
      }
    }

    return {
      groups,
      defaultDc: 15
    };
  }

  async _updateObject(event, formData) {
    const selection = formData.selection;
    if (!selection) return ui.notifications.error("Bitte Charakter auswählen.");

    const [actorId, userId] = selection.split("|");
    const actor = game.actors.get(actorId);
    const user = game.users.get(userId);
    const dc = Number(formData.dc) || 15;

    const info = getThievesToolsInfo(actor);

    if (!info.hasTool)
      return ui.notifications.warn(`${actor.name} hat keine Diebeswerkzeuge.`);

    const bonus = info.totalBonus;
    const disadvantage = info.disadvantage;

    const maxRoll = bonus + 20;
    if (maxRoll < dc)
      return ui.notifications.warn(`${actor.name} kann DC ${dc} nicht erreichen.`);

    await ChatMessage.create({
      speaker: { alias: "Lockpicking" },
      content: `Lockpicking-Minispiel für ${actor.name} gestartet (DC ${dc}, Bonus ${bonus}${disadvantage ? ", mit Nachteil" : ", ohne Nachteil"}).`,
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

/* ========================================================================== */
/*                          DAS MINIGAME (Application)                        */
/* ========================================================================== */

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
    const { dc, bonus, disadvantage } = this.config;
    return { actorName: this.actor.name, dc, bonus, disadvantage };
  }

  /* ---------------------------------------------------------------------- */
  /* Difficulty + Sequenz erzeugen                                          */
  /* ---------------------------------------------------------------------- */

  _generateSequence(len) {
    const k = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    return Array.from({ length: len }, () => k[Math.floor(Math.random() * k.length)]);
  }

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

  /* ---------------------------------------------------------------------- */
  /* Listener                                                               */
  /* ---------------------------------------------------------------------- */

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

  /* ---------------------------------------------------------------------- */
  /* Start Button                                                            */
  /* ---------------------------------------------------------------------- */

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

  /* ---------------------------------------------------------------------- */
  /* Platzhalter – nur leere graue Felder, KEINE Icons vorher               */
  /* ---------------------------------------------------------------------- */

  _renderSequencePlaceholders() {
    if (!this._sequenceContainer) return;
    this._sequenceContainer.innerHTML = "";

    this.sequence.forEach((key, idx) => {
      const step = document.createElement("div");
      step.classList.add("lp-sequence-step", "lp-sequence-step--pending");
      step.dataset.index = idx;
      step.dataset.key = key;

      const icon = document.createElement("div");
      icon.classList.add("lp-sequence-step-icon");

      step.appendChild(icon);
      this._sequenceContainer.appendChild(step);
    });
  }

  _updateCurrentKeyIcon() {
    if (!this._currentKeyIcon) return;
    const key = this.sequence[this.currentIndex];
    const path = ARROW_ICON_PATHS[key];
    this._currentKeyIcon.style.backgroundImage = path ? `url("${path}")` : "none";
    this._currentKeyIcon.dataset.key = key;
  }

  /* ---------------------------------------------------------------------- */
  /* TICK                                                                    */
  /* ---------------------------------------------------------------------- */

  _tick(ts) {
    if (!this.gameStarted || this.finished) return;

    if (!this._lastTs) this._lastTs = ts;
    const dt = ts - this._lastTs;
    this._lastTs = ts;
    this.remainingMs -= dt;

    if (this.remainingMs < 0) this.remainingMs = 0;

    const pct = (this.remainingMs / this.totalTimeMs) * 100;
    this._timerFill.style.width = `${pct}%`;

    if (this.remainingMs <= 0) return this._finish(false, "Zeit abgelaufen");

    this._raf = requestAnimationFrame(this._tick.bind(this));
  }

  /* ---------------------------------------------------------------------- */
  /* KEYDOWN                                                                 */
  /* ---------------------------------------------------------------------- */

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
      return this._finish(true, "Alles korrekt!");

    this._updateCurrentKeyIcon();
  }

  _markStepSuccess(idx) {
    const el = this._sequenceContainer.querySelector(`[data-index="${idx}"]`);
    if (!el) return;

    el.classList.remove("lp-sequence-step--pending");
    el.classList.add("lp-sequence-step--success");

    const key = el.dataset.key;
    const path = ARROW_ICON_PATHS[key];

    const icon = el.querySelector(".lp-sequence-step-icon");
    if (path) icon.style.backgroundImage = `url("${path}")`;
  }

  /* ---------------------------------------------------------------------- */
  /* FINISH                                                                  */
  /* ---------------------------------------------------------------------- */

  async _finish(success, reason) {
    this.finished = true;
    this.gameStarted = false;

    if (this._raf) cancelAnimationFrame(this._raf);

    this._statusText.textContent = success
      ? "Schloss geknackt!"
      : `Fehlschlag: ${reason}`;

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
