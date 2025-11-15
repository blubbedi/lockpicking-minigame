// modules/lockpicking-minigame/scripts/main.js

const MODULE_ID = "lockpicking-minigame";
const MODULE_TITLE = "Lockpicking Minigame";

/* ---------------------------------------- */
/* Hilfsfunktionen                          */
/* ---------------------------------------- */

/**
 * Hole den Sleight-of-Hand Bonus und passiven Wert aus einem D&D5e Actor.
 * Rückgabe: { bonus, passive, reliable }
 */
function getLockpickingData(actor) {
  const system = actor.system ?? actor.data?.data ?? {};
  let bonus = 0;
  let passive = 10;

  // Versuche den Skill "Sleight of Hand" (id = slt)
  const skill = system.skills?.slt;
  if (skill) {
    bonus = skill.total ?? skill.mod ?? 0;
  } else {
    // Fallback: DEX-Modifikator
    const dex = system.abilities?.dex;
    bonus = dex?.mod ?? 0;
  }

  passive = 10 + bonus;

  // Prüfe auf "Verlässliches Talent"
  const hasReliableTalent = actor.items.some(i =>
    i.type === "feat" &&
    /verlässliches talent|reliable talent/i.test(i.name ?? "")
  );

  return { bonus, passive, reliable: hasReliableTalent };
}

/* ---------------------------------------- */
/* Konfigurations-Dialog (GM)               */
/* ---------------------------------------- */

class LockpickingConfigApp extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-config",
      title: "Schlossknacken",
      template: `modules/${MODULE_ID}/templates/lock-config.hbs`,
      width: 420
    });
  }

  /** Liste aller Token-Actors auf der aktuellen Szene */
  getData() {
    const actors = canvas.scene?.tokens
      ?.filter(t => !!t.actor)
      .map(t => t.actor);

    return {
      actors: actors ?? [],
      defaultDc: 15
    };
  }

  async _updateObject(event, formData) {
    event.preventDefault();

    const actorId = formData.actorId;
    const dc = Number(formData.dc) || 10;

    const actor = game.actors.get(actorId);
    if (!actor) {
      ui.notifications.error(`${MODULE_TITLE}: Kein gültiger Charakter ausgewählt.`);
      return;
    }

    const { bonus, passive, reliable } = getLockpickingData(actor);

    // Besitzer bestimmen: erster Spieler mit OWNER-Recht
    const ownerUser =
      game.users.players.find(u => actor.testUserPermission(u, "OWNER")) ??
      game.user; // Fallback GM

    const actorName = actor.name ?? "Unbekannt";

    // Auto-Erfolg, falls passiver Wert >= DC
    if (passive >= dc) {
      const msg = `${actorName} knackt das Schloss sofort.<br>` +
        `<ul>` +
        `<li>DC: ${dc}</li>` +
        `<li>Bonus: ${bonus >= 0 ? "+" + bonus : bonus}</li>` +
        `<li>Passiver Wert: ${passive} ≥ DC</li>` +
        `</ul>` +
        (reliable ? `<p><i>Verlässliches Talent berücksichtigt.</i></p>` : "");

      ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: msg
      });

      return;
    }

    // Chat-Nachricht: Minispiel startet
    ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content:
        `Lockpicking-Minispiel für ${actorName} gestartet (DC ${dc}, Bonus ${bonus}).`
    });

    // Socket-Nachricht an Besitzer-Client
    const payload = {
      action: "openMinigame",
      actorUuid: actor.uuid,
      dc,
      bonus,
      userId: ownerUser.id
    };

    console.log(`${MODULE_ID} | Sending openMinigame`, payload);
    game.socket.emit(`module.${MODULE_ID}`, payload);
  }
}

/* ---------------------------------------- */
/* Minigame-Fenster                         */
/* ---------------------------------------- */

