// scripts/main.js

const MODULE_ID = "lockpicking-minigame";

/* ---------------------------------------- */
/*  Lockpicking Game App (Client-Seite)     */
/* ---------------------------------------- */

class LockpickingGameApp extends Application {
  constructor(actor, { dc, bonus } = {}) {
    super();
    this.actor = actor;
    this.dc = Number(dc) || 10;
    this.bonus = Number(bonus) || 0;

    // Werte für die "Bewegungsleiste"
    this.currentPos = 0;          // 0–100
    this.direction = 1;           // 1 oder -1
    this.intervalId = null;

    // Zielbereich
    this.targetStart = 30;        // Prozent
    this.targetWidth = 20;        // Prozent
  }

  static get defaultOptions() {
    const opts = super.defaultOptions;
    opts.id = "lockpicking-game";
    opts.title = game.i18n.localize("Lockpicking Minigame") || "Schlossknacken";
    opts.template = `modules/${MODULE_ID}/templates/lock-game.hbs`;
    opts.width = 500;
    opts.height = "auto";
    opts.resizable = false;
    return opts;
  }

  getData() {
    return {
      actor: this.actor,
      dc: this.dc,
      bonus: this.bonus,
      current: this.currentPos,
      targetStart: this.targetStart,
      targetWidth: this.targetWidth
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Buttons im Template: data-action="start" / "stop"
    const startBtn = html.find('[data-action="start"]');
    const stopBtn  = html.find('[data-action="stop"]');

    startBtn.on("click", () => this._onStart(html));
    stopBtn.on("click", () => this._onStop(html));
  }

  _onStart(html) {
    if (this.intervalId) return;

    const startBtn = html.find('[data-action="start"]');
    const stopBtn  = html.find('[data-action="stop"]');

    startBtn.prop("disabled", true);
    stopBtn.prop("disabled", false);

    const barFill = html.find(".lp-bar-fill");

    this.intervalId = setInterval(() => {
      this.currentPos += this.direction * 2;

      if (this.currentPos >= 100) {
        this.currentPos = 100;
        this.direction = -1;
      } else if (this.currentPos <= 0) {
        this.currentPos = 0;
        this.direction = 1;
      }

      if (barFill.length) {
        barFill.css("width", `${this.currentPos}%`);
      }
    }, 40);
  }

  async _onStop(html) {
    if (!this.intervalId) return;

    clearInterval(this.intervalId);
    this.intervalId = null;

    const startBtn = html.find('[data-action="start"]');
    const stopBtn  = html.find('[data-action="stop"]');

    startBtn.prop("disabled", false);
    stopBtn.prop("disabled", true);

    const inTarget =
      this.currentPos >= this.targetStart &&
      this.currentPos <= this.targetStart + this.targetWidth;

    const d20 = new Roll("1d20");
    await d20.evaluate({ async: true });
    const total = d20.total + this.bonus;
    const passed = inTarget && total >= this.dc;

    const flavor = passed
      ? `${this.actor.name} knackt das Schloss! (DC ${this.dc}, Ergebnis ${total}, Trefferzone: ${inTarget ? "ja" : "nein"})`
      : `${this.actor.name} scheitert am Schloss. (DC ${this.dc}, Ergebnis ${total}, Trefferzone: ${inTarget ? "ja" aber zu niedrig" : "verfehlt"})`;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      flavor,
      roll: d20,
      type: CONST.CHAT_MESSAGE_TYPES.ROLL
    });

    this.close();
  }

  close(options) {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    return super.close(options);
  }
}

/* ---------------------------------------- */
/*  Konfigurations-Dialog (nur GM)          */
/* ---------------------------------------- */

class LockpickingConfigApp extends FormApplication {
  static get defaultOptions() {
    const opts = super.defaultOptions;
    opts.id = "lockpicking-config";
    opts.title = "Schlossknacken";
    opts.template = `modules/${MODULE_ID}/templates/lock-config.hbs`;
    opts.width = 400;
    opts.height = "auto";
    return opts;
  }

