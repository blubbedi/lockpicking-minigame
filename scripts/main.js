/**
 * Lockpicking Minigame - main.js (stabile Version mit visueller Hervorhebung)
 * Ausgangsbasis: funktionierende Version ohne Glow/Puls/Sonderfarben
 */

const LOCKPICKING_NAMESPACE = "lockpicking-minigame";

/* Arrow Icon paths (JPG) */
const ARROW_ICON_PATHS = {
  ArrowUp: "modules/lockpicking-minigame/icons/arrow-up.jpg",
  ArrowDown: "modules/lockpicking-minigame/icons/arrow-down.jpg",
  ArrowLeft: "modules/lockpicking-minigame/icons/arrow-left.jpg",
  ArrowRight: "modules/lockpicking-minigame/icons/arrow-right.jpg"
};

/* ------------------------------------------------------------- */
/*                           HOOKS                               */
/* ------------------------------------------------------------- */

Hooks.once("ready", () => {
  console.log(`${LOCKPICKING_NAMESPACE} | Ready`);

  game.lockpickingMinigame = {
    openConfig() {
      if (!game.user.isGM)
        return ui.notifications.warn("Nur der Spielleiter kann dieses Fenster öffnen.");
      new LockpickingConfigApp().render(true);
    }
  };

  Hooks.on("createChatMessage", (msg) => {
    const data = msg.flags?.[LOCKPICKING_NAMESPACE];
    if (!data) return;
    if (game.user.id !== data.userId) return;

    const actor = game.actors.get(data.actorId);
    if (!actor) return;

    new LockpickingGameApp(actor, data).render(true);
  });
});

/* ------------------------------------------------------------- */
/*                 RELIABLE TALENT CHECK                         */
/* ------------------------------------------------------------- */

function actorHasReliableTalent(actor) {
  return actor.items.some((it) => {
    if (!(it.type === "feat" || it.type === "classFeature")) return false;
    const n = (it.name || "").toLowerCase();
    return n.includes("reliable talent") ||
           n.includes("verlässlich");
  });
}

/* ------------------------------------------------------------- */
/*                THIEVES TOOLS PROFICIENCY                      */
/* ------------------------------------------------------------- */

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

  /* -------------------------------------------------------
   * 1) TOOL IM INVENTAR (Items)
   * ------------------------------------------------------- */
  const invTool = actor.items.find((it) => {
    const name = (it.name ?? "").toLowerCase();
    return it.type === "tool" && (name.includes("thieves") || name.includes("diebes"));
  });

  if (invTool) {
    hasToolInventory = true;

    const pRaw = getProp(invTool, "system.proficient");
    const pNum = Number(pRaw ?? 0);

    if (!Number.isNaN(pNum)) {
      itemProfLevel = pNum;
    } else if (typeof pRaw === "boolean" && pRaw) {
      itemProfLevel = 1;
    } else if (typeof pRaw === "string" && pRaw !== "" && pRaw !== "0") {
      itemProfLevel = 1;
    }

    if (itemProfLevel >= 2) expert = true;
    else if (itemProfLevel >= 1) proficient = true;
  }

  /* -------------------------------------------------------
   * 2) TOOL-PROFICIENCY IM ACTOR (system.tools)
   *    z.B. actor.system.tools.thief
   * ------------------------------------------------------- */
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

      if (typeof raw === "number" && !Number.isNaN(raw)) {
        best = Math.max(best, raw);
      } else if (typeof raw === "boolean" && raw) {
        best = Math.max(best, 1);
      } else if (typeof raw === "string" && raw !== "" && raw !== "0") {
        best = Math.max(best, 1);
      }
    }

    toolsProfLevel = Math.max(toolsProfLevel, best);
  }

  // Nur echte Werte aus system.tools auswerten
  if (toolsProfLevel >= 2) {
    expert = true;
  } else if (toolsProfLevel >= 1) {
    proficient = true;
  }

  /* -------------------------------------------------------
   * 3) GESAMT-LOGIK: BONUS & NACHTEIL
   * ------------------------------------------------------- */
  const hasAnyTool = hasToolInventory || hasToolsEntry;

  if (!hasAnyTool) {
    const info = {
      dexMod,
      profBonus,
      hasToolInventory,
      hasToolsEntry,
      itemProfLevel,
      toolsProfLevel,
      proficient: false,
      expert: false,
      totalBonus: 0,
      disadvantage: true
    };
    console.log(`${LOCKPICKING_NAMESPACE} | ThievesToolsInfo`, info);
    return info;
  }

  let totalBonus = dexMod;
  let disadvantage = true;

  if (expert) {
    totalBonus = dexMod + profBonus * 2;
    disadvantage = false;
  } else if (proficient) {
    totalBonus = dexMod + profBonus;
    disadvantage = false;
  } else {
    totalBonus = dexMod;
    disadvantage = true;
  }

  const info = {
    dexMod,
    profBonus,
    hasToolInventory,
    hasToolsEntry,
    itemProfLevel,
    toolsProfLevel,
    proficient,
    expert,
    totalBonus,
    disadvantage
  };

  console.log(`${LOCKPICKING_NAMESPACE} | ThievesToolsInfo`, info);
  return info;
}

