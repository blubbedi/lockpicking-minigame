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

    // Nur adressierter User
    if (game.user.id !== data.userId) return;

    const actor = game.actors.get(data.actorId);
    if (!actor) {
      console.warn(`${LOCKPICKING_NAMESPACE} | Actor nicht gefunden:`, data.actorId);
      return;
    }

    console.log(`${LOCKPICKING_NAMESPACE} | Öffne Minigame für`, {
      actor: actor.name,
      user: game.user.name,
      dc: data.dc,
      bonus: data.bonus,
      disadvantage: data.disadvantage
    });

    new LockpickingGameApp(actor, data).render(true);
  });
});

/* ========================================================================== */
/*                 TOOL-BESITZ / ÜBUNG / BONUS / NACHTEIL                     */
/* ========================================================================== */

/**
 * Bestimmt, ob ein Actor Thieves’ Tools besitzt, geübt ist oder Expertise hat.
 *
 * Logik:
 *  - Kein Tool       -> kein Lockpicking
 *  - Tool, keine Übung -> Lockpicking mit Nachteil, Bonus = nur DEX
 *  - Tool + Übung    -> ohne Nachteil, Bonus = DEX + Prof
 *  - Tool + Expertise-> ohne Nachteil, Bonus = DEX + 2*Prof
 *
 * Ergebnis:
 * {
 *   hasTool: bool,
 *   proficient: bool,
 *   expert: bool,
 *   totalBonus: number,
 *   disadvantage: bool
 * }
 */
