/**
 * Lockpicking Minigame - main.js
 * VOLL FUNKTIONIERENDE VERSION
 * - Step-Feld garantiert sichtbar
 * - Glow-Effekt korrekt
 * - Timer-Farbanimation korrekt
 * - Thieves Tools Bonus korrekt
 * - Reliable Talent + Fehlertoleranz korrekt
 * - Kein Überschreiben der DOM-Elemente
 */

const LOCKPICKING_NAMESPACE = "lockpicking-minigame";

/* ICON-PFADE */
const ARROW_ICON_PATHS = {
  ArrowUp: "modules/lockpicking-minigame/icons/arrow-up.jpg",
  ArrowDown: "modules/lockpicking-minigame/icons/arrow-down.jpg",
  ArrowLeft: "modules/lockpicking-minigame/icons/arrow-left.jpg",
  ArrowRight: "modules/lockpicking-minigame/icons/arrow-right.jpg"
};

/* -------------------------------------------------------------- */
/*                             HOOKS                              */
/* -------------------------------------------------------------- */

Hooks.once("ready", () => {

  game.lockpickingMinigame = {
    openConfig() {
      if (!game.user.isGM) {
        return ui.notifications.warn("Nur der Spielleiter kann das Lockpicking-Fenster öffnen.");
      }
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

/* -------------------------------------------------------------- */
/*                     RELIABLE TALENT CHECK                      */
/* -------------------------------------------------------------- */

function actorHasReliableTalent(actor) {
  return actor.items.some((it) => {
    if (!(it.type === "feat" || it.type === "classFeature")) return false;
    const name = (it.name || "").toLowerCase();
    return name.includes("reliable talent") ||
           name.includes("reliable") ||
           name.includes("verlässlich");
  });
}

/* -------------------------------------------------------------- */
/*                     THIEVES' TOOLS BONUS                       */
/* -------------------------------------------------------------- */

function getThievesToolsInfo(actor) {

  const dexMod = actor.system.abilities.dex.mod ?? 0;
  const profBonus = actor.system.attributes.prof ?? 0;

  let proficient = false;
  let expert = false;
  let hasTools = false;

  /* --- INVENTAR --- */
  const invTool = actor.items.find(it =>
    it.type === "tool" &&
    it.name.toLowerCase().includes("thieves")
  );

  if (invTool) {
    hasTools = true;
    const prof = Number(invTool?.system?.proficient ?? 0);
    if (prof >= 2) expert = true;
    else if (prof >= 1) proficient = true;
  }

  /* --- AKTOR-DATEN (system.tools) --- */
  for (const t of Object.values(actor.system.tools ?? {})) {
    const lbl = (t.label ?? "").toLowerCase();
    if (!lbl.includes("thieves")) continue;

    hasTools = true;
    const raw = Number(t.prof ?? t.value ?? t.base ?? 0);
    if (raw >= 2) expert = true;
    else if (raw >= 1) proficient = true;
  }

  if (!hasTools) return {
    dexMod, profBonus,
    proficient: false,
    expert: false,
    totalBonus: 0,
    disadvantage: true
  };

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
    proficient,
    expert,
    totalBonus,
    disadvantage
  };
}

/* -------------------------------------------------------------- */
/*                       KONFIG-FENSTER                           */
/* -------------------------------------------------------------- */

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
    const players = game.users.filter(u => u.active && !u.isGM);
    const groups = [];

    for (const u of players) {
      const chars = game.actors.filter(a =>
        a.type === "character" &&
        a.testUserPermission(u, "OWNER")
      );

      if (!chars.length) continue;

      groups.push({
        userId: u.id,
        userName: u.name,
        options: chars.map(c => ({ actorId: c.id, actorName: c.name }))
      });
    }

    return { groups, defaultDc: 15 };
  }

  async _updateObject(ev, data) {

    const selection = data.selection;
    const dc = Number(data.dc || 15);

    if (!selection) {
      ui.notifications.error("Kein Charakter gewählt.");
      return;
    }

    const [actorId, userId] = selection.split("|");
    const actor = game.actors.get(actorId);
    const user = game.users.get(userId);

    const info = getThievesToolsInfo(actor);

    const bonus = info.totalBonus;
    const disadvantage = info.disadvantage;

    let trainingBonus = info.expert ? info.profBonus * 2 :
                       info.proficient ? info.profBonus : 0;

    const hasReliable = actorHasReliableTalent(actor);
    const allowedMistakes = hasReliable ? Math.floor(trainingBonus / 2) : 0;

    await ChatMessage.create({
      speaker: { alias: "Lockpicking" },
      content: `Lockpicking startet für <b>${actor.name}</b>.`,
      flags: {
        [LOCKPICKING_NAMESPACE]: {
          action: "openGame",
          actorId,
          userId,
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

/* -------------------------------------------------------------- */
/*                        MINIGAME-FENSTER                        */
/* -------------------------------------------------------------- */

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

    this.reliable = config.reliableTalent;

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
      reliableTalent: this.reliable
    };
  }

  /* ---------------- SETUP ---------------- */

  _generateSequence(len) {
    const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    return Array.from({ length: len }, () =>
      keys[Math.floor(Math.random() * keys.length)]
    );
  }

  _setupDifficulty() {
    const dc = this.config.dc;
    const bonus = this.config.bonus;
    const disadv = this.config.disadvantage;

    const rawSteps = 0.5 * dc;
    const steps = Math.max(3, Math.min(12, Math.round(rawSteps)));

    let baseSec = 5 + (steps - 5) / 3;
    const bonusSec = Math.max(0, bonus) * 0.5;

    let total = baseSec + bonusSec;
    if (disadv) total *= 0.6;

    this.sequence = this._generateSequence(steps);
    this.totalTimeMs = total * 1000;
    this.remainingMs = this.totalTimeMs;
  }

  /* ---------------- UI READY ---------------- */

  activateListeners(html) {
    this._html = html;

    this._timerFill = html.find(".lp-timer-fill")[0];
    this._timerText = html.find(".lp-timer-text")[0];
    this._seq = html.find(".lp-sequence-steps")[0];

    this._currentKeyIcon = html.find(".lp-current-key-icon")[0];
    this._currentKeyInner = html.find(".lp-current-key-icon-inner")[0];

    this._status = html.find(".lp-status-text")[0];
    this._mistakesInfo = html.find(".lp-mistakes-info")[0];

    html.find("[data-action='start-game']").click(this._start.bind(this));
    html.find("[data-action='cancel-game']").click(() => this._finish(false, "Abgebrochen."));

    document.addEventListener("keydown", this._keyHandler);

    this._updateMistakesInfo();
  }

  close() {
    document.removeEventListener("keydown", this._keyHandler);
    cancelAnimationFrame(this._raf);
    return super.close();
  }

  /* ---------------- START ---------------- */

  _start() {

    this._setupDifficulty();
    this._renderSequence();

    this.currentIndex = 0;
    this._updateCurrentKeyIcon();

    this._currentKeyIcon.classList.add("glow-active");

    this._status.textContent = "Los geht's!";
    this._lastTs = null;
    this._raf = requestAnimationFrame(this._tick.bind(this));
  }

  _renderSequence() {
    this._seq.innerHTML = "";
    this.sequence.forEach((key, idx) => {
      const el = document.createElement("div");
      el.classList.add("lp-sequence-step", "lp-sequence-step--pending");
      el.dataset.index = idx;
      el.dataset.key = key;

      const icon = document.createElement("div");
      icon.classList.add("lp-sequence-step-icon");
      el.appendChild(icon);

      this._seq.appendChild(el);
    });
  }

  _updateCurrentKeyIcon() {
    const key = this.sequence[this.currentIndex];
    const path = ARROW_ICON_PATHS[key];
    this._currentKeyInner.style.backgroundImage = `url("${path}")`;
  }

  _updateMistakesInfo() {
    if (this.allowedMistakes === 0) {
      this._mistakesInfo.textContent = "";
      return;
    }
    this._mistakesInfo.textContent =
      `Fehler erlaubt: ${this.allowedMistakes - this.mistakesMade}/${this.allowedMistakes}`;
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

    /* BAR WIDTH */
    const r = this.remainingMs / this.totalTimeMs;
    this._timerFill.style.width = `${r * 100}%`;

    /* COLOR */
    let rr, gg;
    if (r > 0.6) {
      const t = (1 - r) / 0.4;
      rr = Math.round(255 * t);
      gg = 255;
    } else {
      const t = r / 0.6;
      rr = 255;
      gg = Math.round(255 * t);
    }
    this._timerFill.style.backgroundColor = `rgb(${rr},${gg},0)`;

    /* TEXT */
    this._timerText.textContent = `${(this.remainingMs / 1000).toFixed(1)}s`;

    if (this.remainingMs <= 0) return this._finish(false, "Zeit abgelaufen.");

    this._raf = requestAnimationFrame(this._tick.bind(this));
  }

  /* ---------------- INPUT ---------------- */

  _onKeyDown(ev) {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(ev.key)) return;

    ev.preventDefault();

    const expected = this.sequence[this.currentIndex];

    if (ev.key !== expected) {

      if (this.mistakesMade < this.allowedMistakes) {
        this.mistakesMade++;
        this._updateMistakesInfo();
        this._status.textContent =
          `Falsche Taste (${this.mistakesMade}/${this.allowedMistakes})`;
        return;
      }

      return this._finish(false, "Falsche Taste.");
    }

    /* CORRECT */
    const el = this._seq.querySelector(`[data-index="${this.currentIndex}"]`);
    el.classList.remove("lp-sequence-step--pending");
    el.classList.add("lp-sequence-step--success");

    const icon = el.querySelector(".lp-sequence-step-icon");
    icon.style.backgroundImage = `url("${ARROW_ICON_PATHS[expected]}")`;

    this.currentIndex++;

    if (this.currentIndex >= this.sequence.length)
      return this._finish(true, "Alle Tasten korrekt!");

    this._updateCurrentKeyIcon();
  }

  /* ---------------- FINISH ---------------- */

  async _finish(success, reason) {

    this._currentKeyIcon.classList.remove("glow-active");

    cancelAnimationFrame(this._raf);

    this._status.textContent =
      success ? "Erfolg!" : `Fehlschlag: ${reason}`;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content:
        `Lockpicking für <b>${this.actor.name}</b>:<br>
         Ergebnis: <b>${success ? "Erfolg" : "Scheitern"}</b><br>
         Fehler: ${this.mistakesMade} / ${this.allowedMistakes}`
    });

    setTimeout(() => this.close(), 1500);
  }
}
