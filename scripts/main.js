// scripts/main.js

const MODULE_ID = "lockpicking-minigame";

/** Kleine Hilfsfunktion, um Werte einzuklemmen */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Zentrale Steuerklasse für das Lockpicking-Minispiel
 */
class LockpickingMinigame {

  /**
   * Prüft, ob der Actor das Merkmal "Verlässliches Talent" / "Reliable Talent" besitzt.
   */
  static hasReliableTalent(actor) {
    const items = actor.items ?? [];
    return items.some(i => {
      const name = (i.name ?? "").toLowerCase();
      return name.includes("verlässliches talent") || name.includes("reliable talent");
    });
  }

  /**
   * Ermittelt, welcher User das Minigame sehen soll.
   * Nimmt einen nicht-GM-User, der den Actor besitzt.
   * Fallback: aktiver GM.
   */
  static findOwningUser(actor) {
    const users = game.users?.contents ?? [];

    // Bevorzugt: Nicht-GM Spieler mit Owner-Rechten
    for (const u of users) {
      if (u.isGM) continue;

      // Moderner Weg
      try {
        if (actor.testUserPermission &&
            actor.testUserPermission(u, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) {
          return u;
        }
      } catch (e) {
        console.warn(`${MODULE_ID} | testUserPermission failed`, e);
      }

      // Fallback über ownership-Objekt
      const ownLevel = actor.ownership?.[u.id] ?? 0;
      if (ownLevel >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
        return u;
      }
    }

    // Wenn kein passender Spieler gefunden: aktiver GM oder aktueller User
    return game.users?.activeGM ?? game.user;
  }

  /**
   * Vom GM aufgerufen: Startet Schlossknacken für einen Actor bei einem DC.
   * - Prüft passiven Wert (10 + Fingerfertigkeit)
   * - Auto-Erfolg nur, wenn Reliable Talent vorhanden UND passiver Wert ≥ DC
   * - Sonst wird das Minigame gezielt an den Spieler-Client geschickt
   *   UND zusätzlich beim GM geöffnet.
   */
  static async startForActor(actor, dc) {
    if (!actor) {
      ui.notifications.error("Lockpicking: Kein Actor ausgewählt.");
      return;
    }

    dc = Number(dc) || 10;

    // Fingerfertigkeit / Sleight of Hand lesen
    const sys = actor.system ?? {};
    const skills = sys.skills ?? {};
    const sle = skills.slt?.total ?? skills.sle?.total ?? 0;

    const bonus = Number(sle) || 0;
    const passive = 10 + bonus;
    const hasReliable = this.hasReliableTalent(actor);

    console.log(
      `${MODULE_ID} | Actor=${actor.name}, Bonus=${bonus}, Passive=${passive}, DC=${dc}, Reliable=${hasReliable}`
    );

    // 🔑 Auto-Erfolg NUR, wenn Reliable Talent vorhanden ist UND passiver Wert den DC erreicht
    if (hasReliable && passive >= dc) {
      await this.handleAutoSuccess(actor, dc, bonus, passive);
      return;
    }

    // ❗ Kein Auto-Erfolg -> Minigame nötig

    // 1) Ziel-User (Spieler) ermitteln
    const targetUser = this.findOwningUser(actor);
    if (!targetUser) {
      ui.notifications.warn("Lockpicking: Kein passender Spieler-User gefunden. Minigame läuft nur beim SL.");
    }

    const payload = {
      action: "openMinigame",
      actorId: actor.id,
      dc,
      bonus,
      userId: targetUser?.id ?? null
    };

    console.log(`${MODULE_ID} | sending socket`, payload);
    game.socket.emit(`module.${MODULE_ID}`, payload);

    // 2) Immer auch beim GM lokal anzeigen (Debug + Kontrolle)
    const app = new LockpickingGameApp(actor, {
      dc,
      bonus
    });
    app.render(true);
  }

  /** Auto-Erfolg ohne Minigame (Reliable Talent + hoher passiver Wert) */
  static async handleAutoSuccess(actor, dc, bonus, passive) {
    const content = `
      <p><strong>${actor.name}</strong> knackt das Schloss mühelos dank <em>Verlässlichem Talent</em>.</p>
      <ul>
        <li>DC: ${dc}</li>
        <li>Fingerfertigkeit-Bonus: +${bonus}</li>
        <li>Passiver Wert: ${passive} ≥ DC</li>
        <li>Merkmal: Verlässliches Talent</li>
      </ul>
      <p>Kein Minispiel nötig – der Charakter ist zu geübt.</p>
    `;

    await ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor })
    });
  }

  /** Erfolg nach bestandenem Minigame */
  static async handleSuccess(actor, dc, info = "") {
    const content = `
      <p><strong>${actor.name}</strong> knackt das Schloss!</p>
      <p>DC: ${dc}</p>
      ${info ? `<p>${info}</p>` : ""}
    `;

    await ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor })
    });
  }

  /** Fehlschlag nach Minigame */
  static async handleFailure(actor, dc, info = "") {
    const content = `
      <p><strong>${actor.name}</strong> scheitert beim Schlossknacken.</p>
      <p>DC: ${dc}</p>
      ${info ? `<p>${info}</p>` : ""}
    `;

    await ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor })
    });
  }

  /** Öffnet den GM-Dialog (Actor + DC auswählen) – per Macro aufrufbar */
  static openConfig() {
    new LockpickingConfigApp().render(true);
  }
}

