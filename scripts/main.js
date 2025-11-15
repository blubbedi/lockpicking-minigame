// modules/lockpicking-minigame/scripts/main.js

const MODULE_ID = "lockpicking-minigame";

/**
 * Kleine Helper-Funktion zum Loggen
 */
function lpLog(...args) {
  console.log(`${MODULE_ID} |`, ...args);
}

/* ------------------------------------- */
/*  Lockpicking Game App                 */
/* ------------------------------------- */

class LockpickingGameApp extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-game",
      title: "Schlossknacken",
      template: `modules/${MODULE_ID}/templates/lock-game.hbs`,
      width: 500,
      height: "auto",
      classes: ["lockpicking-app"],
      popOut: true
    });
  }

  /**
   * @param {Actor} actor
   * @param {object} options
   *  - dc: number
   *  - bonus: number
   */
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.dc = options.dc ?? 10;
    this.bonus = options.bonus ?? 0;

    // Zustände für das Minigame
    this._isMoving = false;
    this._position = 0;       // 0..100
    this._direction = 1;      // 1 oder -1
    this._targetMin = 40;
    this._targetMax = 60;
    this._interval = null;
  }

  getData(options = {}) {
    return {
      actorName: this.actor?.name ?? "Unbekannt",
      dc: this.dc,
      bonus: this.bonus,
      position: this._position,
      targetMin: this._targetMin,
      targetMax: this._targetMax
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    const startBtn = html.find("[data-action='start']");
    const stopBtn = html.find("[data-action='stop']");

    startBtn.on("click", (event) => {
      event.preventDefault();
      this._startMovement();
    });

    stopBtn.on("click", (event) => {
      event.preventDefault();
      this._stopAndResolve();
    });
  }

  _startMovement() {
    if (this._isMoving) return;
    this._isMoving = true;

    // Zufällige Zielzone je Versuch
    const width = 15 + Math.floor(Math.random() * 15); // 15–30
    const start = 20 + Math.floor(Math.random() * (60 - width));
    this._targetMin = start;
    this._targetMax = start + width;

    const step = 2 + Math.random() * 3; // 2–5

    this._interval = setInterval(() => {
      this._position += step * this._direction;
      if (this._position >= 100) {
        this._position = 100;
        this._direction = -1;
      } else if (this._position <= 0) {
        this._position = 0;
        this._direction = 1;
      }
      this.render(false);
    }, 50);
  }

  async _stopAndResolve() {
    if (!this._isMoving) return;
    this._isMoving = false;

    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }

    const inZone = this._position >= this._targetMin && this._position <= this._targetMax;

    // Ergebniswürfel: 1W20 + Bonus, bei Treffer erhält der Wurf Vorteil
    let rollFormula;
    if (inZone) {
      rollFormula = `2d20kh + ${this.bonus}`;
    } else {
      rollFormula = `1d20 + ${this.bonus}`;
    }

    const roll = await new Roll(rollFormula).roll({async: true});
    const success = roll.total >= this.dc;

    const resultMsg = success
      ? `${this.actor.name} knackt das Schloss (DC ${this.dc}, Ergebnis ${roll.total}).`
      : `${this.actor.name} scheitert am Schloss (DC ${this.dc}, Ergebnis ${roll.total}).`;

    const content = `
      <p><strong>Schlossknacken-Ergebnis</strong></p>
      <p>${resultMsg}</p>
      <p>Formel: <code>${rollFormula}</code></p>
    `;

    await roll.toMessage(
      {
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
        flavor: "Schlossknacken-Minispiel",
        content
      },
      { rollMode: game.settings.get("core", "rollMode") }
    );

    this.close();
  }
}

/* ------------------------------------- */
/*  Konfig-Dialog für den GM             */
/* ------------------------------------- */

