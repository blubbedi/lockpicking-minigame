// scripts/main.js

// Kleines Namenskürzel für Konsolen-Logs
const MODULE_ID = "lockpicking-minigame";

/* ---------------------------------------- */
/*   Hilfsfunktionen                        */
/* ---------------------------------------- */

/**
 * Finde den User, der den Actor kontrolliert.
 * - zuerst: aktiver Spieler mit OWNER-Rechten
 * - Fallback: ein GM
 */
function findControllingUserId(actor) {
  // 1) aktiver Spieler mit Owner-Rechten
  for (const user of game.users.contents) {
    if (!user.active || user.isGM) continue;
    if (actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) {
      return user.id;
    }
  }

  // 2) irgendein GM
  const gm = game.users.find(u => u.isGM);
  if (gm) return gm.id;

  // 3) Fallback: aktueller User
  return game.user.id;
}

/* ---------------------------------------- */
/*   Konfigurations-Dialog (GM)             */
/* ---------------------------------------- */

class LockpickingConfigApp extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-config",
      title: "Schlossknacken",
      template: "modules/lockpicking-minigame/templates/lock-config.hbs",
      width: 400,
      height: "auto",
      closeOnSubmit: true
    });
  }

  /** Daten für das Template */
  getData(options = {}) {
    // Alle Token-Actor, die von Spielern kontrolliert werden
    const actors = canvas.tokens.placeables
      .map(t => t.actor)
      .filter(a => !!a)
      .filter((a, i, arr) => arr.findIndex(x => x.id === a.id) === i) // unique
      .map(a => ({
        id: a.id,
        name: a.name
      }));

    const actorId = actors[0]?.id ?? null;

    return {
      actors,
      actorId,
      dc: 15,
      bonus: 0
    };
  }

  /** Form-Submit */
  async _updateObject(event, formData) {
    // formData kommt als Objekt: { actorId, dc, bonus }
    const actorId = formData.actorId;
    const dc = Number(formData.dc) || 0;
    const bonus = Number(formData.bonus) || 0;

    const actor = game.actors.get(actorId);
    if (!actor) {
      ui.notifications.error("Ausgewählter Charakter wurde nicht gefunden.");
      return;
    }

    const userId = findControllingUserId(actor);

    console.log(
      `${MODULE_ID} | config submit`,
      { actorId, dc, bonus, userId }
    );

    // Chat-Nachricht für alle
    const content = `Lockpicking-Minispiel für <b>${actor.name}</b> gestartet (DC ${dc}, Bonus ${bonus >= 0 ? "+" : ""}${bonus}).`;
    await ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor })
    });

    // Socket-Nachricht an den kontrollierenden Spieler
    game.socket.emit(`module.${MODULE_ID}`, {
      action: "openGame",
      userId,
      actorId,
      dc,
      bonus
    });
  }
}

/* ---------------------------------------- */
/*   Spiel-Dialog (Player)                  */
/* ---------------------------------------- */

class LockpickingGameApp extends Application {
  constructor(data, options = {}) {
    super(options);
    this._lpData = data; // { actorId, dc, bonus }
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-game",
      title: "Lockpicking",
      template: "modules/lockpicking-minigame/templates/lock-game.hbs",
      width: 400,
      height: "auto",
      resizable: true
    });
  }

  getData(options = {}) {
    const actor = game.actors.get(this._lpData.actorId);
    return {
      actorName: actor?.name ?? "Unbekannt",
      dc: this._lpData.dc,
      bonus: this._lpData.bonus
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find('[data-action="start"]').on("click", ev => {
      ev.preventDefault();
      ui.notifications.info("Hier könnte dein eigentliches Minispiel starten. :)");
    });

    html.find('[data-action="close"]').on("click", ev => {
      ev.preventDefault();
      this.close();
    });
  }
}

/* ---------------------------------------- */
/*   Hooks                                  */
/* ---------------------------------------- */

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready on user`, game.user.id);

  // API für Makros & andere Module
  game.lockpickingMinigame = {
    openConfig() {
      if (!game.user.isGM) {
        return ui.notifications.error("Nur der SL kann das Lockpicking-Konfigurationsfenster öffnen.");
      }
      new LockpickingConfigApp().render(true);
    }
  };

  // Socket-Listener: nur der gemeinte User reagiert
  game.socket.on(`module.${MODULE_ID}`, data => {
    if (!data || data.action !== "openGame") return;
    if (data.userId !== game.user.id) return;

    console.log(`${MODULE_ID} | socket received on`, game.user.id, data);
    new LockpickingGameApp(data).render(true);
  });
});
