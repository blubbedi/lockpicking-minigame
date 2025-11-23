/**
 * Lockpicking Minigame - main.js
 * Features:
 * - Minigame Logic (Pfeiltasten, Zeitlimit)
 * - Tidy5e & Default Sheet Support (Button Injection)
 * - Socket Sync für GM/Spectator Mode
 * - Reliable Talent / Expertise Support
 */

const LOCKPICKING_NAMESPACE = "lockpicking-minigame";

const ARROW_ICON_PATHS = {
  ArrowUp: "modules/lockpicking-minigame/icons/arrow-up.png",
  ArrowDown: "modules/lockpicking-minigame/icons/arrow-down.png",
  ArrowLeft: "modules/lockpicking-minigame/icons/arrow-left.png",
  ArrowRight: "modules/lockpicking-minigame/icons/arrow-right.png"
};

const PICK_ICON_PATHS = {
  ArrowUp: "modules/lockpicking-minigame/icons/lockpick-up.png",
  ArrowDown: "modules/lockpicking-minigame/icons/lockpick-down.png",
  ArrowLeft: "modules/lockpicking-minigame/icons/lockpick-left.png",
  ArrowRight: "modules/lockpicking-minigame/icons/lockpick-right.png"
};

/* ---------------- Registry ---------------- */

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

/* ---------------- Hooks ---------------- */

Hooks.once("ready", () => {
  console.log(`${LOCKPICKING_NAMESPACE} | Ready`);

  // API für Makros (falls benötigt)
  game.lockpickingMinigame = {
    openConfig() {
      if (!game.user.isGM)
        return ui.notifications.warn("Nur der Spielleiter kann dieses Fenster öffnen.");
      new LockpickingConfigApp().render(true);
    }
  };

  // Chat Message Listener (Start Game Button)
  Hooks.on("createChatMessage", (msg) => {
    const data = msg.flags?.[LOCKPICKING_NAMESPACE];
    if (!data) return;
    if (data.action !== "openGame") return;

    const actor = game.actors.get(data.actorId);
    if (!actor) return;

    const isTarget = game.user.id === data.userId;
    const isSpectator = !isTarget;

    new LockpickingGameApp(actor, data, { spectator: isSpectator }).render(true);
  });

  // Socket Listener (Game Sync & Requests)
  game.socket.on(`module.${LOCKPICKING_NAMESPACE}`, (payload) => {
    if (!payload) return;

    // CASE 1: Request vom Spieler
    if (payload.action === "requestConfig") {
      if (!game.user.isGM) return; // Nur GM reagiert

      // Info an GM
      const user = game.users.get(payload.userId);
      const actor = game.actors.get(payload.actorId);
      ui.notifications.info(`${user?.name} möchte ein Schloss knacken (${actor?.name}).`);

      // Config öffnen und Actor vorauswählen
      new LockpickingConfigApp(payload.actorId).render(true);
      return;
    }

    // CASE 2: Minigame Events
    if (!payload.runId) return;
    const app = LockpickingRegistry.get(payload.runId);
    if (!app) return;
    app._onSocketEvent(payload);
  });
});

/* -------------------------------------------------------
 * HOOK: Button Injection (Main Page + Inventory)
 * Deckt Standard 5e Sheets und Tidy5e ab.
 * ------------------------------------------------------- */