/* ------------------------------------------------------------- */
/*                     CONFIG FORM                               */
/* ------------------------------------------------------------- */

class LockpickingConfigApp extends FormApplication {

  static get defaultOptions() {
    return mergeObject(super.defaultOptions, {
      id: "lockpicking-config",
      template: "modules/lockpicking-minigame/templates/lock-config.hbs",
      width: 420,
      title: "Schlossknacken"
    });
  }

  getData() {
    const groups = [];

    for (const user of game.users) {
      if (!user.active || user.isGM) continue;

      const chars = game.actors.filter(a =>
        a.type === "character" &&
        a.testUserPermission(user, "OWNER")
      );

      if (!chars.length) continue;

      groups.push({
        userId: user.id,
        userName: user.name,
        options: chars.map(c => ({ actorId: c.id, actorName: c.name }))
      });
    }

    return { groups, defaultDc: 15 };
  }

  async _updateObject(ev, data) {
    const selection = data.selection;
    const dc = Number(data.dc) || 15;

    if (!selection) {
      ui.notifications.error("Kein Charakter ausgewählt.");
      return;
    }

    const [actorId, userId] = selection.split("|");
    const actor = game.actors.get(actorId);
    const user = game.users.get(userId);

    const info = getThievesToolsInfo(actor);
    const bonus = info.totalBonus;

    const hasReliable = actorHasReliableTalent(actor);

    let trainingBonus = info.expert ? info.profBonus * 2 :
                       info.proficient ? info.profBonus : 0;

    let allowedMistakes = 0;
    if (hasReliable) allowedMistakes = Math.floor(trainingBonus / 2);

    await ChatMessage.create({
      content: `Lockpicking startet für <b>${actor.name}</b>…`,
      speaker: { alias: "Lockpicking" },
      flags: {
        [LOCKPICKING_NAMESPACE]: {
          action: "openGame",
          actorId,
          userId,
          dc,
          bonus,
          disadvantage: info.disadvantage,
          allowedMistakes,
          reliableTalent: hasReliable
        }
      }
    });
  }
}

/* ------------------------------------------------------------- */
/*                     GAME WINDOW                               */
/* ------------------------------------------------------------- */

class LockpickingGameApp extends Application {

  constructor(actor, config, opts = {}) {
    super(opts);

    this.actor = actor;
    this.config = config;

    this.sequence = [];
    this.currentIndex = 0;
    this.totalTimeMs = 0;
    this.remainingMs = 0;

    this.allowedMistakes = config.allowedMistakes ?? 0;
    this.mistakesMade = 0;

    this._lastTs = null;
    this._raf = null;
    this._keyHandler = this._onKeyDown.bind(this);
  }

  static get defaultOptions() {
    return mergeObject(super.defaultOptions, {
      id: "lockpicking-game",
      template: "modules/lockpicking-minigame/templates/lock-game.hbs",
      width: 420,
      title: "Schlossknacken"
    });
  }

  getData() {
    return {
      actorName: this.actor.name,
      dc: this.config.dc,
      bonus: this.config.bonus,
      disadvantage: this.config.disadvantage,
      allowedMistakes: this.allowedMistakes,
      reliableTalent: this.config.reliableTalent
    };
  }

  /* ---------------- Sequence Setup ---------------- */

  _generateSequence(len) {
    const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    return Array.from({ length: len }, () =>
      keys[Math.floor(Math.random() * keys.length)]
    );
  }

  _setupDifficulty() {
    const { dc, bonus, disadvantage } = this.config;

    let steps = Math.round(dc * 0.5);
    steps = Math.max(3, Math.min(12, steps));

    const baseSeconds = 5 + (steps - 5) / 3;
    const bonusSeconds = Math.max(0, bonus) * 0.5;

    let totalSeconds = baseSeconds + bonusSeconds;
    if (disadvantage) totalSeconds *= 0.6;

    this.sequence = this._generateSequence(steps);
    this.totalTimeMs = totalSeconds * 1000;
    this.remainingMs = this.totalTimeMs;
  }

  /* ---------------- LISTENERS ---------------- */

  activateListeners(html) {
    this._html = html;

    this._timerFill = html.find(".lp-timer-fill")[0];
    this._timerText = html.find(".lp-timer-text")[0];
    this._seq = html.find(".lp-sequence-steps")[0];

    this._keyIconBox = html.find(".lp-current-key-icon")[0];
    this._keyIconInner = html.find(".lp-current-key-icon-inner")[0];

    this._status = html.find(".lp-status-text")[0];
    this._mistakesInfo = html.find(".lp-mistakes-info")[0];

    html.find("[data-action='start-game']").click(this._start.bind(this));
    html.find("[data-action='cancel-game']").click(() => this._finish(false, "Abgebrochen."));

    document.addEventListener("keydown", this._keyHandler);

    this._updateMistakesInfo();
  }

