// scripts/main.js

const MODULE_ID = "lockpicking-minigame";

/**
 * Kleine Hilfsfunktion: Wert zwischen min und max einklemmen.
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Zentrale Steuerklasse für das Lockpicking-Minispiel.
 */
class LockpickingMinigame {
  /**
   * Vom GM aufgerufen: Startet den Ablauf für einen Actor bei gegebener DC.
   * - Prüft passiven Wert (10 + Fingerfertigkeit)
   * - Wenn >= DC -> Auto-Erfolg, kein Minigame
   * - Sonst -> Timing-Minispiel
   */
  static async startForActor(actor, dc) {
    if (!actor) {
      ui.notifications.error("Lockpicking: Kein gültiger Actor ausgewählt.");
      return;
    }

    dc = Number(dc) || 10;

    // --- Skill ermitteln ---
    // Wir nehmen Sleight of Hand (DE: Fingerfertigkeit) als Basis.
    const sys = actor.system ?? {};
    const skills = sys.skills ?? {};

    // Unterschiedliche dnd5e-Versionen: sle oder slt
    const sle =
      skills.sle?.total ?? // ältere dnd5e-Versionen
      skills.slt?.total ?? // neuere dnd5e-Versionen
      0;

    const bonus = Number(sle) || 0;
    const passive = 10 + bonus; // "passives" Schlossknacken

    console.log(
      `${MODULE_ID} | Actor=${actor.name}, Bonus=${bonus}, Passive=${passive}, DC=${dc}`
    );

    // --- Auto-Erfolg, wenn Skill den DC "out-scaled" ---
    if (passive >= dc) {
      await this.handleAutoSuccess(actor, dc, bonus, passive);
      return;
    }

    // --- Minigame nötig ---
    const gameApp = new LockpickingGameApp(actor, { dc, bonus });
    gameApp.render(true);
  }

  /**
   * Auto-Erfolg ohne Minigame (z.B. hoher Rogue mit Reliable Talent).
   */
  static async handleAutoSuccess(actor, dc, bonus, passive) {
    const content = `
      <p><strong>${actor.name}</strong> knackt das Schloss ohne Mühe.</p>
      <ul>
        <li>DC: ${dc}</li>
        <li>Bonus: +${bonus}</li>
        <li>Passiver Wert: ${passive} (≥ DC)</li>
      </ul>
      <p>Kein Minispiel nötig – der Charakter ist zu geübt.</p>
    `;

    await ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor })
    });

    ui.notifications.info(
      `Lockpicking: ${actor.name} übertrifft den DC – automatischer Erfolg.`
    );
  }

  /**
   * Erfolg nach bestandenem Minigame.
   */
  static async handleSuccess(actor, dc, resultInfo = "") {
    const content = `
      <p><strong>${actor.name}</strong> knackt das Schloss!</p>
      <p>DC: ${dc}</p>
      ${resultInfo ? `<p>${resultInfo}</p>` : ""}
    `;
    await ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor })
    });
  }

  /**
   * Fehlschlag nach Minigame.
   */
  static async handleFailure(actor, dc, resultInfo = "") {
    const content = `
      <p><strong>${actor.name}</strong> scheitert beim Schlossknacken.</p>
      <p>DC: ${dc}</p>
      ${resultInfo ? `<p>${resultInfo}</p>` : ""}
    `;
    await ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor })
    });
  }

  /**
   * Öffnet die GM-Konfiguration (Actor + DC).
   */
  static openConfig() {
    const app = new LockpickingConfigApp();
    app.render(true);
  }
}

/**
 * GM-Dialog: Actor auswählen + DC setzen.
 * Nutzt FormApplication -> Template muss im <form> stehen.
 */
class LockpickingConfigApp extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-config",
      title: "Lockpicking Minigame",
      template: `modules/${MODULE_ID}/templates/lock-config.hbs`,
      width: 400,
      height: "auto",
      closeOnSubmit: true
    });
  }

  /**
   * Bietet alle Player-Actor zur Auswahl an.
   */
  getData() {
    const actors = (game.actors?.contents ?? [])
      .filter((a) => a.hasPlayerOwner)
      .map((a) => ({
        id: a.id,
        name: a.name
      }));

    return {
      actors,
      defaultDc: 15
    };
  }

  /**
   * Wird ausgelöst, wenn das Formular abgeschickt wird.
   */
  async _updateObject(event, formData) {
    const actorId = formData.actorId;
    const dc = Number(formData.dc) || 10;

    if (!actorId) {
      ui.notifications.error("Lockpicking: Bitte einen Charakter auswählen.");
      return;
    }

    const actor = game.actors.get(actorId);
    if (!actor) {
      ui.notifications.error("Lockpicking: Actor nicht gefunden.");
      console.error(`${MODULE_ID} | ActorId nicht gefunden:`, actorId);
      return;
    }

    await LockpickingMinigame.startForActor(actor, dc);
  }
}

