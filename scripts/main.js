// scripts/main.js

const MODULE_ID = "lockpicking-minigame";

/* ---------------------------------------- */
/*   Hilfsfunktion: passenden User finden   */
/* ---------------------------------------- */

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

  getData(options = {}) {
    // alle sichtbaren Token-Actor, unique
    const actors = canvas.tokens.placeables
      .map(t => t.actor)
      .filter(a => !!a)
      .filter((a, i, arr) => arr.findIndex(x => x.id === a.id) === i)
      .map(a => ({ id: a.id, name: a.name }));

    const actorId = actors[0]?.id ?? null;

    return {
      actors,
      actorId,
      dc: 15,
      bonus: 0
    };
  }

  async _updateObject(event, formData) {
    const actorId = formData.actorId;
    const dc = Number(formData.dc) || 0;
    const bonus = Number(formData.bonus) || 0;

    const actor = game.actors.get(actorId);
    if (!actor) {
      ui.notifications.error("Ausgewählter Charakter wurde nicht gefunden.");
      return;
    }

    const userId = findControllingUserId(actor);

    const data = { actorId, dc, bonus, userId };

    console.log(`${MODULE_ID} | config submit`, data);

    const content = `Lockpicking-Minispiel für <b>${actor.name}</b> gestartet (DC ${dc}, Bonus ${bonus >= 0 ? "+" : ""}${bonus}).`;

    // eine Chat-Nachricht für alle, aber mit versteckten Daten im Flag
    await ChatMessage.create({
      content,
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: {
        [MODULE_ID]: {
          gameData: data
        }
      }
    });
  }
}

/* ---------------------------------------- */
/*   Spiel-Dialog (Player)                  */
/* ---------------------------------------- */

class LockpickingGameApp extends Application {
  constructor(lpData, options = {}) {
    super(options);
    this._lpData = lpData;  // { actorId, dc, bonus, userId }
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
  console.log(`${MODULE_ID} | ready auf User`, game.user.id);

  // API für Makros
  game.lockpickingMinigame = {
    openConfig() {
      if (!game.user.isGM) {
        return ui.notifications.error("Nur der SL kann das Lockpicking-Konfigurationsfenster öffnen.");
      }
      new LockpickingConfigApp().render(true);
    }
  };

  // Sobald eine Chat-Nachricht gerendert wird, prüfen wir auf unser Flag
  Hooks.on("renderChatMessage", (message, html, data) => {
    const gameData = message.getFlag(MODULE_ID, "gameData");
    if (!gameData) return;

    console.log(`${MODULE_ID} | renderChatMessage`, {
      currentUser: game.user.id,
      gameData
    });

    // Nur der adressierte Spieler (userId) öffnet das Fenster
    if (gameData.userId !== game.user.id) return;

    new LockpickingGameApp(gameData).render(true);
  });
});