class LockpickingGameApp extends Application {
  constructor(actor, options) {
    super(options);
    this.actor = actor;
    this.dc = options.dc ?? 15;
    this.bonus = options.bonus ?? 0;

    // Minigame-Status
    this._running = false;
    this._position = 0;
    this._direction = 1;
    this._interval = null;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-game",
      title: "Schlossknacken",
      template: `modules/${MODULE_ID}/templates/lock-game.hbs`,
      width: 480,
      height: "auto",
      popOut: true,
      resizable: false
    });
  }

  getData() {
    return {
      actorName: this.actor?.name ?? "Unbekannt",
      dc: this.dc,
      bonus: this.bonus
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    const startBtn = html.find("[data-action='start']");
    const pickBtn = html.find("[data-action='pick']");
    const bar = html.find("[data-role='bar']");
    const marker = html.find("[data-role='marker']");

    if (!startBtn.length || !pickBtn.length || !bar.length || !marker.length) {
      console.warn(`${MODULE_ID} | Minigame-Elemente nicht gefunden.`);
      return;
    }

    const updateMarker = () => {
      const clamped = Math.max(0, Math.min(1, this._position));
      marker.css("left", (clamped * 100) + "%");
    };

    const stopGame = () => {
      if (this._interval) {
        clearInterval(this._interval);
        this._interval = null;
      }
      this._running = false;
      startBtn.prop("disabled", false);
      pickBtn.prop("disabled", !this._running);
    };

    startBtn.on("click", () => {
      if (this._running) return;

      this._running = true;
      this._position = 0;
      this._direction = 1;

      startBtn.prop("disabled", true);
      pickBtn.prop("disabled", false);

      const speed = 0.015; // Bewegungsgeschwindigkeit

      this._interval = setInterval(() => {
        this._position += speed * this._direction;
        if (this._position >= 1) {
          this._position = 1;
          this._direction = -1;
        } else if (this._position <= 0) {
          this._position = 0;
          this._direction = 1;
        }
        updateMarker();
      }, 16);
    });

    pickBtn.on("click", () => {
      if (!this._running) return;

      stopGame();

      // "Sweet Spot" liegt in der Mitte 0.45–0.55
      const diff = Math.abs(this._position - 0.5);
      let modifier = 0;

      if (diff < 0.05) modifier = 10;
      else if (diff < 0.1) modifier = 5;
      else if (diff < 0.2) modifier = 0;
      else modifier = -5;

      const roll = new Roll("1d20");
      roll.roll({ async: false });

      const total = roll.total + this.bonus + modifier;

      const success = total >= this.dc;

      const formatted = roll.render();

      ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
        content:
          `<p><strong>${this.actor.name}</strong> versucht das Schloss zu knacken.</p>` +
          `<p>Wurf: ${formatted} + Bonus (${this.bonus >= 0 ? "+" + this.bonus : this.bonus}) ` +
          `+ Modifikator (${modifier >= 0 ? "+" + modifier : modifier}) = <strong>${total}</strong></p>` +
          `<p>DC: ${this.dc} – ${success ? "<span style='color:green'>Erfolg!</span>" : "<span style='color:red'>Fehlschlag.</span>"}</p>`
      });

      this.close();
    });

    // Anfangsstatus
    pickBtn.prop("disabled", true);
    updateMarker();
  }

  close(options) {
    // Sicherheit: ggf. Intervall beenden
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    return super.close(options);
  }
}

/* ---------------------------------------- */
/* Globale API & Socket                     */
/* ---------------------------------------- */

function registerAPI() {
  const module = game.modules.get(MODULE_ID);
  if (!module) return;

  // API für Makros / andere Module
  module.api = {
    /**
     * Öffnet das Konfigurationsfenster (nur GM).
     */
    openConfig: () => {
      if (!game.user.isGM) {
        ui.notifications.info("Nur der Spielleiter kann das Lockpicking-Minispiel starten.");
        return;
      }
      const app = new LockpickingConfigApp();
      app.render(true);
    }
  };

  // Praktischer Kurzlink
  game.lockpickingMinigame = {
    openConfig: module.api.openConfig
  };
}

function registerSocketListener() {
  // Listener auf ALLEN Clients registrieren
  game.socket.on(`module.${MODULE_ID}`, async (data) => {
    if (!data || data.action !== "openMinigame") return;

    console.log(`${MODULE_ID} | socket received`, data, "on user", game.user.id);

    // Nur der adressierte User (oder GM-Fallback) reagiert
    if (data.userId && data.userId !== game.user.id) return;

    const actor = await fromUuid(data.actorUuid);
    if (!actor) {
      console.warn(`${MODULE_ID} | Actor not found for uuid`, data.actorUuid);
      return;
    }

    const app = new LockpickingGameApp(actor, {
      dc: data.dc,
      bonus: data.bonus
    });
    app.render(true);
  });
}

/* ---------------------------------------- */
/* Hooks                                    */
/* ---------------------------------------- */

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready, user=${game.user.id}, isGM=${game.user.isGM}`);

  registerAPI();
  registerSocketListener();
});
