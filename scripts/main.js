/**
 * Lockpicking Minigame - main.js
 * Foundry VTT v11/v12, dnd5e 4.x
 */

/* ----------------------------------------- */
/*  Hooks                                    */
/* ----------------------------------------- */

Hooks.once("init", () => {
  console.log("lockpicking-minigame | init");
});

Hooks.once("ready", () => {
  console.log("lockpicking-minigame | ready");

  // Namespace, damit das Makro etwas aufrufen kann:
  game.lockpickingMinigame = {
    openConfig() {
      if (!game.user.isGM) {
        ui.notifications.warn("Nur der Spielleiter kann das Lockpicking-Konfigurationsfenster öffnen.");
        return;
      }
      console.log("lockpicking-minigame | Öffne Konfig-Dialog");
      new LockpickingConfigApp().render(true);
    }
  };

  // Spieler-Seite: auf spezielle Chat-Nachrichten reagieren
  Hooks.on("createChatMessage", (message) => {
    const data = message.flags?.["lockpicking-minigame"];
    if (!data) return;

    // Nur der adressierte User öffnet das Minigame
    if (game.user.id !== data.userId) return;

    const actor = game.actors.get(data.actorId);
    if (!actor) {
      console.warn("lockpicking-minigame | Actor nicht gefunden:", data.actorId);
      return;
    }

    console.log("lockpicking-minigame | Minigame wird für User geöffnet:", {
      userId: data.userId,
      actor: actor.name,
      dc: data.dc,
      bonus: data.bonus,
      disadvantage: data.disadvantage
    });

    new LockpickingGameApp(actor, data).render(true);
  });
});

/* ----------------------------------------- */
/*  Konfigurations-Fenster (GM)              */
/* ----------------------------------------- */

class LockpickingConfigApp extends FormApplication {
  static get defaultOptions() {
    const options = super.defaultOptions;
    options.id = "lockpicking-config";
    options.title = "Schlossknacken";
    options.template = "modules/lockpicking-minigame/templates/lock-config.hbs";
    options.width = 420;
    options.height = "auto";
    options.classes = ["lockpicking-config"];
    return options;
  }

