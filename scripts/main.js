/**
 * Lockpicking Minigame - main.js
 * Foundry VTT v11, dnd5e
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
/*                                    HOOKS                                   */
/* ========================================================================== */

Hooks.once("init", () => {
  console.log(`${LOCKPICKING_NAMESPACE} | init`);
});

Hooks.once("ready", () => {
  console.log(`${LOCKPICKING_NAMESPACE} | ready`);

  // Makro-Schnittstelle
  game.lockpickingMinigame = {
    openConfig() {
      if (!game.user.isGM) {
        return ui.notifications.warn("Nur der Spielleiter kann das Lockpicking-Konfigurationsfenster öffnen.");
      }
      new LockpickingConfigApp().render(true);
    }
  };

  // Spieler-Seite: auf ChatMessage reagieren und Minigame öffnen
  Hooks.on("createChatMessage", (message) => {
    const data = message.flags?.[LOCKPICKING_NAMESPACE];
    if (!data) return;

    if (game.user.id !== data.userId) return;

    const actor = game.actors.get(data.actorId);
    if (!actor) {
      console.warn(`${LOCKPICKING_NAMESPACE} | Actor nicht gefunden:`, data.actorId);
      return;
    }

    new LockpickingGameApp(actor, data).render(true);
  });
});

/* ========================================================================== */
/*                     HILFSFUNKTION: RELIABLE TALENT-CHECK                   */
/* ========================================================================== */

function actorHasReliableTalent(actor) {
  return actor.items.some((it) => {
    if (!(it.type === "feat" || it.type === "classFeature")) return false;
    const name = (it.name || "").toLowerCase();
    return (
      name.includes("reliable talent") ||
      name.includes("reliable") ||
      name.includes("verlässliches talent") ||
      name.includes("verlässlich")
    );
  });
}

/* ========================================================================== */
/*                 TOOL-BESITZ / ÜBUNG / BONUS / NACHTEIL                     */
/* ========================================================================== */

function getThievesToolsInfo(actor) {
  const getProp = foundry.utils.getProperty;

  const dexMod = Number(getProp(actor, "system.abilities.dex.mod") ?? 0);
  const profBonus = Number(getProp(actor, "system.attributes.prof") ?? 0);

  let hasToolInventory = false;
  let hasToolsEntry = false;
  let proficient = false;
  let expert = false;

  let itemProfLevel = 0;
  let toolsProfLevel = 0;

  const invTool = actor.items.find((it) => {
    const name = (it.name ?? "").toLowerCase();
    return it.type === "tool" && (name.includes("thieves") || name.includes("diebes"));
  });

  if (invTool) {
    hasToolInventory = true;
    const pRaw = getProp(invTool, "system.proficient");
    const pNum = Number(pRaw ?? 0);
    if (!Number.isNaN(pNum)) itemProfLevel = pNum;
    else if (typeof pRaw === "boolean" && pRaw) itemProfLevel = 1;
    else if (typeof pRaw === "string" && pRaw !== "" && pRaw !== "0") itemProfLevel = 1;

    if (itemProfLevel >= 2) expert = true;
    else if (itemProfLevel >= 1) proficient = true;
  }

  const toolsData = getProp(actor, "system.tools") ?? {};
  for (const [key, data] of Object.entries(toolsData)) {
    const keyName = String(key ?? "").toLowerCase();
    const label = String(data.label ?? "").toLowerCase();

    const looksLikeThievesTool =
      keyName.includes("thief") ||
      keyName.includes("thieves") ||
      keyName.includes("dieb") ||
      label.includes("thief") ||
      label.includes("thieves") ||
      label.includes("diebes");

    if (!looksLikeThievesTool) continue;

    hasToolsEntry = true;

    const candidates = ["prof", "proficient", "value", "base"];
    let best = 0;
    for (const prop of candidates) {
      const raw = data[prop];
      if (raw === undefined || raw === null) continue;
      if (typeof raw === "number") best = Math.max(best, raw);
      else if (typeof raw === "boolean" && raw) best = Math.max(best, 1);
      else if (typeof raw === "string" && raw !== "" && raw !== "0") best = Math.max(best, 1);
    }

    toolsProfLevel = Math.max(toolsProfLevel, best);
  }

  if (toolsProfLevel >= 2) expert = true;
  else if (toolsProfLevel >= 1) proficient = true;

  const hasAnyTool = hasToolInventory || hasToolsEntry;

  if (!hasAnyTool) {
    return {
      dexMod,
      profBonus,
      hasToolInventory,
      hasToolsEntry,
      proficient: false,
      expert: false,
      totalBonus: 0,
      disadvantage: true
    };
  }

  let totalBonus = dexMod;
  let disadvantage = true;

  if (expert) {
    totalBonus = dexMod + profBonus * 2;
    disadvantage = false;
  } else if (proficient) {
    totalBonus = dexMod + profBonus;
    disadvantage = false;
  }

  return {
    dexMod,
    profBonus,
    hasToolInventory,
    hasToolsEntry,
    proficient,
    expert,
    totalBonus,
    disadvantage
  };
}

