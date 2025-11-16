/**
 * Lockpicking Minigame - main.js
 * Foundry VTT v11, dnd5e
 */

/* ----------------------------------------- */
/*  Hooks                                    */
/* ----------------------------------------- */

Hooks.once("init", () => {
  console.log("lockpicking-minigame | init");
});

Hooks.once("ready", () => {
  console.log("lockpicking-minigame | ready");

  // Kleiner Namespace für Makros usw.
  game.lockpickingMinigame = {
    openConfig() {
      if (!game.user.isGM) {
        ui.notifications.warn("Nur der Spielleiter kann das Lockpicking-Konfigurationsfenster öffnen.");
        return;
      }
      new LockpickingConfigApp().render(true);
    }
  };

  // Reagiere auf Chat-Nachrichten des Moduls
  Hooks.on("createChatMessage", (message) => {
    const data = message.flags?.["lockpicking-minigame"];
    if (!data) return;

    // Nur der adressierte User öffnet das Minigame
    if (game.user.id !== data.userId) return;

    const actor = game.actors.get(data.actorId);
    if (!actor) {
      console.warn("lockpicking-minigame | Actor nicht gefunden:", data.actorId);
      return;
    }

    new LockpickingGameApp(actor, data).render(true);
  });
});

/* ----------------------------------------- */
/*  Konfigurations-Fenster (GM)              */
/* ----------------------------------------- */

class LockpickingConfigApp extends FormApplication {
  static get defaultOptions() {
    const options = super.defaultOptions;
    options.id = "lockpicking-config";
    options.title = "Schlossknacken";
    options.template = "modules/lockpicking-minigame/templates/lock-config.hbs";
    options.width = 420;
    options.height = "auto";
    options.classes = ["lockpicking-config"];
    return options;
  }

  /** Daten für das Template */
  getData(options) {
    // alle aktiven Nicht-GM-User
    const activeUsers = game.users.contents
      .filter((u) => u.active && !u.isGM)
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

    const groups = [];

    for (const user of activeUsers) {
      // alle Charakter-Actors, die der User besitzt
      const ownedActors = game.actors.contents
        .filter(
          (a) =>
            a.type === "character" &&
            a.testUserPermission(user, "OWNER")
        )
        .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));

      if (!ownedActors.length) continue;

      groups.push({
        userId: user.id,
        userName: user.name,
        options: ownedActors.map((actor) => ({
          actorId: actor.id,
          actorName: actor.name
        }))
      });
    }

    if (!groups.length) {
      ui.notifications.warn(
        "Es wurden keine Charaktere aktiver Spieler mit Besitzrechten gefunden."
      );
    }

    return {
      groups,
      defaultDc: 15
    };
  }

  /** Formular-Submit */
  async _updateObject(event, formData) {
    const selection = formData.selection;
    const dc = Number(formData.dc) || 15;

    if (!selection) {
      ui.notifications.error("Bitte einen Charakter auswählen.");
      return;
    }

    const [actorId, userId] = selection.split("|");
    const user = game.users.get(userId);
    const actor = game.actors.get(actorId);

    if (!user || !actor) {
      ui.notifications.error("Ausgewählter Spieler oder Charakter wurde nicht gefunden.");
      console.warn("lockpicking-minigame | Auswahl fehlerhaft:", {
        selection,
        user,
        actor
      });
      return;
    }

    /* ----------------- Diebeswerkzeug prüfen ----------------- */

    const thievesTools = actor.items.find((it) => {
      const name = (it.name ?? "").toLowerCase();
      const type = getProperty(it, "system.type.value") ?? "";
      return (
        it.type === "tool" &&
        (
          name.includes("diebes") ||      // „Diebeswerkzeug“
          name.includes("thieves") ||     // „Thieves' Tools“
          type === "thievesTools" ||
          type === "thief"
        )
      );
    });

    if (!thievesTools) {
      ui.notifications.warn(
        `${actor.name} besitzt keine Diebeswerkzeuge – Schlossknacken nicht möglich.`
      );
      return;
    }

    // Grundwerte
    const dexMod = getProperty(actor, "system.abilities.dex.mod") ?? 0;
    const profBonus = getProperty(actor, "system.attributes.prof") ?? 0;
    const proficient = getProperty(thievesTools, "system.proficient") ?? 0;

    // dnd5e: 0 = keine, 1 = halb, 2 = prof., 3 = Expertise
    let bonus = dexMod;
    let disadvantage = true;

    if (proficient >= 2) {
      // geübt → Geschick + Übungsbonus, kein Nachteil
      bonus = dexMod + profBonus;
      disadvantage = false;
    } else {
      // ungeübt → nur Geschick, mit Nachteil
      bonus = dexMod;
      disadvantage = true;
    }

    /* ----------------- Chat-Nachricht + Flag ------------------ */

    const content =
      `Lockpicking-Minispiel für <b>${actor.name}</b> gestartet ` +
      `(DC ${dc}, Bonus ${bonus}${disadvantage ? ", mit Nachteil" : ""}).`;

    await ChatMessage.create({
      content,
      speaker: { alias: "Lockpicking" },
      flags: {
        "lockpicking-minigame": {
          action: "openGame",
          userId,
          actorId,
          dc,
          bonus,
          disadvantage
        }
      }
    });
  }
}

/* ----------------------------------------- */
/*  Minigame-Fenster (Spieler)               */
/* ----------------------------------------- */

class LockpickingGameApp extends Application {
  constructor(actor, config, options = {}) {
    super(options);
    this.actor = actor;
    this.config = config; // { dc, bonus, disadvantage, ... }
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-game",
      classes: ["lockpicking-game"],
      title: "Lockpicking",
      template: "modules/lockpicking-minigame/templates/lock-game.hbs",
      width: 420,
      height: "auto",
      resizable: false
    });
  }

  getData(options) {
    return {
      actorName: this.actor.name,
      dc: this.config.dc,
      bonus: this.config.bonus,
      disadvantage: this.config.disadvantage
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find('[data-action="start"]').on("click", this._onStart.bind(this));
    html.find('[data-action="close"]').on("click", (ev) => {
      ev.preventDefault();
      this.close();
    });
  }

  /**
   * Aktuell: einfacher Wurf als Platzhalter.
   * Später können wir hier den animierten Balken einbauen.
   */
  async _onStart(event) {
    event.preventDefault();

    const { dc, bonus, disadvantage } = this.config;

    // 1 oder 2 Würfe je nach Nachteil
    const roll1 = await new Roll(`1d20 + ${bonus}`).evaluate({ async: true });
    let finalRoll = roll1;
    let details = `Wurf: ${roll1.total}`;

    if (disadvantage) {
      const roll2 = await new Roll(`1d20 + ${bonus}`).evaluate({ async: true });
      finalRoll = roll1.total <= roll2.total ? roll1 : roll2;
      details = `Würfe: ${roll1.total} und ${roll2.total} (Nachteil → niedrigeren genommen)`;
    }

    const success = finalRoll.total >= dc;

    await finalRoll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      flavor:
        `Lockpicking-Versuch gegen DC ${dc} ` +
        `(${disadvantage ? "mit Nachteil" : "normal"}).<br>${details}`
    });

    ui.notifications[success ? "info" : "warn"](
      success
        ? "Du knackst das Schloss!"
        : "Das Schloss widersteht deinem Versuch."
    );

    this.close();
  }
}