  async getData() {
    const scene = game.scenes.current;
    const actors = [];

    if (scene) {
      for (const t of scene.tokens) {
        const actor = t.actor;
        if (!actor) continue;
        if (!actors.find(a => a.id === actor.id)) {
          actors.push({ id: actor.id, name: actor.name });
        }
      }
    }

    return {
      actors,
      defaultDc: 15
    };
  }

  async _updateObject(event, formData) {
    const actorId = formData.actorId;
    const dc = Number(formData.dc) || 10;

    if (!actorId) {
      ui.notifications.warn("Bitte einen Charakter auswählen.");
      return;
    }

    const actor = game.actors.get(actorId);
    if (!actor) {
      ui.notifications.error("Ausgewählter Actor nicht gefunden.");
      return;
    }

    // Bonus aus dem Actor ziehen (z. B. DEX-Mod)
    const dexMod = actor.system?.abilities?.dex?.mod ?? 0;
    const bonus = dexMod;

    // Ziel-Spieler bestimmen (nicht-GM Owner, falls vorhanden)
    let targetUser = null;
    for (const user of game.users) {
      if (user.isGM) continue;
      if (actor.testUserPermission(user, CONST.DOCUMENT_PERMISSION_LEVELS.OWNER)) {
        targetUser = user;
        break;
      }
    }

    const payload = {
      action: "openMinigame",
      actorId: actor.id,
      dc,
      bonus,
      userId: targetUser?.id ?? null
    };

    console.log(`${MODULE_ID} | config submit`, payload);

    // Wenn ein Spieler-Owner existiert → Socket an diesen Client
    if (targetUser) {
      game.socket.emit(`module.${MODULE_ID}`, payload);
      ui.notifications.info(
        `Lockpicking-Minispiel für ${actor.name} an ${targetUser.name} gesendet.`
      );
    } else {
      // sonst direkt beim GM lokal öffnen
      ui.notifications.info(
        `Kein Spieler-Besitzer gefunden – Minispiel wird lokal geöffnet.`
      );
      LockpickingMinigame.openMinigameLocal(actor, dc, bonus);
    }

    // kleine Chatmeldung
    ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `Lockpicking-Minispiel für ${actor.name} gestartet (DC ${dc}, Bonus ${bonus}).`
    });
  }
}

/* ---------------------------------------- */
/*  Einfaches API-Objekt für das Modul      */
/* ---------------------------------------- */

const LockpickingMinigame = {
  openConfig() {
    if (!game.user.isGM) {
      ui.notifications.warn("Nur der Spielleiter kann das Lockpicking-Minispiel konfigurieren.");
      return;
    }
    new LockpickingConfigApp().render(true);
  },

  openMinigameLocal(actor, dc, bonus) {
    const app = new LockpickingGameApp(actor, { dc, bonus });
    app.render(true);
  }
};

/* ---------------------------------------- */
/*  Hooks & Socket-Listener                 */
/* ---------------------------------------- */

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready on user`, game.user.id, "GM:", game.user.isGM);

  // Globale API bereitstellen
  game.lockpickingMinigame = LockpickingMinigame;

  // Socket-Listener **für alle Clients** registrieren
  game.socket.on(`module.${MODULE_ID}`, (data) => {
    if (!data || data.action !== "openMinigame") return;

    console.log(
      `${MODULE_ID} | socket received on user`,
      game.user.id,
      "payload:",
      data
    );

    // Wenn eine userId angegeben ist, nur für diesen Client reagieren
    if (data.userId && data.userId !== game.user.id) return;

    const actor = game.actors.get(data.actorId);
    if (!actor) {
      console.warn(`${MODULE_ID} | Actor not found on client`, data.actorId);
      return;
    }

    LockpickingMinigame.openMinigameLocal(actor, data.dc, data.bonus);
  });
});

/* ---------------------------------------- */
/*  Für Makros bequem zugänglich machen     */
/* ---------------------------------------- */
// Beispiel-Makro-Code:
//
// game.lockpickingMinigame.openConfig();
