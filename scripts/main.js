// scripts/main.js

class LockpickingMinigame {
  /**
   * Vom GM aufgerufen: Startet den Ablauf für einen Actor bei gegebener DC.
   */
  static async startForActor(actor, dc) {
    if (!actor) {
      ui.notifications.error("Lockpicking: Kein gültiger Actor ausgewählt.");
      return;
    }

    dc = Number(dc) || 10;

    // --- Skill ermitteln ---
    // Wir nehmen Sleight of Hand (DE: Fingerfertigkeit) als Basis.
    // Je nach dnd5e-Version ist es "sle" oder "slt". Wir versuchen beides.
    const sys = actor.system ?? {};
    const skills = sys.skills ?? {};
    const sle =
      skills.sle?.total ?? // ältere dnd5e-Versionen
      skills.slt?.total ?? // neuere dnd5e-Versionen
      0;

    const bonus = sle;
    const passive = 10 + bonus; // "passives" Schlossknacken

    console.log(
      `Lockpicking | Actor=${actor.name}, Bonus=${bonus}, Passive=${passive}, DC=${dc}`
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
   * Öffnet die GM-Konfiguration.
   */
  static openConfig() {
    const app = new LockpickingConfigApp();
    app.render(true);
  }
}

/**
 * GM-Dialog: Actor auswählen + DC setzen.
 */
class LockpickingConfigApp extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-config",
      title: "Lockpicking Minigame",
      template:
        "modules/lockpicking-minigame/templates/lock-config.hbs",
      width: 400,
      height: "auto",
      closeOnSubmit: true
    });
  }

  getData() {
    // Alle Token auf der aktuellen Szene als Auswahl
    const tokens = canvas?.tokens?.placeables ?? [];
    const actors = tokens
      .filter((t) => !!t.actor)
      .map((t) => ({
        id: t.actor.id,
        name: t.name
      }));

    return {
      actors,
      defaultDc: 15
    };
  }

  async _updateObject(event, formData) {
    const actorId = formData.actorId;
    const dc = Number(formData.dc) || 10;

    const actor = game.actors.get(actorId);
    if (!actor) {
      ui.notifications.error("Lockpicking: Actor nicht gefunden.");
      return;
    }

    // Startet den eigentlichen Ablauf
    await LockpickingMinigame.startForActor(actor, dc);
  }
}

/**
 * Das eigentliche Minigame – simples, aber immersives Timing-Spiel:
 * Eine Markierung läuft hin und her, der Spieler klickt, wenn sie im Sweetspot ist.
 */
class LockpickingGameApp extends Application {
  constructor(actor, options) {
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
      template:
        "modules/lockpick
