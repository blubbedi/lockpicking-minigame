/**
 * Lockpicking Minigame - main.js (stabile Version mit visueller Hervorhebung + Live-Spectator)
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

/* Kleines Registry für laufende Spiele (Spectator-Zuordnung) */
class LockpickingRegistry {
  static instancesByRunId = {};

  static register(runId, app) {
    if (!runId) return;
    this.instancesByRunId[runId] = app;
  }

  static unregister(runId, app) {
    if (!runId) return;
    if (this.instancesByRunId[runId] === app) {
      delete this.instancesByRunId[runId];
    }
  }

  static get(runId) {
    return this.instancesByRunId[runId];
  }
}

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

  // ChatMessage-Flag öffnet Spiel beim Zielspieler und Spectator-Fenster bei allen anderen
  Hooks.on("createChatMessage", (msg) => {
    const data = msg.flags?.[LOCKPICKING_NAMESPACE];
    if (!data) return;
    if (data.action !== "openGame") return;

    const actor = game.actors.get(data.actorId);
    if (!actor) return;

    const isTarget = game.user.id === data.userId;
    const isSpectator = !isTarget; // alle anderen (GM + andere Spieler) sind Spectators

    new LockpickingGameApp(actor, data, { spectator: isSpectator }).render(true);
  });

  // Socket-Listener: Spectator-Instanzen spiegeln den Status
  game.socket.on(`module.${LOCKPICKING_NAMESPACE}`, (payload) => {
    if (!payload || !payload.runId) return;
    const app = LockpickingRegistry.get(payload.runId);
    if (!app) return;
    app._onSocketEvent(payload);
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

  /* 1) TOOL IM INVENTAR (Items) */
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

  /* 2) TOOL-PROFICIENCY IM ACTOR (system.tools) */
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

  if (toolsProfLevel >= 2) {
    expert = true;
  } else if (toolsProfLevel >= 1) {
    proficient = true;
  }

  /* 3) GESAMT-LOGIK: BONUS & NACHTEIL */
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
      disadvantage: true,

      // NEU: Basis-Breakdown auch im "kein Tool" Fall
      bonusBreakdown: {
        dexMod,
        profPart: 0,
        profLabel: "Keine Übung",
        totalBonus: 0
      }
    };
    console.log(`${LOCKPICKING_NAMESPACE} | ThievesToolsInfo`, info);
    return info;
  }

  let totalBonus = dexMod;
  let disadvantage = true;

  // NEU: Breakdown für Proficiency/Expertise
  let profPart = 0;
  let profLabel = "Keine Übung";

  if (expert) {
    profPart = profBonus * 2;
    profLabel = "Expertise (Thieves' Tools)";
    totalBonus = dexMod + profPart;
    disadvantage = false;
  } else if (proficient) {
    profPart = profBonus;
    profLabel = "Übung (Thieves' Tools)";
    totalBonus = dexMod + profPart;
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
    disadvantage,

    // NEU: Bonus-Zusammenfassung
    bonusBreakdown: {
      dexMod,
      profPart,
      profLabel,
      totalBonus
    }
  };

  console.log(`${LOCKPICKING_NAMESPACE} | ThievesToolsInfo`, info);
  return info;
}

/* ------------------------------------------------------------- */
/*                     CONFIG FORM                               */
/* ------------------------------------------------------------- */

class LockpickingConfigApp extends FormApplication {

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
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

    // NEU: Info-Objekte für Anzeige im Minigame
    const bonusBreakdown = info.bonusBreakdown ?? {
      dexMod: info.dexMod,
      profPart: trainingBonus,
      profLabel: info.expert
        ? "Expertise (Thieves' Tools)"
        : info.proficient
          ? "Übung (Thieves' Tools)"
          : "Keine Übung",
      totalBonus: bonus
    };

    const reliableInfo = {
      hasReliable,
      trainingBonus,
      allowedMistakes
    };

    // eindeutige Run-ID für diesen Lockpicking-Versuch
    const runId = foundry.utils.randomID();