/**
 * Das eigentliche Minigame – simples, aber immersives Timing-Spiel:
 * Eine Markierung läuft hin und her, der Spieler klickt, wenn sie im Sweetspot ist.
 */
class LockpickingGameApp extends Application {
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.dc = options.dc ?? 15;
    this.bonus = options.bonus ?? 0;
    this._interval = null;
    this._direction = 1;
    this._position = 0; // 0–100
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-game",
      title: "Schlossknacken",
      template: `modules/${MODULE_ID}/templates/lock-game.hbs`,
      width: 500,
      height: "auto",
      popOut: true,
      resizable: false
    });
  }

  getData() {
    // Sweetspot-Breite abhängig vom DC: je höher DC, desto kleiner der Bereich.
    const baseWidth = 40; // in %
    const minWidth = 10;
    const difficultyFactor = clamp((this.dc - 10) / 10, 0, 1);
    const sweetWidth = Math.round(
      baseWidth - difficultyFactor * (baseWidth - minWidth)
    );

    return {
      actorName: this.actor.name,
      dc: this.dc,
      bonus: this.bonus,
      sweetWidth
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    const startBtn = html.find(".lp-start");
    const tryBtn = html.find(".lp-try");
    const statusEl = html.find(".lp-status");
    const marker = html.find(".lp-marker");
    const zone = html.find(".lp-zone");

    // Sweetspot zufällig positionieren
    const sweetWidth = Number(zone.data("sweet-width")) || 30;
    const sweetLeft = Math.random() * (100 - sweetWidth);
    zone.css({
      left: `${sweetLeft}%`,
      width: `${sweetWidth}%`
    });

    const startGame = () => {
      if (this._interval) clearInterval(this._interval);
      this._position = 0;
      this._direction = 1;
      tryBtn.prop("disabled", false);
      statusEl.text("Beobachte die Bewegung und klicke im richtigen Moment...");

      this._interval = setInterval(() => {
        this._position += this._direction * 2; // Geschwindigkeit
        if (this._position >= 100) {
          this._position = 100;
          this._direction = -1;
        } else if (this._position <= 0) {
          this._position = 0;
          this._direction = 1;
        }
        marker.css("left", `${this._position}%`);
      }, 30);
    };

    const finishGame = async () => {
      if (this._interval) {
        clearInterval(this._interval);
        this._interval = null;
      }
      tryBtn.prop("disabled", true);

      const markerPos = this._position;
      const zoneLeft = sweetLeft;
      const zoneRight = sweetLeft + sweetWidth;

      const inZone = markerPos >= zoneLeft && markerPos <= zoneRight;

      if (inZone) {
        statusEl.text("Du triffst den Sweetspot – das Schloss gibt nach!");
        const center = (zoneLeft + zoneRight) / 2;
        const offCenter = Math.abs(markerPos - center);
        const quality =
          offCenter < sweetWidth * 0.1
            ? "Nahezu perfekter Treffer."
            : "Solider Treffer.";

        await LockpickingMinigame.handleSuccess(
          this.actor,
          this.dc,
          `${quality} (Timing-Minispiel bestanden)`
        );
        this.close();
      } else {
        statusEl.text("Das Schloss klemmt – du verfehlst den Sweetspot.");
        await LockpickingMinigame.handleFailure(
          this.actor,
          this.dc,
          "Timing-Minispiel verfehlt."
        );
        this.close();
      }
    };

    startBtn.on("click", startGame);
    tryBtn.on("click", finishGame);
  }

  close(options) {
    if (this._interval) clearInterval(this._interval);
    return super.close(options);
  }
}

// --- Hooks / Namespace-Registrierung ---

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);
  // Globaler Zugriff, z.B. im Macro: game.lockpickingMinigame.openConfig()
  game.lockpickingMinigame = LockpickingMinigame;
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready`);
});
