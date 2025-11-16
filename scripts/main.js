// modules/lockpicking-minigame/scripts/main.js

const MODULE_ID = "lockpicking-minigame";

/* ----------------------------------------- */
/*  Lockpicking-Konfig-Dialog (GM-Seite)    */
/* ----------------------------------------- */

class LockpickingConfigApp extends FormApplication {
  static get defaultOptions() {
    return mergeObject(super.defaultOptions, {
      id: "lockpicking-config",
      title: "Schlossknacken",
      template: `modules/${MODULE_ID}/templates/lock-config.hbs`,
      width: 400,
      closeOnSubmit: true
    });
  }

  /** Daten für das Template */
  getData(options = {}) {
    // Alle Akteure, die einem Spieler gehören
    const actors = game.actors.contents.filter(a => a.hasPlayerOwner);

    return {
      actors,
      actorId: this.actorId ?? actors[0]?.id ?? "",
      dc: this.dc ?? 15,
      bonus: this.bonus ?? 0
    };
  }

  /** Wird aufgerufen, wenn der GM auf "Lockpicking starten" klickt */
  async _updateObject(event, formData) {
    event.preventDefault();

    const actorId = formData.actorId;
    const dc = Number(formData.dc) || 0;
    const bonus = Number(formData.bonus) || 0;

    const actor = game.actors.get(actorId);
    if (!actor) {
      ui.notifications.error("Lockpicking: Gewählter Charakter wurde nicht gefunden.");
      console.warn(`${MODULE_ID} | Actor not found`, { actorId, formData });
      return;
    }

    // Versuchen, den zugehörigen Spieler zu finden
    const playerUser =
      game.users.players.find(u => u.character?.id === actorId) ??
      game.users.find(u => u.isGM && u.active); // Fallback: ein aktiver GM

    if (!playerUser) {
      ui.notifications.warn("Lockpicking: Kein Spieler für diesen Charakter gefunden.");
      console.warn(`${MODULE_ID} | No player user for actor`, { actorId, actor });
      return;
    }

    const payload = {
      action: "openGame",
      userId: playerUser.id,
      actorId,
      dc,
      bonus
    };

    console.log(`${MODULE_ID} | Config submit`, payload);

    // Nachricht in den Chat für alle
    ChatMessage.create({
      speaker: { alias: "Lockpicking" },
      content: `Lockpicking-Minispiel für <b>${actor.name}</b> gestartet (DC ${dc}, Bonus ${bonus}).`
    });

    // Socket an alle Clients schicken
    game.socket.emit(`module.${MODULE_ID}`, payload);
  }
}

/* ----------------------------------------- */
/*  Lockpicking-Spiel-Dialog (Spieler)      */
/* ----------------------------------------- */

class LockpickingGameApp extends Application {
  constructor(actor, dc, bonus, options = {}) {
    super(options);
    this.actor = actor;
    this.dc = dc;
    this.bonus = bonus;
  }

  static get defaultOptions() {
    return mergeObject(super.defaultOptions, {
      id: "lockpicking-game",
      title: "Lockpicking",
      template: `modules/${MODULE_ID}/templates/lock-game.hbs`,
      width: 400,
      height: "auto"
    });
  }

  /** Daten für das Template */
  getData(options = {}) {
    return {
      actorName: this.actor?.name ?? "Unbekannt",
      dc: this.dc,
      bonus: this.bonus
    };
  }

  /** Listener für Buttons im Template */
  activateListeners(html) {
    super.activateListeners(html);

    html.find("button[data-action='start']").on("click", this._onStart.bind(this));
    html.find("button[data-action='close']").on("click", () => this.close());
  }

  /** Platzhalter für das eigentliche Minispiel */
  async _onStart(event) {
    event.preventDefault();

    const msg = `${this.actor.name} versucht das Schloss zu knacken! (DC ${this.dc}, Bonus ${this.bonus})`;
    ui.notifications.info(msg);

    // Einfache Chat-Nachricht, damit GM & Spieler was sehen
    ChatMessage.create({
      speaker: { actor: this.actor },
      content: msg
    });

    // Hier später dein echtes Minispiel einbauen
    // z.B. eigenes Canvas, Progressbar, Würfelwurf etc.

    this.close();
  }
}

/* ----------------------------------------- */
/*  Socket-Handler                           */
/* ----------------------------------------- */

function handleSocketMessage(data) {
  if (!data || typeof data !== "object") return;
  if (data.action !== "openGame") return;

  console.log(`${MODULE_ID} | Socket-Nachricht empfangen`, data);

  // Nur der adressierte User reagiert
  if (game.user.id !== data.userId) return;

  const actor = game.actors.get(data.actorId);
  if (!actor) {
    console.warn(`${MODULE_ID} | Actor not found on client`, data.actorId);
    ui.notifications.warn("Lockpicking: Der Charakter für dieses Minispiel wurde nicht gefunden.");
    return;
  }

  const app = new LockpickingGameApp(actor, data.dc, data.bonus);
  app.render(true);
}

/* ----------------------------------------- */
/*  Hooks                                   */
/* ----------------------------------------- */

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready, current user:`, game.user?.id);

  // Socket registrieren
  game.socket.on(`module.${MODULE_ID}`, handleSocketMessage);

  // Globales API-Objekt, damit du Makros schreiben kannst
  game.lockpickingMinigame = {
    openConfig: () => {
      if (!game.user.isGM) {
        ui.notifications.warn("Nur der GM kann das Lockpicking-Minispiel starten.");
        return;
      }
      new LockpickingConfigApp().render(true);
    },

    // Kleiner Test, um zu prüfen, ob das Modul geladen ist
    ping: () => {
      ui.notifications.info("Lockpicking-Minispiel ist geladen.");
      console.log(`${MODULE_ID} | ping von`, game.user?.id);
    },

    // Socket-Testfunktion (optional)
    sendTest: () => {
      const payload = {
        action: "openGame",
        userId: game.user.id,
        actorId: game.actors.contents[0]?.id ?? null,
        dc: 10,
        bonus: 0
      };
      console.log(`${MODULE_ID} | sendTest`, payload);
      game.socket.emit(`module.${MODULE_ID}`, payload);
    }
  };

  // Optional: globale Hilfsfunktion für Makros im Browser-Fenster
  window.openLockpickingConfig = () => game.lockpickingMinigame.openConfig();

  console.log(`${MODULE_ID} | Socket registriert für`, `module.${MODULE_ID}`);
});
