// scripts/main.js
// ----------------------------------------------------
// Einfaches Lockpicking-Minispiel-Grundgerüst
// Modul-ID: "lockpicking-minigame"
// ----------------------------------------------------

const MODULE_ID = "lockpicking-minigame";

// Kurz-Referenzen auf die Application-API (Foundry V11)
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/* ------------------------------------ */
/*  Konfig-Dialog (GM)                  */
/* ------------------------------------ */

class LockpickingConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "lockpicking-config",
    title: "Schlossknacken",
    width: 420,
    height: "auto",
    window: {
      resizable: true
    },
    classes: ["lockpicking-minigame", "lockpicking-config"],
    position: {
      left: 120,
      top: 120
    }
  };

  static PARTS = {
    content: {
      template: `modules/${MODULE_ID}/templates/lock-config.hbs`
    }
  };

  /** Daten für das Template */
  async _prepareContext(_options) {
    // Alle Actoren, die von Spielern kontrolliert werden
    const actors = game.actors.contents.filter(a => a.hasPlayerOwner);

    return {
      actors: actors.map(a => ({ id: a.id, name: a.name })),
      actorId: actors[0]?.id ?? "",
      dc: 15,
      bonus: 0
    };
  }

  /** Listener für Submit-Button etc. */
  activateListeners(html) {
    super.activateListeners(html);

    const root = html[0] ?? html;

    // Foundry packt den Inhalt in ein <form> – das suchen wir
    const form =
      root.closest("form") || root.querySelector("form") || root.parentElement;

    if (form) {
      form.addEventListener("submit", this._onSubmit.bind(this));
    } else {
      console.warn(MODULE_ID, "| Kein Formular im Config-Dialog gefunden.");
    }
  }

  /** Formular-Submit: Lockpicking starten */
  async _onSubmit(event) {
    event.preventDefault();

    const form = event.currentTarget;
    const formData = new FormData(form);

    const actorId = formData.get("actorId");
    const dc = Number(formData.get("dc")) || 10;
    const bonus = Number(formData.get("bonus")) || 0;

    const actor = game.actors.get(actorId);

    if (!actor) {
      ui.notifications.error("Lockpicking: Actor nicht gefunden.");
      return;
    }

    // passenden Spieler für den Actor finden
    let targetUser = game.users.players.find(u =>
      actor.testUserPermission(u, "OWNER")
    );
    if (!targetUser) targetUser = game.user;

    const payload = {
      action: "openGame",
      actorId,
      dc,
      bonus,
      userId: targetUser.id
    };

    console.log(MODULE_ID, "| config submit payload:", payload);

    // einfache Chat-Nachricht für alle
    const msg = `<b>Lockpicking</b>: ${actor.name} versucht ein Schloss zu knacken. (DC ${dc}, Bonus ${
      bonus >= 0 ? "+" + bonus : bonus
    })`;
    ChatMessage.create({ content: msg });

    // Socket-Ereignis an alle Clients schicken
    game.socket.emit(`module.${MODULE_ID}`, payload);

    // Dialog schließen
    this.close();
  }
}

/* ------------------------------------ */
/*  Spiel-Dialog (Spieler)              */
/* ------------------------------------ */

class LockpickingGameApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actor, dc, bonus, options = {}) {
    super(options);
    this.actor = actor;
    this.dc = dc;
    this.bonus = bonus;
  }

  static DEFAULT_OPTIONS = {
    id: "lockpicking-game",
    title: "Lockpicking",
    width: 420,
    height: "auto",
    window: {
      resizable: true
    },
    classes: ["lockpicking-minigame", "lockpicking-game"],
    position: {
      left: 160,
      top: 160
    }
  };

  static PARTS = {
    content: {
      template: `modules/${MODULE_ID}/templates/lock-game.hbs`
    }
  };

  async _prepareContext(_options) {
    return {
      actorName: this.actor?.name ?? "Unbekannt",
      dc: this.dc,
      bonus: this.bonus
    };
  }

  /** Buttons im Spiel-Dialog */
  activateListeners(html) {
    super.activateListeners(html);
    const root = html[0] ?? html;

    const startBtn = root.querySelector('[data-action="start"]');
    const closeBtn = root.querySelector('[data-action="close"]');

    if (startBtn) {
      startBtn.addEventListener("click", ev => {
        ev.preventDefault();
        ui.notifications.info(
          "Lockpicking: Hier kommt später das eigentliche Minispiel hin."
        );
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener("click", ev => {
        ev.preventDefault();
        this.close();
      });
    }
  }
}

/* ------------------------------------ */
/*  Hooks                               */
/* ------------------------------------ */

Hooks.once("init", () => {
  console.log(MODULE_ID, "| init");
});

Hooks.once("ready", () => {
  console.log(
    MODULE_ID,
    "| ready auf Client",
    game.user.id,
    "isGM:",
    game.user.isGM
  );

  // Socket-Listener auf JEDEM Client registrieren
  game.socket.on(`module.${MODULE_ID}`, data => {
    console.log(MODULE_ID, "| socket received auf", game.user.id, ":", data);

    if (!data || data.action !== "openGame") return;
    if (data.userId !== game.user.id) return; // nur adressierter User

    const actor = game.actors.get(data.actorId);
    if (!actor) {
      ui.notifications.error("Lockpicking: Actor für Minispiel nicht gefunden.");
      return;
    }

    const app = new LockpickingGameApp(actor, data.dc, data.bonus);
    app.render(true);
  });

  // Globale API für Makros
  game.lockpickingMinigame = {
    openConfig: () => {
      new LockpickingConfigApp().render(true);
    }
  };

  console.log(
    MODULE_ID,
    "| API registriert: game.lockpickingMinigame.openConfig()"
  );
});