Hooks.on("renderActorSheet", (app, html, data) => {
  // Sicherheitscheck: Haben wir einen Actor und ist der User der Owner?
  if (!app.actor || !app.actor.isOwner) return;

  // Hilfsfunktion: Button erstellen
  const createBtn = () => {
    const btn = $(`<a class="lockpicking-trigger" title="Schloss knacken anfragen">
      <i class="fas fa-lock"></i>
    </a>`);

    btn.click((ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      ui.notifications.info("Anfrage an Spielleiter gesendet...");
      game.socket.emit(`module.${LOCKPICKING_NAMESPACE}`, {
        action: "requestConfig",
        actorId: app.actor.id,
        userId: game.user.id
      });
    });
    return btn;
  };

  // --- STRATEGIE 1: Inventar (Items) ---
  // Findet Items im Inventar-Tab über die ID
  const items = html.find("[data-item-id]");
  items.each((i, el) => {
    const li = $(el);
    const itemId = li.attr("data-item-id");
    const item = app.actor.items.get(itemId);

    if (!item) return;

    const name = item.name.toLowerCase();
    // Prüfen auf Diebeswerkzeug
    if (item.type === "tool" && (name.includes("thieves") || name.includes("diebes"))) {
      
      if (li.find(".lockpicking-trigger").length > 0) return; // Dopplungen vermeiden

      const btn = createBtn();
      const controls = li.find(".item-controls");
      
      if (controls.length) {
        controls.prepend(btn);
      } else {
        li.find(".item-name").append(btn);
      }
    }
  });

  // --- STRATEGIE 2: Tidy5e Dashboard (Tools Section) ---
  // Findet die "Thieves' Tools" Zeile auf der Hauptseite
  // Wir suchen nach Zeilen mit data-key="thief" oder Klassen .tool-row
  const toolsList = html.find("[data-key='thief'], .tool-row, .proficiency-row");
  
  toolsList.each((i, el) => {
    const row = $(el);
    // Text prüfen, falls data-key fehlt
    const text = row.text().toLowerCase();
    const matchesName = text.includes("thieves") || text.includes("diebes");
    const matchesKey = row.attr("data-key") === "thief";

    if (matchesKey || matchesName) {
      
      if (row.find(".lockpicking-trigger").length > 0) return; // Dopplungen vermeiden

      const btn = createBtn();
      
      // Platzierung: Links neben dem Würfel-Button (falls vorhanden)
      const rollBtn = row.find("[data-action='roll']");
      const nameLabel = row.find(".tool-name, .skill-name-label");

      if (rollBtn.length) {
        rollBtn.before(btn);
        btn.css("margin-right", "5px"); // Kleiner Abstand zum Würfel
      } else if (nameLabel.length) {
        nameLabel.after(btn);
      } else {
        row.append(btn);
      }
    }
  });
});


/* ---------------- Helper Functions ---------------- */

function actorHasReliableTalent(actor) {
  return actor.items.some((it) => {
    if (!(it.type === "feat" || it.type === "classFeature")) return false;
    const n = (it.name || "").toLowerCase();
    return n.includes("reliable talent") || n.includes("verlässlich");
  });
}

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

  // Check Inventory
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
    } else if (pRaw) { // boolean true
      itemProfLevel = 1;
    }
    if (itemProfLevel >= 2) expert = true;
    else if (itemProfLevel >= 1) proficient = true;
  }

  // Check System Tools (Proficiencies)
  const toolsData = getProp(actor, "system.tools") ?? {};
  for (const [key, data] of Object.entries(toolsData)) {
    const keyName = String(key ?? "").toLowerCase();
    const label = String(data.label ?? "").toLowerCase();

    const looksLikeThievesTool =
      keyName.includes("thief") || keyName.includes("dieb") ||
      label.includes("thief") || label.includes("diebes");

    if (!looksLikeThievesTool) continue;

    hasToolsEntry = true;

    const candidates = ["prof", "proficient", "value", "base"];
    let best = 0;
    for (const prop of candidates) {
      const raw = data[prop];
      if (raw === undefined || raw === null) continue;
      if (typeof raw === "number" && !Number.isNaN(raw)) best = Math.max(best, raw);
      else if (raw) best = Math.max(best, 1);
    }
    toolsProfLevel = Math.max(toolsProfLevel, best);
  }

  if (toolsProfLevel >= 2) expert = true;
  else if (toolsProfLevel >= 1) proficient = true;

  const hasAnyTool = hasToolInventory || hasToolsEntry;

  if (!hasAnyTool) {
    return {
      dexMod, profBonus, hasToolInventory, hasToolsEntry,
      proficient: false, expert: false,
      totalBonus: 0, disadvantage: true,
      bonusBreakdown: { dexMod, profPart: 0, profLabel: "Keine Übung", totalBonus: 0 }
    };
  }

  let totalBonus = dexMod;
  let disadvantage = true;
  let profPart = 0;
  let profLabel = "Keine Übung";

  if (expert) {
    profPart = profBonus * 2;
    profLabel = "Expertise";
    totalBonus = dexMod + profPart;
    disadvantage = false;
  } else if (proficient) {
    profPart = profBonus;
    profLabel = "Übung";
    totalBonus = dexMod + profPart;
    disadvantage = false;
  }

  return {
    dexMod, profBonus, hasToolInventory, hasToolsEntry,
    proficient, expert,
    totalBonus, disadvantage,
    bonusBreakdown: { dexMod, profPart, profLabel, totalBonus }
  };
}

/* ---------------- Config App ---------------- */

class LockpickingConfigApp extends FormApplication {