/* ========================================================================== */
/*                         GM-KONFIGURATION (FormApplication)                 */
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
    const activeUsers = game.users.contents.filter((u) => u.active && !u.isGM);
    const groups = [];

    for (const user of activeUsers) {
      const ownedActors = game.actors.contents.filter(
        (a) => a.type === "character" && a.testUserPermission(user, "OWNER")
      );

      if (!ownedActors.length) continue;

      groups.push({
        userId: user.id,
        userName: user.name,
        options: ownedActors.map((a) => ({
          actorId: a.id,
          actorName: a.name
        }))
      });
    }

    return { groups, defaultDc: 15 };
  }

  async _updateObject(event, formData) {
    const selection = formData.selection;
    const dc = Number(formData.dc) || 15;

    if (!selection) {
      ui.notifications.error("Bitte einen Charakter auswählen.");
      return;
    }

    const [actorId, userId] = selection.split("|");
    const user = game.users.get(userId);
    const actor = game.actors.get(actorId);

    if (!user || !actor) {
      ui.notifications.error("Fehlerhafte Auswahl.");
      return;
    }

    const info = getThievesToolsInfo(actor);

    if (!info.hasToolInventory && !info.hasToolsEntry) {
      ui.notifications.warn(`${actor.name} besitzt keine Diebeswerkzeuge.`);
      return;
    }

    const bonus = info.totalBonus;
    const disadvantage = info.disadvantage;

    let trainingBonus = 0;
    if (info.expert) trainingBonus = info.profBonus * 2;
    else if (info.proficient) trainingBonus = info.profBonus;

    const hasReliable = actorHasReliableTalent(actor);

    let allowedMistakes = 0;
    if (hasReliable) {
      allowedMistakes = Math.max(0, Math.floor(trainingBonus / 2));
    }

    const maxRoll = bonus + 20;
    if (maxRoll < dc) {
      ui.notifications.warn(`${actor.name} kann selbst mit einer 20 den DC nicht schaffen.`);
      return;
    }

    await ChatMessage.create({
      content: `Lockpicking-Minispiel für <b>${actor.name}</b> gestartet.`,
      speaker: { alias: "Lockpicking" },
      flags: {
        [LOCKPICKING_NAMESPACE]: {
          action: "openGame",
          userId,
          actorId,
          dc,
          bonus,
          disadvantage,
          allowedMistakes,
          reliableTalent: hasReliable
        }
      }
    });
  }
}

/* ========================================================================== */
/*                           MINIGAME-FENSTER (Application)                   */
/* ========================================================================== */