  close() {
    cancelAnimationFrame(this._raf);
    document.removeEventListener("keydown", this._keyHandler);
    return super.close();
  }

  /* ---------------- HIGHLIGHT CURRENT STEP ---------------- */

  _highlightCurrentStep() {
    if (!this._seq) return;

    // alle bisherigen "current"-Marker entfernen
    this._seq.querySelectorAll(".lp-sequence-step--current").forEach(el => {
      el.classList.remove("lp-sequence-step--current");
    });

    const el = this._seq.querySelector(`[data-index="${this.currentIndex}"]`);
    if (el) el.classList.add("lp-sequence-step--current");
  }

  /* ---------------- START GAME ---------------- */

  _start() {

    this._setupDifficulty();
    this._renderSequence();

    this.currentIndex = 0;
    this.mistakesMade = 0;
    this._updateMistakesInfo();

    if (this.sequence.length > 0) {
      this._updateCurrentKeyIcon();
      this._highlightCurrentStep();
    }

    this._status.textContent = "Los geht’s!";
    this._lastTs = null;

    this._raf = requestAnimationFrame(this._tick.bind(this));
  }

  _renderSequence() {
    this._seq.innerHTML = "";
    this.sequence.forEach((key, index) => {
      const step = document.createElement("div");
      step.classList.add("lp-sequence-step", "lp-sequence-step--pending");
      step.dataset.index = index;
      step.dataset.key = key;

      const icon = document.createElement("div");
      icon.classList.add("lp-sequence-step-icon");

      step.appendChild(icon);
      this._seq.appendChild(step);
    });
  }

  _updateCurrentKeyIcon() {
    if (!this.sequence.length || this.currentIndex >= this.sequence.length) {
      // falls irgendwas schief geht, Icon leeren statt Fehler zu werfen
      this._keyIconInner.style.backgroundImage = "";
      return;
    }
    const key = this.sequence[this.currentIndex];
    const path = ARROW_ICON_PATHS[key];
    this._keyIconInner.style.backgroundImage = `url("${path}")`;
  }

  _updateMistakesInfo() {
    if (this.allowedMistakes === 0) {
      this._mistakesInfo.textContent = "";
    } else {
      const remain = this.allowedMistakes - this.mistakesMade;
      this._mistakesInfo.textContent =
        `Fehler erlaubt: ${remain}/${this.allowedMistakes}`;
    }
  }

  /* ---------------- TIMER ---------------- */

  _tick(ts) {
    if (this._lastTs === null) {
      this._lastTs = ts;
    } else {
      const dt = ts - this._lastTs;
      this._lastTs = ts;
      this.remainingMs = Math.max(0, this.remainingMs - dt);
    }

    const ratio = this.remainingMs / this.totalTimeMs;

    this._timerFill.style.width = `${ratio * 100}%`;

    this._timerText.textContent = `${(this.remainingMs / 1000).toFixed(1)}s`;

    if (this.remainingMs <= 0) return this._finish(false, "Zeit abgelaufen");

    this._raf = requestAnimationFrame(this._tick.bind(this));
  }

  /* ---------------- INPUT ---------------- */

  _onKeyDown(ev) {

    const valid = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (!valid.includes(ev.key)) return;

    ev.preventDefault();

    if (!this.sequence.length || this.currentIndex >= this.sequence.length) return;

    const expected = this.sequence[this.currentIndex];

    if (ev.key !== expected) {

      /* Fehlertoleranz */
      if (this.mistakesMade < this.allowedMistakes) {
        this.mistakesMade++;
        this._updateMistakesInfo();
        this._status.textContent =
          `Falsche Taste (${this.mistakesMade}/${this.allowedMistakes})`;
        return;
      }

      return this._finish(false, "Falsche Taste");
    }

    /* RICHTIGE Taste */
    const el = this._seq.querySelector(`[data-index="${this.currentIndex}"]`);
    if (el) {
      el.classList.remove("lp-sequence-step--pending");
      el.classList.add("lp-sequence-step--success");

      const icon = el.querySelector(".lp-sequence-step-icon");
      if (icon) {
        icon.style.backgroundImage = `url("${ARROW_ICON_PATHS[expected]}")`;
      }
    }

    this.currentIndex++;

    if (this.currentIndex >= this.sequence.length)
      return this._finish(true, "Alle Tasten korrekt.");

    this._updateCurrentKeyIcon();
    this._highlightCurrentStep();
  }

  /* ---------------- FINISH ---------------- */

  async _finish(success, reason) {

    this._status.textContent =
      success ? "Erfolg!" : `Fehlschlag: ${reason}`;

    cancelAnimationFrame(this._raf);

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content:
        `Lockpicking – <b>${this.actor.name}</b><br>` +
        `Ergebnis: <b>${success ? "Erfolg" : "Misserfolg"}</b><br>` +
        `Fehler: ${this.mistakesMade} / ${this.allowedMistakes}`
    });

    setTimeout(() => this.close(), 1500);
  }
}