  constructor(preSelectedActorId = null, options = {}) {
    super(null, options);
    this.preSelectedActorId = preSelectedActorId;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-config",
      template: "modules/lockpicking-minigame/templates/lock-config.hbs",
      width: 420,
      title: "Schlossknacken Konfiguration"
    });
  }

  getData() {
    const groups = [];

    for (const user of game.users) {
      if (!user.active || user.isGM) continue;
      const chars = game.actors.filter(a =>
        a.type === "character" && a.testUserPermission(user, "OWNER")
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

  activateListeners(html) {
    super.activateListeners(html);

    // Vorauswahl im Dropdown setzen
    if (this.preSelectedActorId) {
      const actor = game.actors.get(this.preSelectedActorId);
      if (actor) {
        const ownerUser = game.users.find(u => 
          !u.isGM && u.active && actor.testUserPermission(u, "OWNER")
        );
        if (ownerUser) {
          const valueString = `${this.preSelectedActorId}|${ownerUser.id}`;
          html.find("[name='selection']").val(valueString);
        }
      }
    }
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

    const info = getThievesToolsInfo(actor);
    if (!info.hasToolInventory && !info.hasToolsEntry) {
      ui.notifications.error(`${actor.name} besitzt kein Diebeswerkzeug.`);
      return;
    }

    const bonus = info.totalBonus;
    const hasReliable = actorHasReliableTalent(actor);

    let trainingBonus = info.expert ? info.profBonus * 2 :
                       info.proficient ? info.profBonus : 0;

    let allowedMistakes = 0;
    if (hasReliable) allowedMistakes = Math.floor(trainingBonus / 2);

    const bonusBreakdown = info.bonusBreakdown;
    const reliableInfo = { hasReliable, trainingBonus, allowedMistakes };
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
          bonusBreakdown,
          reliableInfo
        }
      }
    });
  }
}