class LockpickingGameApp extends Application {
  constructor(actor, config, options = {}) {
    super(options);
    this.actor = actor;
    this.config = config;

    this.sequence = [];
    this.currentIndex = 0;
    this.totalTimeMs = 0;
    this.remainingMs = 0;
    this.gameStarted = false;
    this.finished = false;

    this.allowedMistakes = Number(config.allowedMistakes ?? 0);
    this.mistakesMade = 0;
    this.reliableTalent = Boolean(config.reliableTalent);

    this._raf = null;
    this._lastTs = null;
    this._keyHandler = this._onKeyDown.bind(this);
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-game",
      classes: ["lockpicking-game"],
      title: "Schlossknacken",
      template: "modules/lockpicking-minigame/templates/lock-game.hbs",
      width: 420,
      height: "auto",
      resizable: false
    });
  }

  getData() {
    const { dc, bonus, disadvantage } = this.config;

    return {
      actorName: this.actor.name,
      dc,
      bonus,
      disadvantage,
      allowedMistakes: this.allowedMistakes,
      reliableTalent: this.reliableTalent
    };
  }

  /* --------------------------- Sequenz / Difficulty ----------------------- */

  _generateSequence(length) {
    const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    return Array.from({ length }, () => keys[Math.floor(Math.random() * keys.length)]);
  }

  _setupDifficulty() {
    const { dc, bonus, disadvantage } = this.config;

    const rawSteps = 0.5 * dc;
    let steps = Math.round(rawSteps);
    steps = Math.max(3, Math.min(12, steps));

    let baseSeconds = 5 + (steps - 5) / 3;

    const effectiveBonus = Math.max(0, Number(bonus || 0));
    const bonusSeconds = effectiveBonus * 0.5;

    let totalSeconds = baseSeconds + bonusSeconds;

    if (disadvantage) totalSeconds *= 0.6;

    this.sequence = this._generateSequence(steps);
    this.totalTimeMs = Math.round(totalSeconds * 1000);
    this.remainingMs = this.totalTimeMs;
  }

  /* --------------------------- Listener / UI ------------------------------ */

  activateListeners(html) {
    super.activateListeners(html);

    this._html = html;
    this._timerFill = html.find(".lp-timer-fill")[0];
    this._timerText = html.find(".lp-timer-text")[0];
    this._sequenceContainer = html.find(".lp-sequence-steps")[0];
    this._currentKeyIcon = html.find(".lp-current-key-icon")[0];
    this._currentKeyIconInner = html.find(".lp-current-key-icon-inner")[0];
    this._statusText = html.find(".lp-status-text")[0];
    this._startButton = html.find('[data-action="start-game"]')[0];
    this._cancelButton = html.find('[data-action="cancel-game"]')[0];
    this._mistakesInfo = html.find(".lp-mistakes-info")[0];

    if (this.config.disadvantage) html[0].classList.add("disadvantage-active");
    else html[0].classList.add("no-disadvantage");

    if (this._startButton)
      this._startButton.addEventListener("click", this._onClickStart.bind(this));

    if (this._cancelButton)
      this._cancelButton.addEventListener("click", () => this._finish(false, "Abgebrochen."));

    document.addEventListener("keydown", this._keyHandler);

    this._updateMistakesInfo();
  }

  close(options) {
    document.removeEventListener("keydown", this._keyHandler);
    if (this._raf) cancelAnimationFrame(this._raf);
    return super.close(options);
  }

  /* ------------------------------ Start-Button ---------------------------- */

  _onClickStart(event) {
    event.preventDefault();
    if (this.gameStarted || this.finished) return;

    this._setupDifficulty();
    this._renderSequencePlaceholders();
    this.currentIndex = 0;
    this._updateCurrentKeyIcon();

    if (this._currentKeyIcon) this._currentKeyIcon.classList.add("glow-active");

    this.gameStarted = true;
    this.finished = false;
    this._lastTs = null;

    if (this._statusText)
      this._statusText.textContent = "Minispiel läuft – drücke die angezeigten Pfeiltasten.";

    if (this._startButton) {
      this._startButton.disabled = true;
      this._startButton.textContent = "Läuft...";
    }

    this._raf = requestAnimationFrame(this._tick.bind(this));
  }

  /* --------- Platzhalter (ohne Icons, Icons erst bei Erfolg) ------------- */

  _renderSequencePlaceholders() {
    if (!this._sequenceContainer) return;
    this._sequenceContainer.innerHTML = "";

    this.sequence.forEach((key, index) => {
      const step = document.createElement("div");
      step.classList.add("lp-sequence-step", "lp-sequence-step--pending");
      step.dataset.index = String(index);
      step.dataset.key = key;

      const icon = document.createElement("div");
      icon.classList.add("lp-sequence-step-icon");

      step.appendChild(icon);
      this._sequenceContainer.appendChild(step);
    });
  }

  _updateCurrentKeyIcon() {
    const key = this.sequence[this.currentIndex];
    const path = ARROW_ICON_PATHS[key];
    if (this._currentKeyIconInner)
      this._currentKeyIconInner.style.backgroundImage = path ? `url("${path}")` : "none";
  }

  _updateMistakesInfo() {
    if (!this._mistakesInfo) return;

    if (this.allowedMistakes <= 0) {
      this._mistakesInfo.textContent = "";
      return;
    }

    const remaining = Math.max(0, this.allowedMistakes - this.mistakesMade);
    this._mistakesInfo.textContent = `Fehler erlaubt: ${remaining}/${this.allowedMistakes}`;
  }

  /* ------------------------------- Timer-Tick ----------------------------- */

  _tick(ts) {
    if (!this.gameStarted || this.finished) return;

    if (this._lastTs === null) {
      this._lastTs = ts;
    } else {
      const dt = ts - this._lastTs;
      this._lastTs = ts;
      this.remainingMs -= dt;
      if (this.remainingMs < 0) this.remainingMs = 0;
    }

    const ratio = this.totalTimeMs > 0 ? this.remainingMs / this.totalTimeMs : 0;

    if (this._timerFill) {
      this._timerFill.style.width = `${ratio * 100}%`;

      let r, g;
      if (ratio > 0.6) {
        const t = (1 - ratio) / 0.4;
        r = Math.round(255 * t);
        g = 255;
      } else {
        const t = ratio / 0.6;
        r = 255;
        g = Math.round(255 * t);
      }
      this._timerFill.style.backgroundColor = `rgb(${r}, ${g}, 0)`;
    }

    if (this._timerText) {
      const seconds = this.remainingMs / 1000;
      this._timerText.textContent = `${seconds.toFixed(1)}s`;
    }

    if (this.remainingMs <= 0) {
      this._finish(false, "Die Zeit ist abgelaufen.");
      return;
    }

    this._raf = requestAnimationFrame(this._tick.bind(this));
  }

  /* ----------------------------- Tastatureingabe -------------------------- */

  _onKeyDown(event) {
    if (!this.gameStarted || this.finished) return;

    const validKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (!validKeys.includes(event.key)) return;

    event.preventDefault();

    const expected = this.sequence[this.currentIndex];
    if (event.key !== expected) {
      if (this.mistakesMade < this.allowedMistakes) {
        this.mistakesMade++;
        this._updateMistakesInfo();
        if (this._statusText)
          this._statusText.textContent =
            `Falsche Taste (${this.mistakesMade}/${this.allowedMistakes}) – Versuch es erneut.`;
        return;
      }
      this._finish(false, "Falsche Taste gedrückt.");
      return;
    }

    this._markStepSuccess(this.currentIndex);
    this.currentIndex++;

    if (this.currentIndex >= this.sequence.length) {
      this._finish(true, "Alle Tasten korrekt gedrückt.");
    } else {
      this._updateCurrentKeyIcon();
    }
  }

  _markStepSuccess(index) {
    const el = this._sequenceContainer?.querySelector(
      `.lp-sequence-step[data-index="${index}"]`
    );
    if (!el) return;

    el.classList.remove("lp-sequence-step--pending");
    el.classList.add("lp-sequence-step--success");

    const key = el.dataset.key;
    const icon = el.querySelector(".lp-sequence-step-icon");
    const path = ARROW_ICON_PATHS[key];
    if (icon && path) icon.style.backgroundImage = `url("${path}")`;
  }

  /* --------------------------------- Finish ------------------------------- */

  async _finish(success, reason) {
    if (this.finished) return;
    this.finished = true;
    this.gameStarted = false;

    if (this._currentKeyIcon) this._currentKeyIcon.classList.remove("glow-active");

    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;

    if (this._statusText)
      this._statusText.textContent = success ? "Schloss geknackt!" : `Fehlschlag: ${reason}`;

    const { dc, bonus, disadvantage } = this.config;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content:
        `Lockpicking-Minispiel – ${this.actor.name} versucht ein Schloss zu knacken.<br>` +
        `DC ${dc}, Bonus ${bonus}${disadvantage ? " (mit Nachteil)" : " (ohne Nachteil)"}<br>` +
        `Eingaben: ${this.sequence.length}<br>` +
        (this.allowedMistakes > 0
          ? `Fehlertoleranz (Reliable Talent): ${this.allowedMistakes}<br>`
          : "") +
        `Fehler: ${this.mistakesMade}<br>` +
        `Ergebnis: <b>${success ? "Erfolg" : "Misserfolg"}</b>`
    });

    if (this._startButton) {
      this._startButton.disabled = true;
    }

    setTimeout(() => this.close(), 1500);
  }
}
