console.log("Lockpicking | Modul geladen");

/* ============================================
 * SOCKET REGISTRIEREN
 * ============================================ */
let lockpickingSocket;

Hooks.once("socketlib.ready", () => {
  lockpickingSocket = socketlib.registerModule("lockpicking-minigame");

  // Spieler empfängt Spielstart
  lockpickingSocket.register("openGame", (data) => {
    console.log("Lockpicking | Spieler empfängt Spielstart:", data);
    ui.notifications.info("Ein Lockpicking-Minispiel wurde gestartet.");
    new LockpickingGameApp(data).render(true);
  });
});

/* ============================================
 * GM CONFIG DIALOG
 * ============================================ */
class LockpickingConfigApp extends Application {
  static get defaultOptions() {
    return {
      id: "lockpicking-config",
      title: "Schlossknacken",
      template: "modules/lockpicking-minigame/templates/lock-config.hbs",
      width: 400,
      height: "auto",
    };
  }

  getData() {
    return {
      actors: game.actors.contents,
      actorId: this.actorId ?? "",
      dc: this.dc ?? 15,
      bonus: this.bonus ?? 0
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("form").on("submit", (ev) => {
      ev.preventDefault();

      const fd = new FormData(ev.target);
      const actorId = fd.get("actorId");
      const dc = Number(fd.get("dc"));
      const bonus = Number(fd.get("bonus"));

      const actor = game.actors.get(actorId);
      if (!actor) return ui.notifications.error("Ungültiger Actor!");

      console.log("Lockpicking | GM startet Minispiel für:", actorId);

      // Socket an Spieler senden
      lockpickingSocket.executeForPlayer(
        actor?.permission?.default ?? 0,
        "openGame",
        {
          actorId,
          actorName: actor.name,
          dc,
          bonus,
          userId: actor.ownership.default
        }
      );

      // Zusätzlich Chatnachricht
      ChatMessage.create({
        content: `🔐 Lockpicking-Minispiel für <b>${actor.name}</b> gestartet. (DC ${dc}, Bonus ${bonus})`
      });

      this.close();
    });
  }
}

/* ============================================
 * SPIELER-DIALOG
 * ============================================ */
class LockpickingGameApp extends Application {
  constructor(data) {
    super();
    this.data = data;
  }

  static get defaultOptions() {
    return {
      id: "lockpicking-game",
      title: "Lockpicking",
      template: "modules/lockpicking-minigame/templates/lock-game.hbs",
      width: 400,
      height: "auto"
    };
  }

  getData() {
    return this.data;
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("[data-action=start]").click(() => {
      ui.notifications.info("Bewegung starten / Testknacken (noch Dummy)");
    });

    html.find("[data-action=close]").click(() => {
      this.close();
    });
  }
}

/* ============================================
 * MAKRO-FUNKTION
 * ============================================ */
game.lockpicking = {
  openConfig: () => {
    new LockpickingConfigApp().render(true);
  }
};