/* ---------------- Game App ---------------- */

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

    this._running = false;

    this._spectator = !!opts.spectator;

    this.runId = this.config.runId;

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
      bonusBreakdown: this.config.bonusBreakdown,
      reliableInfo: this.config.reliableInfo
    };
  }

  /* ------------- Difficulty ------------ */

  _generateSequence(len) {
    const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    return Array.from({ length: len }, () =>
      keys[Math.floor(Math.random() * keys.length)]
    );
  }

  _setupDifficulty() {
    const { dc, bonus, disadvantage } = this.config;

    let steps = Math.round(dc * 0.5);
    steps = Math.max(3, Math.min(15, steps));

    const baseSeconds = 5 + (steps - 5) / 3;
    const bonusSeconds = Math.max(0, bonus) * 0.5;

    let totalSeconds = baseSeconds + bonusSeconds;
    if (disadvantage) totalSeconds *= 0.6;

    this.sequence = this._generateSequence(steps);
    this.totalTimeMs = totalSeconds * 1000;
    this.remainingMs = this.totalTimeMs;
  }

  /* ---------------- Socket --------------- */

  _emitSocket(action, extra = {}) {
    if (this._spectator) return;
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
        const arrow = ARROW_ICON_PATHS[key];
        if (arrow) icon.style.backgroundImage = `url("${arrow}")`;
      }
    }

    this.currentIndex = index + 1;

    if (this.currentIndex >= this.sequence.length) {
      this._keyIconInner.style.backgroundImage = "";
      this._keyPick.style.backgroundImage = "";
      this._keyPick.style.opacity = "0";
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

  /* ---------------- UI init ---------------- */

  activateListeners(html) {
    this._html = html;

    this._timerFill = html.find(".lp-timer-fill")[0];
    this._timerText = html.find(".lp-timer-text")[0];
    this._seq = html.find(".lp-sequence-steps")[0];

    this._keyIconBox = html.find(".lp-current-key-icon")[0];
    this._keyIconInner = html.find(".lp-current-key-icon-inner")[0];
    this._keyPick = html.find(".lp-current-key-pick")[0];

    this._status = html.find(".lp-status-text")[0];
    this._mistakesInfo = html.find(".lp-mistakes-info")[0];

    this._startBtn = html.find("[data-action='start-game']")[0];

    if (!this._spectator) {
      html.find("[data-action='start-game']").click(this._start.bind(this));
      html.find("[data-action='cancel-game']").click(() => this._finish(false, "Abgebrochen."));
      document.addEventListener("keydown", this._keyHandler);
    } else {
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

  /* --------------- Sequence highlight ---------------- */

  _highlightCurrentStep() {
    if (!this._seq) return;

    this._seq.querySelectorAll(".lp-sequence-step--current").forEach(el =>
      el.classList.remove("lp-sequence-step--current")
    );

    const el = this._seq.querySelector(`[data-index="${this.currentIndex}"]`);
    if (el) el.classList.add("lp-sequence-step--current");
  }

  /* ---------------- PICK LOGIK ---------------- */

  _updatePickForKey(key) {
    if (!this._keyPick) return;

    if (!key || !PICK_ICON_PATHS[key]) {
      this._keyPick.style.backgroundImage = "";
      this._keyPick.style.opacity = "0";
      return;
    }

    const path = PICK_ICON_PATHS[key];
    this._keyPick.style.backgroundImage = `url("${path}")`;
    this._keyPick.style.opacity = "1";
  }

  /* --------------- Hit/Fail Animation ---------------- */

  _flashCurrentKeyIcon() {
    if (!this._keyIconBox) return;

    this._keyIconBox.classList.remove("lp-current-key-icon--hit", "lp-current-key-icon--error");
    void this._keyIconBox.offsetWidth;
    this._keyIconBox.classList.add("lp-current-key-icon--hit");
  }

  _flashErrorKeyIcon() {
    if (!this._keyIconBox) return;

    this._keyIconBox.classList.remove("lp-current-key-icon--hit", "lp-current-key-icon--error");
    void this._keyIconBox.offsetWidth;
    this._keyIconBox.classList.add("lp-current-key-icon--error");
  }

  /* ---------------- START ---------------- */

  _start() {
    if (this._spectator) return;
    if (this._running) return;
    this._running = true;

    if (this._startBtn) this._startBtn.disabled = true;

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

    this._emitSocket("start", {
      sequence: this.sequence,
      totalTimeMs: this.totalTimeMs,
      mistakesMade: this.mistakesMade
    });

    this._raf = requestAnimationFrame(this._tick.bind(this));
  }

  /* ---------------- Render Sequence ---------------- */

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

  /* ---------------- Update Icons ---------------- */

  _updateCurrentKeyIcon() {
    if (!this.sequence.length || this.currentIndex >= this.sequence.length) {
      if (this._keyIconInner) {
        this._keyIconInner.style.backgroundImage = "";
      }
      this._updatePickForKey(null);
      return;
    }

    const key = this.sequence[this.currentIndex];
    const arrowPath = ARROW_ICON_PATHS[key];

    if (this._keyIconInner && arrowPath) {
      this._keyIconInner.style.backgroundImage = `url("${arrowPath}")`;
    }

    this._updatePickForKey(key);
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

    const rStart = 76, gStart = 175, bStart = 80;   // Grün
    const rEnd = 244, gEnd = 67, bEnd = 54;         // Rot

    const r = Math.round(rStart + (rEnd - rStart) * (1 - ratio));
    const g = Math.round(gStart + (gEnd - gStart) * (1 - ratio));
    const b = Math.round(bStart + (bEnd - bStart) * (1 - ratio));

    this._timerFill.style.backgroundColor = `rgb(${r},${g},${b})`;
    this._timerFill.style.width = `${ratio * 100}%`;

    this._timerText.textContent = `${(this.remainingMs / 1000).toFixed(1)}s`;

    if (this.remainingMs <= 0) {
      if (!this._spectator) return this._finish(false, "Zeit abgelaufen");
      cancelAnimationFrame(this._raf);
      return;
    }

    this._raf = requestAnimationFrame(this._tick.bind(this));
  }

  /* ---------------- INPUT ---------------- */

  _onKeyDown(ev) {
    if (this._spectator) return;

    const valid = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (!valid.includes(ev.key)) return;

    ev.preventDefault();
    ev.stopPropagation();

    if (!this.sequence.length || this.currentIndex >= this.sequence.length) return;

    const expected = this.sequence[this.currentIndex];

    if (ev.key !== expected) {
      this._flashErrorKeyIcon();

      if (this.mistakesMade < this.allowedMistakes) {
        this.mistakesMade++;
        this._updateMistakesInfo();
        this._status.textContent =
          `Falsche Taste (${this.mistakesMade}/${this.allowedMistakes})`;

        this._emitSocket("mistake", { mistakesMade: this.mistakesMade });
        return;
      }

      this._emitSocket("mistake", { mistakesMade: this.mistakesMade + 1 });
      return this._finish(false, "Falsche Taste");
    }

    /* Richtige Taste */
    this._updatePickForKey(ev.key);
    this._flashCurrentKeyIcon();

    const el = this._seq.querySelector(`[data-index="${this.currentIndex}"]`);
    if (el) {
      el.classList.remove("lp-sequence-step--pending");
      el.classList.add("lp-sequence-step--success");

      const icon = el.querySelector(".lp-sequence-step-icon");
      if (icon) icon.style.backgroundImage = `url("${ARROW_ICON_PATHS[expected]}")`;
    }

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
    if (this._startBtn) this._startBtn.disabled = false;

    this._emitSocket("finish", {
      success,
      reason,
      mistakesMade: this.mistakesMade
    });

    /* Dietrich ausblenden */
    this._updatePickForKey(null);

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