    await ChatMessage.create({
      content: `Lockpicking startet für <b>${actor.name}</b>…`,
      speaker: { alias: "Lockpicking" },
      flags: {
        [LOCKPICKING_NAMESPACE]: {
          action: "openGame",
          runId,
          actorId,
          userId,
          dc,
          bonus,
          disadvantage: info.disadvantage,
          allowedMistakes,
          reliableTalent: hasReliable,

          // NEU: an das Game-Fenster durchreichen
          bonusBreakdown,
          reliableInfo
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

    // Flag, ob das Minigame gerade läuft
    this._running = false;
    this._startBtn = null;

    // Spectator-Modus?
    this._spectator = !!opts.spectator;

    // Run-ID aus Config
    this.runId = this.config.runId;

    // im Registry hinterlegen (für Socket-Events)
    LockpickingRegistry.register(this.runId, this);
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
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
      reliableTalent: this.config.reliableTalent,

      // NEU: Daten fürs Template
      bonusBreakdown: this.config.bonusBreakdown,
      reliableInfo: this.config.reliableInfo
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

  /* ---------------- SOCKET-HILFE ---------------- */

  _emitSocket(action, extra = {}) {
    if (this._spectator) return; // Spectators senden nichts
    if (!this.runId) return;

    const payload = {
      action,
      runId: this.runId,
      actorId: this.actor.id,
      userId: this.config.userId,
      dc: this.config.dc,
      bonus: this.config.bonus,
      disadvantage: this.config.disadvantage,
      allowedMistakes: this.allowedMistakes,
      ...extra
    };

    game.socket.emit(`module.${LOCKPICKING_NAMESPACE}`, payload);
  }

  _onSocketEvent(payload) {
    // Nur Spectator-Instanzen reagieren
    if (!this._spectator) return;
    if (payload.runId !== this.runId) return;

    switch (payload.action) {
      case "start":
        this._onSocketStart(payload);
        break;
      case "step":
        this._onSocketStep(payload);
        break;
      case "mistake":
        this._onSocketMistake(payload);
        break;
      case "finish":
        this._onSocketFinish(payload);
        break;
    }
  }

  _onSocketStart(payload) {
    // Sequenz und Zeit vom Spieler übernehmen
    this.sequence = payload.sequence ?? [];
    this.totalTimeMs = payload.totalTimeMs ?? 0;
    this.remainingMs = this.totalTimeMs;
    this.currentIndex = 0;
    this.mistakesMade = payload.mistakesMade ?? 0;

    this._renderSequence();
    this._updateMistakesInfo();

    if (this.sequence.length > 0) {
      this._updateCurrentKeyIcon();
      this._highlightCurrentStep();
    }

    this._status.textContent = "Lockpicking gestartet (Spectator).";
    this._lastTs = null;
    this._running = true;

    if (this._startBtn) this._startBtn.disabled = true;

    this._raf = requestAnimationFrame(this._tick.bind(this));
  }

  _onSocketStep(payload) {
    const index = payload.index;
    const key = payload.key;

    if (typeof index !== "number") return;
    if (!this.sequence.length) return;

    const el = this._seq.querySelector(`[data-index="${index}"]`);
    if (el) {
      el.classList.remove("lp-sequence-step--pending");
      el.classList.add("lp-sequence-step--success");

      const icon = el.querySelector(".lp-sequence-step-icon");
      if (icon) {
        const path = ARROW_ICON_PATHS[key] ?? ARROW_ICON_PATHS[this.sequence[index]];
        if (path) icon.style.backgroundImage = `url("${path}")`;
      }
    }

    this.currentIndex = index + 1;

    if (this.currentIndex >= this.sequence.length) {
      // Fertig – Finish-Event kommt gleich noch, aber wir können schon mal das Icon leeren
      this._keyIconInner.style.backgroundImage = "";
    } else {
      this._updateCurrentKeyIcon();
      this._highlightCurrentStep();
    }

    this._flashCurrentKeyIcon();
  }

  _onSocketMistake(payload) {
    this.mistakesMade = payload.mistakesMade ?? this.mistakesMade;
    this._updateMistakesInfo();
    this._status.textContent =
      `Falsche Taste (${this.mistakesMade}/${this.allowedMistakes})`;
    this._flashErrorKeyIcon();
  }

  _onSocketFinish(payload) {
    const success = !!payload.success;
    const reason = payload.reason ?? (success ? "Erfolg" : "Fehlschlag");

    this._status.textContent =
      success ? "Erfolg! (Spectator)" : `Fehlschlag: ${reason} (Spectator)`;

    cancelAnimationFrame(this._raf);
    this._running = false;
    if (this._startBtn) this._startBtn.disabled = false;

    setTimeout(() => this.close(), 1500);
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

    this._startBtn = html.find("[data-action='start-game']")[0];

    if (!this._spectator) {
      html.find("[data-action='start-game']").click(this._start.bind(this));
      html.find("[data-action='cancel-game']").click(() => this._finish(false, "Abgebrochen."));
      document.addEventListener("keydown", this._keyHandler);
    } else {
      // Spectator: keine Interaktion, Buttons deaktivieren
      if (this._startBtn) this._startBtn.disabled = true;
      html.find("[data-action='cancel-game']").click(() => this.close());
    }

    this._updateMistakesInfo();
  }

  async close() {
    cancelAnimationFrame(this._raf);
    document.removeEventListener("keydown", this._keyHandler);

    LockpickingRegistry.unregister(this.runId, this);

    return super.close();
  }

  /* ---------------- HIGHLIGHT CURRENT STEP ---------------- */

  _highlightCurrentStep() {
    if (!this._seq) return;

    this._seq.querySelectorAll(".lp-sequence-step--current").forEach(el => {
      el.classList.remove("lp-sequence-step--current");
    });

    const el = this._seq.querySelector(`[data-index="${this.currentIndex}"]`);
    if (el) el.classList.add("lp-sequence-step--current");
  }

  /* ---------------- HIT-EFFEKT FÜR KEY-ICON ---------------- */

  _flashCurrentKeyIcon() {
    if (!this._keyIconBox) return;

    this._keyIconBox.classList.remove("lp-current-key-icon--hit", "lp-current-key-icon--error");
    void this._keyIconBox.offsetWidth;
    this._keyIconBox.classList.add("lp-current-key-icon--hit");
  }

  /* ---------------- ERROR-EFFEKT FÜR KEY-ICON ---------------- */

  _flashErrorKeyIcon() {
    if (!this._keyIconBox) return;

    this._keyIconBox.classList.remove("lp-current-key-icon--hit", "lp-current-key-icon--error");
    void this._keyIconBox.offsetWidth;
    this._keyIconBox.classList.add("lp-current-key-icon--error");
  }

  /* ---------------- START GAME ---------------- */

  _start() {
    if (this._spectator) return; // nur Spieler starten
    if (this._running) return;
    this._running = true;

    if (this._startBtn) {
      this._startBtn.disabled = true;
    }

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

    // Socket: Start an Spectators senden
    this._emitSocket("start", {
      sequence: this.sequence,
      totalTimeMs: this.totalTimeMs,
      mistakesMade: this.mistakesMade
    });

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

    const ratio = this.totalTimeMs > 0 ? (this.remainingMs / this.totalTimeMs) : 0;

    this._timerFill.style.width = `${ratio * 100}%`;
    this._timerText.textContent = `${(this.remainingMs / 1000).toFixed(1)}s`;

    if (this.remainingMs <= 0) {
      if (!this._spectator) {
        return this._finish(false, "Zeit abgelaufen");
      } else {
        // Spectator wartet auf Finish-Event vom Spieler, aber Timer stoppen
        cancelAnimationFrame(this._raf);
        return;
      }
    }

    this._raf = requestAnimationFrame(this._tick.bind(this));
  }

  /* ---------------- INPUT ---------------- */

  _onKeyDown(ev) {
    if (this._spectator) return; // Spectators haben keine Eingabe

    const valid = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (!valid.includes(ev.key)) return;

    ev.preventDefault();
    ev.stopPropagation();   // verhindert Tokenbewegung in Foundry

    if (!this.sequence.length || this.currentIndex >= this.sequence.length) return;

    const expected = this.sequence[this.currentIndex];

    if (ev.key !== expected) {

      // negatives Feedback bei falscher Taste
      this._flashErrorKeyIcon();

      /* Fehlertoleranz */
      if (this.mistakesMade < this.allowedMistakes) {
        this.mistakesMade++;
        this._updateMistakesInfo();
        this._status.textContent =
          `Falsche Taste (${this.mistakesMade}/${this.allowedMistakes})`;

        // Socket: Mistake übertragen
        this._emitSocket("mistake", {
          mistakesMade: this.mistakesMade
        });

        return;
      }

      // letzter Fehler -> Misserfolg
      this._emitSocket("mistake", {
        mistakesMade: this.mistakesMade + 1
      });
      return this._finish(false, "Falsche Taste");
    }

    /* RICHTIGE Taste */
    this._flashCurrentKeyIcon(); // sichtbares Feedback auch bei gleichen Symbolen

    const el = this._seq.querySelector(`[data-index="${this.currentIndex}"]`);
    if (el) {
      el.classList.remove("lp-sequence-step--pending");
      el.classList.add("lp-sequence-step--success");

      const icon = el.querySelector(".lp-sequence-step-icon");
      if (icon) {
        icon.style.backgroundImage = `url("${ARROW_ICON_PATHS[expected]}")`;
      }
    }

    // Socket: Step übertragen (mit Index & Key, bevor wir erhöhen)
    this._emitSocket("step", {
      index: this.currentIndex,
      key: ev.key
    });

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

    this._running = false;
    if (this._startBtn) {
      this._startBtn.disabled = false;
    }

    // Socket: Finish an Spectators
    this._emitSocket("finish", {
      success,
      reason,
      mistakesMade: this.mistakesMade
    });

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