/**
 * GM-Konfiguration: Actor + DC wählen
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

  getData() {
    // Alle Player-Actor (mit Spielerbesitzer) zur Auswahl anbieten
    const actors = (game.actors?.contents ?? [])
      .filter(a => a.hasPlayerOwner)
      .map(a => ({ id: a.id, name: a.name }));

    return {
      actors,
      defaultDc: 15
    };
  }

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
      return;
    }

    await LockpickingMinigame.startForActor(actor, dc);
  }
}

/**
 * Das eigentliche Timing-Minispiel – läuft auf dem Ziel-Client.
 */
class LockpickingGameApp extends Application {

  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.dc = options.dc;
    this.bonus = options.bonus;

    this._interval = null;
    this._pos = 0;
    this._dir = 1;
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
    // Sweetspot-Breite abhängig vom DC
    const baseWidth = 40;       // in %
    const minWidth = 10;        // kleinste Breite
    const diff = clamp((this.dc - 10) / 10, 0, 1);
    const sweetWidth = Math.round(baseWidth - diff * (baseWidth - minWidth));

    return {
      actorName: this.actor.name,
      dc: this.dc,
      bonus: this.bonus,
      sweetWidth
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    const btnStart = html.find(".lp-start");
    const btnTry   = html.find(".lp-try");
    const marker   = html.find(".lp-marker");
    const zone     = html.find(".lp-zone");
    const status   = html.find(".lp-status");

    const sweetWidth = Number(zone.data("sweet-width"));
    const sweetLeft  = Math.random() * (100 - sweetWidth);

    zone.css({
      left:  `${sweetLeft}%`,
      width: `${sweetWidth}%`
    });

    const startGame = () => {
      if (this._interval) clearInterval(this._interval);

      this._pos = 0;
      this._dir = 1;
      btnTry.prop("disabled", false);
      status.text("Beobachte die Bewegung und klicke im richtigen Moment…");

      this._interval = setInterval(() => {
        this._pos += this._dir * 2;

        if (this._pos >= 100) { this._pos = 100; this._dir = -1; }
        if (this._pos <= 0)   { this._pos = 0;   this._dir = 1; }

        marker.css("left", `${this._pos}%`);
      }, 30);
    };

    const finishGame = async () => {
      if (this._interval) clearInterval(this._interval);
      btnTry.prop("disabled", true);

      const pos = this._pos;
      const zL  = sweetLeft;
      const zR  = sweetLeft + sweetWidth;

      if (pos >= zL && pos <= zR) {
        const center  = (zL + zR) / 2;
        const off     = Math.abs(pos - center);
        const perfect = off < sweetWidth * 0.1;

        await LockpickingMinigame.handleSuccess(
          this.actor,
          this.dc,
          perfect ? "Perfekter Treffer!" : "Guter Treffer!"
        );

      } else {
        await LockpickingMinigame.handleFailure(
          this.actor,
          this.dc,
          "Timing verfehlt."
        );
      }

      this.close();
    };

    btnStart.on("click", startGame);
    btnTry.on("click", finishGame);
  }

  close(options = {}) {
    if (this._interval) clearInterval(this._interval);
    return super.close(options);
  }
}

/** Hooks **/
Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init (user=${game.user?.id})`);
  // Globaler Zugriff, z.B. Macro: game.lockpickingMinigame.openConfig()
  game.lockpickingMinigame = LockpickingMinigame;
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready (user=${game.user?.id})`);

  // Socket-Listener: reagiert auf Nachrichten vom GM
  game.socket.on(`module.${MODULE_ID}`, async (data) => {
    if (!data || data.action !== "openMinigame") return;

    console.log(`${MODULE_ID} | socket received`, data, "on user", game.user.id);

    // Wenn ein bestimmter User adressiert ist: nur dieser reagiert
    if (data.userId && data.userId !== game.user.id) return;

    const actor = game.actors.get(data.actorId);
    if (!actor) {
      console.warn(`${MODULE_ID} | Actor not found on client`, data.actorId);
      return;
    }

    const app = new LockpickingGameApp(actor, {
      dc: data.dc,
      bonus: data.bonus
    });
    app.render(true);
    
  });
});
window.LockpickingGameApp = LockpickingGameApp;
window.LockpickingConfigApp = LockpickingConfigApp;
window.openLockpickingGame = openLockpickingGame;