function getThievesToolsInfo(actor) {
  const getProp = foundry.utils.getProperty;

  const dexMod = Number(getProp(actor, "system.abilities.dex.mod") ?? 0);
  const profBonus = Number(getProp(actor, "system.attributes.prof") ?? 0);

  let hasTool = false;
  let proficient = false;
  let expert = false;

  /* -------------------------------------------------------
   * 1) TOOL IM INVENTAR (Items)
   * ------------------------------------------------------- */

  const invTool = actor.items.find((it) => {
    const name = (it.name ?? "").toLowerCase();
    return it.type === "tool" && (name.includes("thieves") || name.includes("diebes"));
  });

  if (invTool) {
    hasTool = true;

    // dnd5e: system.proficient = 0, 0.5, 1, 2
    const p = Number(getProp(invTool, "system.proficient") ?? 0);
    if (p >= 2) expert = true;
    else if (p >= 1) proficient = true;
  }

  /* -------------------------------------------------------
   * 2) TOOL-PROFICIENCY IM ACTOR (system.tools)
   * ------------------------------------------------------- */

  const toolsData = getProp(actor, "system.tools") ?? {};
  for (const data of Object.values(toolsData)) {
    const label = (data.label ?? "").toLowerCase();
    if (!label || (!label.includes("thieves") && !label.includes("diebes"))) continue;

    hasTool = true;

    const raw = data.prof ?? data.proficient ?? data.value ?? 0;
    const val = Number(raw);

    if (!Number.isNaN(val)) {
      if (val >= 2) expert = true;
      else if (val >= 1) proficient = true;
    } else if (typeof raw === "boolean" && raw) {
      proficient = true;
    } else if (typeof raw === "string" && raw !== "" && raw !== "0") {
      proficient = true;
    }
  }

  /* -------------------------------------------------------
   * 3) KEIN TOOL → kein Lockpicking
   * ------------------------------------------------------- */

  if (!hasTool) {
    return {
      hasTool: false,
      proficient: false,
      expert: false,
      totalBonus: 0,
      disadvantage: true
    };
  }

  /* -------------------------------------------------------
   * 4) BONUS & NACHTEIL NACH DEINER REGEL
   * ------------------------------------------------------- */

  let totalBonus = dexMod;
  let disadvantage = true;

  if (expert) {
    totalBonus = dexMod + profBonus * 2;
    disadvantage = false;
  } else if (proficient) {
    totalBonus = dexMod + profBonus;
    disadvantage = false;
  } else {
    // Tool vorhanden, aber keinerlei Übung:
    totalBonus = dexMod;
    disadvantage = true;
  }

  return {
    hasTool,
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
    const opts = super.defaultOptions;
    opts.id = "lockpicking-config";
    opts.title = "Schlossknacken";
    opts.template = "modules/lockpicking-minigame/templates/lock-config.hbs";
    opts.width = 420;
    opts.height = "auto";
    opts.classes = ["lockpicking-config"];
    return opts;
  }

  getData() {
    const activeUsers = game.users.contents
      .filter((u) => u.active && !u.isGM)
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

    const groups = [];

    for (const user of activeUsers) {
      const ownedActors = game.actors.contents
        .filter(
          (a) =>
            a.type === "character" &&
            a.testUserPermission(user, "OWNER")
        )
        .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

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

    if (!groups.length) {
      ui.notifications.warn(
        "Es wurden keine Charaktere aktiver Spieler mit Besitzrechten gefunden."
      );
    }

    return {
      groups,
      defaultDc: 15
    };
  }

  async _updateObject(event, formData) {
    console.log(`${LOCKPICKING_NAMESPACE} | _updateObject:`, formData);

    try {
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
        ui.notifications.error("Ausgewählter Spieler oder Charakter wurde nicht gefunden.");
        console.warn(`${LOCKPICKING_NAMESPACE} | Auswahl fehlerhaft:`, {
          selection,
          user,
          actor
        });
        return;
      }

      // --- Tool-Infos ermitteln ---
      const info = getThievesToolsInfo(actor);

      if (!info.hasTool) {
        ui.notifications.warn(
          `${actor.name} besitzt keine Diebeswerkzeuge – Schlossknacken nicht möglich.`
        );
        console.log(`${LOCKPICKING_NAMESPACE} | Kein Diebeswerkzeug gefunden für`, actor.name);
        return;
      }

      const bonus = info.totalBonus;
      const disadvantage = info.disadvantage;

      // Check: Kann der DC überhaupt erreicht werden? (max Wurf = bonus + 20)
      const maxRoll = bonus + 20;
      if (maxRoll < dc) {
        ui.notifications.warn(
          `${actor.name} könnte selbst mit einem natürlichen 20 den DC ${dc} nicht schaffen (max. ${maxRoll}). Schlossknacken nicht sinnvoll.`
        );
        console.log(`${LOCKPICKING_NAMESPACE} | Minigame nicht gestartet – DC zu hoch`, {
          actor: actor.name,
          dc,
          bonus,
          maxRoll
        });
        return;
      }

      console.log(`${LOCKPICKING_NAMESPACE} | Berechnete Werte:`, {
        actor: actor.name,
        user: user.name,
        dc,
        bonus,
        disadvantage,
        info
      });

      const content =
        `Lockpicking-Minispiel für <b>${actor.name}</b> gestartet ` +
        `(DC ${dc}, Bonus ${bonus}${disadvantage ? ", mit Nachteil" : ", ohne Nachteil"}).`;

      await ChatMessage.create({
        content,
        speaker: { alias: "Lockpicking" },
        flags: {
          [LOCKPICKING_NAMESPACE]: {
            action: "openGame",
            userId,
            actorId,
            dc,
            bonus,
            disadvantage
          }
        }
      });

      console.log(`${LOCKPICKING_NAMESPACE} | ChatMessage mit Flags erstellt.`);
    } catch (err) {
      console.error(`${LOCKPICKING_NAMESPACE} | Fehler in _updateObject:`, err);
      ui.notifications.error("Beim Start des Lockpicking-Minispiels ist ein Fehler aufgetreten. Siehe Konsole.");
    }
  }
}

/* ========================================================================== */
/*                           MINIGAME-FENSTER (Application)                   */
/* ========================================================================== */

