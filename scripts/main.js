// scripts/main.js

const MODULE_ID = "lockpicking-minigame";

/** Hilfsfunktion **/
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Hauptklasse **/
class LockpickingMinigame {

  /**
   * GM startet Schlossknacken für Actor x mit DC y.
   * targetUserId = User, bei dem ggf. das Minigame geöffnet werden soll.
   */
  static async startForActor(actor, dc, targetUserId) {
    if (!actor) {
      ui.notifications.error("Lockpicking: Kein Actor ausgewählt.");
      return;
    }

    dc = Number(dc) || 10;

    // Fingerfertigkeitsbonus abrufen (Fingerfertigkeit / Sleight of Hand)
    const sys = actor.system ?? {};
    const skills = sys.skills ?? {};
    const sle = skills.slt?.total ?? skills.sle?.total ?? 0;

    const bonus = Number(sle) || 0;
    const passive = 10 + bonus;

    console.log(
      `${MODULE_ID} | Actor=${actor.name}, Bonus=${bonus}, Passive=${passive}, DC=${dc}, targetUser=${targetUserId}`
    );

    // Auto-Erfolg -> nur Chatnachricht, kein Minigame
    if (passive >= dc) {
      await this.handleAutoSuccess(actor, dc, bonus, passive);
      return;
    }

    // Minigame nötig -> per Socket an den Ziel-User schicken
    const payload = {
      action: "openMinigame",
      actorId: actor.id,
      dc,
      bonus,
      userId: targetUserId ?? null
    };

    game.socket.emit(`module.${MODULE_ID}`, payload);
  }

  /** Auto-ERFOLG (ohne Minigame) **/
  static async handleAutoSuccess(actor, dc, bonus, passive) {
    const content = `
      <p><strong>${actor.name}</strong> knackt das Schloss sofort.</p>
      <ul>
        <li>DC: ${dc}</li>
        <li>Bonus: +${bonus}</li>
        <li>Passiver Wert: ${passive} ≥ DC</li>
      </ul>
      <p>Kein Minispiel nötig – der Charakter ist zu geübt.</p>
    `;

    await ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor })
    });
  }

  /** Erfolg nach Minigame **/
  static async handleSuccess(actor, dc, info = "") {
    const content = `
      <p><strong>${actor.name}</strong> knackt das Schloss!</p>
      <p>DC: ${dc}</p>
      <p>${info}</p>
    `;

    await ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor })
    });
  }

  /** Misserfolg nach Minigame **/
  static async handleFailure(actor, dc, info = "") {
    const content = `
      <p><strong>${actor.name}</strong> scheitert beim Schlossknacken.</p>
      <p>DC: ${dc}</p>
      <p>${info}</p>
    `;

    await ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor })
    });
  }

  /** Config öffnen (wird z.B. per Macro aufgerufen) **/
  static openConfig() {
    new LockpickingConfigApp().render(true);
  }

  /**
   * Hilfsfunktion: ermittelt, welcher Spieler das Minigame sehen soll.
   * Nimmt den ersten aktiven Spieler, der den Actor besitzt.
   */
  static findOwningUser(actor) {
    const players = game.users?.players ?? [];
    // nur nicht-GM Spieler
    const nonGmPlayers = players.filter(u => !u.isGM);

    // Foundry v10+ : ownership-Objekt
    const ownership = actor.ownership ?? {};

    let target = null;
    for (const user of nonGmPlayers) {
      const level = ownership[user.id];
      if (typeof level === "number" && level >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) {
        target = user;
        break;
      }
    }

    // Fallback: erster aktiver GM
    if (!target) {
      target = game.users?.activeGM ?? game.user;
    }

    return target;
  }
}

/** GM-Konfiguration **/
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
      ui.notifications.error("Bitte einen Charakter auswählen.");
      return;
    }

    const actor = game.actors.get(actorId);
    if (!actor) {
      ui.notifications.error("Actor nicht gefunden.");
      return;
    }

    const targetUser = LockpickingMinigame.findOwningUser(actor);

    await LockpickingMinigame.startForActor(actor, dc, targetUser?.id);
  }
}


/** Timing-Minigame (läuft auf dem Client, der die Socket-Nachricht erhält) **/
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
      popOut: true
    });
  }

  getData() {
    const baseWidth = 40;
    const minWidth = 10;
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
    const btnTry = html.find(".lp-try");
    const marker = html.find(".lp-marker");
    const zone = html.find(".lp-zone");
    const status = html.find(".lp-status");

    const sweetWidth = Number(zone.data("sweet-width"));
    const sweetLeft = Math.random() * (100 - sweetWidth);

    zone.css({
      left: `${sweetLeft}%`,
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
      const zL = sweetLeft;
      const zR = sweetLeft + sweetWidth;

      if (pos >= zL && pos <= zR) {
        const center = (zL + zR) / 2;
        const off = Math.abs(pos - center);
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
  console.log(`${MODULE_ID} | init`);
  game.lockpickingMinigame = LockpickingMinigame;
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready`);

  // Socket-Listener: reagiert auf Nachrichten vom GM
  game.socket.on(`module.${MODULE_ID}`, async (data) => {
    if (!data || data.action !== "openMinigame") return;

    // Wenn ein bestimmter User adressiert ist: nur dieser reagiert
    if (data.userId && data.userId !== game.user.id) return;

    const actor = game.actors.get(data.actorId);
    if (!actor) return;

    const app = new LockpickingGameApp(actor, {
      dc: data.dc,
      bonus: data.bonus
    });
    app.render(true);
  });
});