class LockpickingConfigApp extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-config",
      title: "Schlossknacken konfigurieren",
      template: `modules/${MODULE_ID}/templates/lock-config.hbs`,
      width: 400,
      height: "auto",
      closeOnSubmit: true
    });
  }

  getData(options = {}) {
    const actorsOnScene = canvas.tokens.placeables
      .map(t => t.actor)
      .filter(a => !!a);

    // Nur Spieler-Charaktere o.ä. (optional filtern)
    const uniqueActors = foundry.utils.uniq(actorsOnScene);

    return {
      actors: uniqueActors,
      defaultDc: 15
    };
  }

  /**
   * GM schickt hier die Infos an den Spieler
   */
  async _updateObject(_event, formData) {
    const actorId = formData.actorId;
    const dc = Number(formData.dc) || 10;

    const actor = game.actors.get(actorId);
    if (!actor) {
      ui.notifications.error("Kein gültiger Actor ausgewählt.");
      return;
    }

    // DEX (Sleight of Hand) Bonus: 5e-spezifisch
    let bonus = 0;
    try {
      // Pfad kann je nach System variieren – hier dnd5e V12+
      bonus = actor.system.skills?.sle?.mod ?? 0;
    } catch (e) {
      lpLog("Konnte Fingefertigkeit-Bonus nicht lesen:", e);
    }

    // Reliable Talent / Verlässliches Talent? (D&D 5e)
    let reliable = false;
    try {
      const items = actor.items.filter(i => i.type === "feat");
      reliable = items.some(i =>
        /verlässliches talent|reliable talent/i.test(i.name ?? "")
      );
    } catch (e) {
      // Ignorieren, nur Debug
      lpLog("Fehler beim Prüfen von Reliable Talent:", e);
    }

    // Auto-Erfolg: passiver Wert >= DC
    const passive = 10 + bonus;
    if (passive >= dc && !reliable) {
      const msg = `
        <p><strong>${actor.name}</strong> knackt das Schloss sofort.</p>
        <ul>
          <li>DC: ${dc}</li>
          <li>Bonus: ${bonus >= 0 ? "+" + bonus : bonus}</li>
          <li>Passiver Wert: ${passive} ≥ DC</li>
        </ul>
        <p>Kein Minispiel nötig – der Charakter ist zu geübt.</p>
      `;
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: msg
      });
      return;
    }

    // Wenn Reliable Talent aktiv ist, Hinweis im Chat
    if (reliable) {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<p>${actor.name} besitzt <strong>Verlässliches Talent</strong> – bei einem echten Fertigkeitswurf würden 1–9 als 10 gewertet.</p>`
      });
    }

    // Chat-Info, dass das Minispiel gestartet wird
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<p>Lockpicking-Minispiel für <strong>${actor.name}</strong> gestartet (DC ${dc}, Bonus ${bonus}).</p>`
    });

    // *** Wichtig: Wir schicken jetzt nur noch die nackten Daten,
    // der Client entscheidet selbst, ob er das Fenster öffnet. ***
    lpLog("Sending openMinigame", { actorId: actor.id, dc, bonus });

    game.socket.emit(`module.${MODULE_ID}`, {
      action: "openMinigame",
      actorId: actor.id,
      dc,
      bonus
    });

    // Optional: Wenn kein Spieler verbunden ist, öffnet der GM das Spiel lokal
    const hasNonGMPlayer = game.users.players.some(u => !u.isGM);
    if (!hasNonGMPlayer) {
      lpLog("Keine Spieler verbunden – öffne Minispiel lokal beim GM.");
      const app = new LockpickingGameApp(actor, { dc, bonus });
      app.render(true);
    }
  }
}

/* ------------------------------------- */
/*  Globale Funktionen / Hooks           */
/* ------------------------------------- */

/**
 * Öffnet den Konfig-Dialog.
 * Kann z.B. direkt vom Macro aus aufgerufen werden.
 */
function openLockpickingConfig(initialActor = null) {
  const app = new LockpickingConfigApp({ actor: initialActor });
  app.render(true);
}

Hooks.once("init", () => {
  lpLog("Initializing");
});

Hooks.once("ready", () => {
  lpLog("ready, user =", game.user.id);

  // Globale API
  game.lockpickingMinigame = {
    openConfig: openLockpickingConfig
  };

  // Socket-Listener – läuft auf **allen** Clients
  game.socket.on(`module.${MODULE_ID}`, (data) => {
    if (!data || data.action !== "openMinigame") return;

    // DEBUG
    lpLog("Socket received", data, "on user", game.user.id);

    // Wenn ein Spieler verbunden ist, sollen **nur Nicht-GMs** das Minigame sehen.
    const hasNonGMPlayer = game.users.players.some(u => !u.isGM);
    if (hasNonGMPlayer && game.user.isGM) return;

    const actor = game.actors.get(data.actorId);
    if (!actor) {
      lpLog("Actor not found on client", data.actorId);
      return;
    }

    const app = new LockpickingGameApp(actor, {
      dc: data.dc,
      bonus: data.bonus
    });
    app.render(true);
  });
});

// Für schnelle Tests in der Browser-Konsole:
window.LockpickingGameApp = LockpickingGameApp;
window.LockpickingConfigApp = LockpickingConfigApp;
window.openLockpickingGame = openLockpickingConfig;