class LockpickingGameApp extends Application {
  constructor(actor, config, options = {}) {
    super(options);
    this.actor = actor;
    this.config = config; // { dc, bonus, disadvantage, ... }

    // QTE-Status
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
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-game",
      classes: ["lockpicking-game"],
      title: "Lockpicking",
      template: "modules/lockpicking-minigame/templates/lock-game.hbs",
      width: 420,
      height: "auto",
      resizable: false
    });
  }

  getData(options) {
    const { dc, bonus, disadvantage } = this.config;

    return {
      actorName: this.actor.name,
      dc,
      bonus,
      disadvantage
    };
  }

  /* --------------------------- Sequenz / Difficulty ----------------------- */

  _generateSequence(length) {
    const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    const seq = [];
    for (let i = 0; i < length; i++) {
      const k = keys[Math.floor(Math.random() * keys.length)];
      seq.push(k);
    }
    return seq;
  }

  _setupDifficulty() {
    const { dc, bonus, disadvantage } = this.config;

    const diff = Math.max(0, dc - bonus);
    let steps = 3 + Math.floor(dc / 4);
    steps += Math.floor(diff / 4);
    steps = Math.max(3, Math.min(8, steps));

    let totalMs = 7000 + steps * 900;
    totalMs += bonus * 150;

    if (disadvantage) totalMs *= 0.75;
    else totalMs *= 1.05;

    this.sequence = this._generateSequence(steps);
    this.totalTimeMs = Math.round(totalMs);
    this.remainingMs = this.totalTimeMs;

    console.log(`${LOCKPICKING_NAMESPACE} | QTE-Setup:`, {
      steps,
      sequence: this.sequence,
      totalTimeMs: this.totalTimeMs
    });
  }

  /* --------------------------- Listener / UI ------------------------------ */

  activateListeners(html) {
    super.activateListeners(html);

    this._html = html;
    this._timerFill = html.find(".lp-timer-fill")[0];
    this._sequenceContainer = html.find(".lp-sequence-steps")[0];
    this._currentKeyIcon = html.find(".lp-current-key-icon-inner")[0];
    this._statusText = html.find(".lp-status-text")[0];
    this._startButton = html.find('[data-action="start-game"]')[0];
    this._cancelButton = html.find('[data-action="cancel-game"]')[0];

    if (this._startButton) {
      this._startButton.addEventListener("click", this._onClickStart.bind(this));
    }
    if (this._cancelButton) {
      this._cancelButton.addEventListener("click", (ev) => {
        ev.preventDefault();
        this._finish(false, "Abgebrochen.");
      });
    }

    // Tastatur erst nach Start auswerten
    document.addEventListener("keydown", this._keyHandler);

    if (this._statusText) {
      this._statusText.textContent = "Bereit – klicke »Start«, um zu beginnen.";
    }
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

    this.gameStarted = true;
    this.finished = false;
    this._lastTs = null;

    if (this._statusText) {
      this._statusText.textContent = "Minispiel läuft – drücke die angezeigten Pfeiltasten.";
    }
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
    if (!this._currentKeyIcon) return;
    const key = this.sequence[this.currentIndex];
    const path = ARROW_ICON_PATHS[key];
    this._currentKeyIcon.dataset.key = key || "";
    this._currentKeyIcon.style.backgroundImage = path ? `url("${path}")` : "none";
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

    if (this._timerFill) {
      const pct = this.totalTimeMs > 0 ? (this.remainingMs / this.totalTimeMs) * 100 : 0;
      this._timerFill.style.width = `${pct}%`;
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
    if (!this._sequenceContainer) return;
    const el = this._sequenceContainer.querySelector(
      `.lp-sequence-step[data-index="${index}"]`
    );
    if (!el) return;

    el.classList.remove("lp-sequence-step--pending");
    el.classList.add("lp-sequence-step--success");

    const key = el.dataset.key;
    const icon = el.querySelector(".lp-sequence-step-icon");
    const path = ARROW_ICON_PATHS[key];

    if (icon && path) {
      icon.style.backgroundImage = `url("${path}")`;
    }
  }

  /* --------------------------------- Finish ------------------------------- */

  async _finish(success, reason) {
    if (this.finished) return;
    this.finished = true;
    this.gameStarted = false;

    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;

    if (this._statusText) {
      this._statusText.textContent = success
        ? "Schloss geknackt!"
        : `Fehlschlag: ${reason}`;
    }

    const { dc, bonus, disadvantage } = this.config;

    const content =
      `Lockpicking-Minispiel – ${this.actor.name} versucht ein Schloss zu knacken.<br>` +
      `DC ${dc}, Bonus ${bonus}${disadvantage ? ", mit Nachteil" : ", ohne Nachteil"}.<br>` +
      `Quick-Time-Event mit ${this.sequence.length} Eingaben (Pfeiltasten).<br>` +
      `Hinweis: ${reason}<br>` +
      `Ergebnis: <b>${success ? "Erfolg" : "Misserfolg"}</b>.`;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content
    });

    if (this._startButton) {
      this._startButton.disabled = true;
    }

    setTimeout(() => this.close(), 1500);
  }
}
