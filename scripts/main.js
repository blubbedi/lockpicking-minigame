// scripts/main.js
// Lockpicking-Minispiel für Foundry VTT
// Modul-ID muss mit module.json übereinstimmen:
const MODULE_ID = "lockpicking-minigame";

/* ----------------------------------------- */
/*  Konfigurations-Dialog (nur GM)          */
/* ----------------------------------------- */

class LockpickingConfigApp extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-config",
      title: "Schlossknacken",
      template: `modules/${MODULE_ID}/templates/lock-config.hbs`,
      width: 480,
      height: "auto",
      closeOnSubmit: true
    });
  }

  /** Daten für das Template */
  getData(options) {
    // alle Actoren mit Spieler-Owner
    const actors = game.actors
      ?.filter(a => a.hasPlayerOwner)
      .map(a => ({ id: a.id, name: a.name })) ?? [];

    return {
      actors,
      actorId: actors[0]?.id ?? "",
      dc: 15,
      bonus: 0
    };
  }

  /** Wird beim Klick auf "Lockpicking starten" ausgelöst */
  async _updateObject(event, formData) {
    event.preventDefault();

    // Versuch, verschiedene mögliche Feldnamen abzudecken
    const actorId = formData.actorId || formData.actor || formData.character;
    const dc = Number(formData.dc) || 10;
    const bonus = Number(formData.bonus) || 0;

    const actor = game.actors.get(actorId);
    if (!actor) {
      ui.notifications.error("Kein gültiger Charakter ausgewählt.");
      return;
    }

    // passenden Spieler finden (Owner des Actors, der gerade online ist)
    let targetUser = game.users.players.find(
      u => u.active && actor.testUserPermission(u, "OWNER")
    );

    // Fallback: wenn keiner online ist, landet es beim GM selbst
    if (!targetUser) targetUser = game.user;

    const payload = {
      action: "openMinigame",
      actorId: actor.id,
      dc,
      bonus,
      userId: targetUser.id
    };

    console.log(`${MODULE_ID} | config submit`, payload);

    // Socket-Nachricht an alle Clients
    game.socket.emit(`module.${MODULE_ID}`, payload);

    // Chat-Nachricht zur Doku
    const bonusLabel = bonus >= 0 ? `+${bonus}` : `${bonus}`;
    ChatMessage.create({
      speaker: { alias: "Lockpicking" },
      content: `Lockpicking-Minispiel für <b>${actor.name}</b> gestartet (DC ${dc}, Bonus ${bonusLabel}).`
    });
  }
}

/* ----------------------------------------- */
/*  Lockpicking-Minispiel (Spieler)         */
/* ----------------------------------------- */

class LockpickingGameApp extends Application {
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.dc = options.dc ?? 10;
    this.bonus = options.bonus ?? 0;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-game",
      title: "Schlossknacken",
      template: `modules/${MODULE_ID}/templates/lock-game.hbs`,
      width: 520,
      height: "auto",
      resizable: true
    });
  }

  /** Daten fürs Minigame-Template */
  getData(options) {
    return {
      actorName: this.actor?.name ?? "Unbekannt",
      dc: this.dc,
      bonus: this.bonus
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Du kannst hier deine echte Minigame-Logik einbauen.
    // Zum Test reicht ein einfacher Button.

    html.find("[data-action='start']").on("click", ev => {
      ev.preventDefault();
      ui.notifications.info(
        `Lockpicking-Versuch für ${this.actor?.name ?? "?"} gestartet (DC ${this.dc}, Bonus ${this.bonus >= 0 ? "+" + this.bonus : this.bonus}).`
      );
    });

    html.find("[data-action='close']").on("click", ev => {
      ev.preventDefault();
      this.close();
    });
  }
}

/* ----------------------------------------- */
/*  Öffnen des Konfig-Dialogs (Makro)       */
/* ----------------------------------------- */

function openLockpickingConfig() {
  if (!game.user.isGM) {
    ui.notifications.warn("Nur der Spielleiter kann das Lockpicking-Minispiel starten.");
    return;
  }

  new LockpickingConfigApp().render(true);
}

/* ----------------------------------------- */
/*  Initialisierung und Socket-Listener     */
/* ----------------------------------------- */

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready on user`, game.user.id);

  // Globales Objekt, damit dein Makro einfach ist:
  // Makro-Inhalt:  game.lockpickingMinigame.openConfig();
  game.lockpickingMinigame = {
    openConfig: openLockpickingConfig
  };

  // WICHTIG: Dieser Listener läuft auf **allen** Clients,
  // NICHT nur beim GM, sonst sieht der Spieler nichts!
  game.socket.on(`module.${MODULE_ID}`, data => {
    console.log(`${MODULE_ID} | socket received on`, game.user.id, data);

    if (!data || data.action !== "openMinigame") return;

    // Nur der adressierte User reagiert
    if (data.userId !== game.user.id) return;

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