  /** Daten für das Template */
  getData(options) {
    // alle aktiven Nicht-GM-User
    const activeUsers = game.users.contents
      .filter((u) => u.active && !u.isGM)
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

    const groups = [];

    for (const user of activeUsers) {
      // alle Charakter-Actors, die der User besitzt
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
        options: ownedActors.map((actor) => ({
          actorId: actor.id,
          actorName: actor.name
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

  /** Formular-Submit */
  async _updateObject(event, formData) {
    console.log("lockpicking-minigame | _updateObject aufgerufen:", formData);

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
        console.warn("lockpicking-minigame | Auswahl fehlerhaft:", {
          selection,
          user,
          actor
        });
        return;
      }

      const getProp = foundry.utils.getProperty;

      /* ----------------- Diebeswerkzeug prüfen ----------------- */

      const thievesTools = actor.items.find((it) => {
        const name = (it.name ?? "").toLowerCase();
        const typeValue = getProp(it, "system.type.value") ?? "";
        return (
          it.type === "tool" &&
          (
            name.includes("diebes") ||      // „Diebeswerkzeug“
            name.includes("thieves") ||     // „Thieves' Tools“
            typeValue === "thievesTools" ||
            typeValue === "thief"
          )
        );
      });

      if (!thievesTools) {
        ui.notifications.warn(
          `${actor.name} besitzt keine Diebeswerkzeuge – Schlossknacken nicht möglich.`
        );
        console.log("lockpicking-minigame | Kein Diebeswerkzeug gefunden für", actor.name);
        return;
      }

      /* ----------------- Bonus & Nachteil bestimmen ------------ */

      // Basiswerte aus dem Actor
      const dexMod = getProp(actor, "system.abilities.dex.mod") ?? 0;
      const profBonus = getProp(actor, "system.attributes.prof") ?? 0;

      // dnd5e-Tool-Proficiency am Item:
      // 0 = keine, 0.5 = halb, 1 = prof., 2 = Expertise  (als Wert lesen wir typischerweise 0..3)
      const rawProf = getProp(thievesTools, "system.proficient") ?? 0;

      // Mapping für den Multiplikator
      let profMultiplier = 0;
      switch (rawProf) {
        case 1: // half
          profMultiplier = 0.5;
          break;
        case 2: // proficient
          profMultiplier = 1;
          break;
        case 3: // expertise (doppelt)
          profMultiplier = 2;
          break;
        default:
          profMultiplier = 0;
      }

      // Bonus: Dex + (Prof * Multiplikator)
      const bonus = dexMod + profBonus * profMultiplier;

      // Ungeübt (inkl. nur halber Proficiency) => Nachteil
      const disadvantage = profMultiplier < 1;

      console.log("lockpicking-minigame | Berechnete Werte:", {
        actor: actor.name,
        user: user.name,
        dc,
        dexMod,
        profBonus,
        rawProf,
        profMultiplier,
        bonus,
        disadvantage
      });

      /* ----------------- Mathematische Grenzen prüfen ---------- */
      // "Meets it, beats it"

      const maxRoll = bonus + 20; // max. d20 = 20
      const minRoll = bonus + 1;  // min. d20 = 1

      // Auto-Misserfolg: selbst mit 20 keine Chance
      if (maxRoll < dc) {
        const content =
          `Lockpicking-Versuch von <b>${actor.name}</b>: ` +
          `Selbst mit einem natürlichen 20er (${maxRoll}) kann DC ${dc} nicht erreicht werden. ` +
          `<b>Misserfolg ohne Wurf.</b>`;

        await ChatMessage.create({
          content,
          speaker: { alias: "Lockpicking" }
        });

        ui.notifications.warn(
          `${actor.name} kann dieses Schloss rechnerisch nicht knacken (DC zu hoch).`
        );
        return;
      }

      // Auto-Erfolg: selbst mit einer 1 wird DC erreicht
      if (minRoll >= dc) {
        const content =
          `Lockpicking-Versuch von <b>${actor.name}</b>: ` +
          `Selbst mit einer natürlichen 1 (${minRoll}) wird DC ${dc} erreicht oder übertroffen. ` +
          `<b>Automatischer Erfolg ohne Minispiel.</b>`;

        await ChatMessage.create({
          content,
          speaker: { alias: "Lockpicking" }
        });

        ui.notifications.info(`${actor.name} knackt das Schloss mühelos – kein Minispiel nötig.`);
        return;
      }

      /* ----------------- Chat-Nachricht + Flag ------------------ */

      const content =
        `Lockpicking-Minispiel für <b>${actor.name}</b> gestartet ` +
        `(DC ${dc}, Bonus ${bonus}${disadvantage ? ", mit Nachteil" : ""}).`;

      await ChatMessage.create({
        content,
        speaker: { alias: "Lockpicking" },
        flags: {
          "lockpicking-minigame": {
            action: "openGame",
            userId,
            actorId,
            dc,
            bonus,
            disadvantage
          }
        }
      });

      console.log("lockpicking-minigame | ChatMessage mit Flags erstellt.");
    } catch (err) {
      console.error("lockpicking-minigame | Fehler in _updateObject:", err);
      ui.notifications.error("Beim Start des Lockpicking-Minispiels ist ein Fehler aufgetreten. Siehe Konsole.");
    }
  }
}

/* ----------------------------------------- */
/*  Minigame-Fenster (Spieler, QTE)          */
/* ----------------------------------------- */

class LockpickingGameApp extends Application {
  constructor(actor, config, options = {}) {
    super(options);
    this.actor = actor;
    this.config = config; // { dc, bonus, disadvantage, ... }

    // QTE-State
    this.sequence = [];        // komplette Reihenfolge der Pfeile
    this.currentIndex = 0;     // welcher Schritt gerade
    this.timePerKey = 2500;    // ms
    this.finished = false;
    this.started = false;
    this.awaitingInput = false;

    // Animation/Timer
    this._timebarInner = null;
    this._timerFrame = null;
    this._keyDeadline = null;
    this._keyStartTime = null;
    this._boundKeyHandler = this._onKeyDown.bind(this);

    // definierbare "Tasten"
    this.availableKeys = [
      { code: "ArrowUp",    label: "↑" },
      { code: "ArrowRight", label: "→" },
      { code: "ArrowDown",  label: "↓" },
      { code: "ArrowLeft",  label: "←" }
    ];

    this._buildSequence();
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

  /* ------------ Daten für Template ---------------------------- */

  getData(options) {
    return {
      actorName: this.actor.name,
      dc: this.config.dc,
      bonus: this.config.bonus,
      disadvantage: this.config.disadvantage,
      steps: Array.from({ length: this.sequence.length })
    };
  }

  /* ------------ QTE-Setup ------------------------------------- */

  _buildSequence() {
    const { dc, bonus } = this.config;

    const diff = Math.max(0, dc - bonus);

    // Basismenge an Tasten: 3, dann mehr bei höherem DC
    let count = 3 + Math.floor(diff / 3);
    count = Math.max(2, Math.min(8, count)); // min 2, max 8

    this.sequence = [];
    for (let i = 0; i < count; i++) {
      const idx = Math.floor(Math.random() * this.availableKeys.length);
      this.sequence.push(this.availableKeys[idx]);
    }

    // Zeit pro Taste (ms): bessere Boni => mehr Zeit, hoher DC => weniger Zeit
    const disadvantage = this.config.disadvantage;
    const diffSigned = dc - bonus;
    let base = 2500; // 2,5s Grundzeit
    let extra = -diffSigned * 120; // wenn bonus > dc → diffSigned negativ → extra positiv

    let time = base + extra;
    if (disadvantage) time *= 0.85; // bei Nachteil etwas weniger Zeit
    time = Math.max(900, Math.min(6000, time));

    this.timePerKey = time;

    console.log("lockpicking-minigame | QTE-Setup:", {
      dc,
      bonus,
      disadvantage,
      keyCount: count,
      timePerKey: this.timePerKey
    });
  }

  /* ------------ Listener & Render ----------------------------- */

  activateListeners(html) {
    super.activateListeners(html);

    this._html = html;
    this._keyLabel = html.find(".lp-qte-key-label")[0];
    this._steps = html.find(".lp-step").toArray();
    this._timebarInner = html.find(".lp-timebar-inner")[0];

    html.find('[data-action="start"]').on("click", this._onStartClick.bind(this));
    html.find('[data-action="close"]').on("click", (ev) => {
      ev.preventDefault();
      this._cleanup();
      this.close();
    });
  }

  async close(options = {}) {
    this._cleanup();
    return super.close(options);
  }

  _cleanup() {
    this.finished = true;
    this.awaitingInput = false;
    if (this._timerFrame) cancelAnimationFrame(this._timerFrame);
    this._timerFrame = null;
    window.removeEventListener("keydown", this._boundKeyHandler);
  }

  /* ------------ Start & Fortschritt --------------------------- */

  _onStartClick(event) {
    event.preventDefault();
    if (this.started) return;
    this.started = true;

    if (this._startButton == null) {
      this._startButton = this._html.find('[data-action="start"]')[0];
    }
    if (this._startButton) {
      this._startButton.disabled = true;
      this._startButton.textContent = "Minispiel läuft...";
    }

    window.addEventListener("keydown", this._boundKeyHandler);
    this._goToStep(0);
  }

  _goToStep(index) {
    if (index >= this.sequence.length) {
      this._finish(true, "Alle Eingaben korrekt.");
      return;
    }

    this.currentIndex = index;
    this.awaitingInput = true;

    const current = this.sequence[index];

    if (this._keyLabel) {
      this._keyLabel.textContent = current.label;
    }

    this._updateStepIndicators();
    this._startKeyTimer();
  }

  _updateStepIndicators() {
    if (!this._steps) return;
    this._steps.forEach((el, i) => {
      el.classList.remove("done", "active", "pending");
      if (i < this.currentIndex) el.classList.add("done");
      else if (i === this.currentIndex) el.classList.add("active");
      else el.classList.add("pending");
    });
  }

  /* ------------ Timer für jeden Key --------------------------- */

  _startKeyTimer() {
    if (!this._timebarInner) return;

    if (this._timerFrame) cancelAnimationFrame(this._timerFrame);
    this._keyStartTime = performance.now();
    this._keyDeadline = this._keyStartTime + this.timePerKey;

    // voll gefüllter Balken am Start
    this._timebarInner.style.width = "100%";

    const loop = (now) => {
      if (!this.awaitingInput || this.finished) return;

      const remaining = this._keyDeadline - now;
      let ratio = remaining / this.timePerKey;
      if (ratio < 0) ratio = 0;
      if (ratio > 1) ratio = 1;

      this._timebarInner.style.width = `${ratio * 100}%`;

      if (remaining <= 0) {
        this._timerFrame = null;
        this._fail("Die Zeit ist abgelaufen.");
      } else {
        this._timerFrame = requestAnimationFrame(loop);
      }
    };

    this._timerFrame = requestAnimationFrame(loop);
  }

  /* ------------ Tasteneingabe ------------------------------ */

  _onKeyDown(event) {
    if (!this.awaitingInput || this.finished) return;

    const validCodes = ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"];
    if (!validCodes.includes(event.code)) return;

    event.preventDefault();

    const current = this.sequence[this.currentIndex];
    if (!current) return;

    if (event.code === current.code) {
      // richtige Taste
      if (this._timerFrame) cancelAnimationFrame(this._timerFrame);
      this._timerFrame = null;

      this.awaitingInput = false;
      this._goToStep(this.currentIndex + 1);
    } else {
      // falsche Taste → sofortiger Fail
      if (this._timerFrame) cancelAnimationFrame(this._timerFrame);
      this._timerFrame = null;
      this._fail("Falsche Taste gedrückt.");
    }
  }

  _fail(reason) {
    if (this.finished) return;
    this._finish(false, reason);
  }

  /* ------------ Abschluss & Chat-Ausgabe ------------------- */

  async _finish(success, reason = "") {
    this.finished = true;
    this.awaitingInput = false;
    window.removeEventListener("keydown", this._boundKeyHandler);
    if (this._timerFrame) cancelAnimationFrame(this._timerFrame);
    this._timerFrame = null;

    const { dc, bonus, disadvantage } = this.config;
    const totalSteps = this.sequence.length;

    const flavor =
      `Lockpicking-Minispiel – ${this.actor.name} versucht ein Schloss zu knacken.<br>` +
      `DC ${dc}, Bonus ${bonus}${disadvantage ? ", mit Nachteil" : ""}.<br>` +
      `Quick-Time-Event mit ${totalSteps} Eingaben (Pfeiltasten).<br>` +
      (reason ? `Hinweis: ${reason}<br>` : "") +
      `Ergebnis: <b>${success ? "Erfolg" : "Misserfolg"}</b>.`;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content: flavor
    });

    ui.notifications[success ? "info" : "warn"](
      success ? "Du knackst das Schloss!" : "Das Schloss widersteht deinem Versuch."
    );

    this.close();
  }
}
