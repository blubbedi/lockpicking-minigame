// scripts/main.js

const MODULE_ID = "lockpicking-minigame";

/**
 * Kleines Hilfs-Log
 */
function log(...args) {
  console.log(`${MODULE_ID} |`, ...args);
}

function warn(...args) {
  console.warn(`${MODULE_ID} |`, ...args);
}

/* ---------------------------------------- */
/*  Lockpicking Game Application (Spieler)  */
/* ---------------------------------------- */

class LockpickingGameApp extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-game",
      title: "Lockpicking",
      template: `modules/${MODULE_ID}/templates/lock-game.hbs`,
      width: 420,
      height: "auto",
      resizable: false,
      popOut: true
    });
  }

  /**
   * @param {Actor} actor
   * @param {number} dc
   * @param {number} bonus
   */
  constructor(actor, dc, bonus) {
    super();
    this.actor = actor;
    this.dc = Number(dc) || 10;
    this.bonus = Number(bonus) || 0;

    // Minispiel-Zustand
    this._value = 0;       // 0–100
    this._direction = 1;   // 1 vorwärts, -1 rückwärts
    this._interval = null;
  }

  getData(options) {
    const data = super.getData(options);
    return foundry.utils.mergeObject(data, {
      actorName: this.actor?.name ?? "Unbekannt",
      dc: this.dc,
      bonus: this.bonus
    });
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Buttons im Template:
    // - [data-action="start"]
    // - [data-action="stop"]
    const btnStart = html.find('[data-action="start"]');
    const btnStop = html.find('[data-action="stop"]');
    const bar = html.find(".lockpicking-bar-fill");

    if (!bar.length) {
      warn("lock-game.hbs hat kein Element mit .lockpicking-bar-fill – Fortschrittsbalken deaktiviert.");
    }

    btnStart.on("click", () => {
      this._startMovement(bar);
    });

    btnStop.on("click", () => {
      this._stopMovement();
      this._resolveCheck(bar);
    });
  }

  _startMovement(bar) {
    if (this._interval) return;

    this._value = 0;
    this._direction = 1;
    this._updateBar(bar);

    this._interval = setInterval(() => {
      this._value += this._direction * 3; // Geschwindigkeit anpassen

      if (this._value >= 100) {
        this._value = 100;
        this._direction = -1;
      } else if (this._value <= 0) {
        this._value = 0;
        this._direction = 1;
      }

      this._updateBar(bar);
    }, 30);
  }

  _stopMovement() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  _updateBar(bar) {
    if (!bar?.length) return;
    bar.css("width", `${this._value}%`);
  }

  /**
   * Simple Erfolgslogik:
   * - Trefferzone liegt zwischen 40% und 60%
   * - Trefferzone verschiebt sich um Bonus
   */
  async _resolveCheck(bar) {
    const value = this._value;

    // Kleine Trefferzone
    const zoneCenter = 50 + (this.bonus || 0); // Bonus verschiebt die Zone
    const zoneSize = 15; // +/- 15%

    const min = zoneCenter - zoneSize;
    const max = zoneCenter + zoneSize;

    const success = value >= min && value <= max;

    const flavor = game.i18n.localize("Lockpicking") || "Lockpicking";
    const msg = success
      ? `${this.actor.name} knackt das Schloss! (Treffer bei ${Math.round(value)}%)`
      : `${this.actor.name} scheitert beim Schlossknacken. (${Math.round(value)}%)`;

    // Chat-Nachricht für alle
    await ChatMessage.create({
      user: game.user.id,
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content: `<p><strong>${flavor}</strong></p><p>${msg}</p><p>DC: ${this.dc}, Bonus: ${this.bonus}</p>`
    });

    // Fenster nach kurzer Zeit schließen
    setTimeout(() => this.close(), 1000);
  }
}

/* ---------------------------------------- */
/*      Konfigurations-Dialog (nur GM)      */
/* ---------------------------------------- */

/**
 * Öffnet den Konfigurationsdialog für den GM
 */
async function openLockpickingConfig() {
  if (!game.user.isGM) {
    ui.notifications.warn("Nur der Spielleiter kann das Lockpicking-Minispiel starten.");
    return;
  }

  // Spieler-Actors mit Owner-Rechten
  const actors = game.actors.filter(a => a.hasPlayerOwner);

  if (!actors.length) {
    ui.notifications.warn("Keine Spieler-Charaktere mit Besitzrechten gefunden.");
    return;
  }

  const html = await renderTemplate(`modules/${MODULE_ID}/templates/lock-config.hbs`, {
    actors,
    defaultDc: 15,
    defaultBonus: 0
  });

  new Dialog({
    title: "Schlossknacken",
    content: html,
    buttons: {
      start: {
        label: "Lockpicking starten",
        callback: html => _onConfigSubmit(html, actors)
      }
    },
    default: "start"
  }).render(true);
}

/**
 * Verarbeitet das Formular aus dem Konfigurationsdialog
 */
function _onConfigSubmit(html, actors) {
  const form = html[0].querySelector("form") ?? html[0];
  const actorId = form.querySelector("[name='actorId']")?.value;
  const dc = Number(form.querySelector("[name='dc']")?.value) || 10;
  const bonus = Number(form.querySelector("[name='bonus']")?.value) || 0;

  const actor = actors.find(a => a.id === actorId);
  if (!actor) {
    ui.notifications.error("Ausgewählter Charakter wurde nicht gefunden.");
    return;
  }

  // Zielspieler bestimmen: erster User mit OWNER-Rechten auf dem Actor
  const owners = game.users.players.filter(u => actor.testUserPermission(u, "OWNER"));
  const targetUser = owners[0];

  if (!targetUser) {
    ui.notifications.error("Kein Spieler mit Besitzrechten für diesen Charakter gefunden.");
    return;
  }

  const payload = {
    action: "openMinigame",
    actorId: actor.id,
    dc,
    bonus,
    userId: targetUser.id
  };

  log("Config submit:", payload);

  // Wenn der GM selbst der Ziel-User ist → direkt öffnen
  if (targetUser.id === game.user.id) {
    _openMinigameForCurrentClient(payload);
  } else {
    // An Ziel-Client senden
    game.socket.emit(`module.${MODULE_ID}`, payload);
    ui.notifications.info(`Lockpicking-Minispiel für ${actor.name} gestartet (DC ${dc}, Bonus ${bonus}).`);
  }

  // Optional: Chat-Nachricht als Info
  ChatMessage.create({
    user: game.user.id,
    content: `Lockpicking-Minispiel für <strong>${actor.name}</strong> gestartet (DC ${dc}, Bonus ${bonus}).`,
    type: CONST.CHAT_MESSAGE_TYPES.OTHER
  });
}

/* ---------------------------------------- */
/*             Socket-Handling              */
/* ---------------------------------------- */

function _registerSocket() {
  if (!game.socket) {
    warn("Kein game.socket verfügbar – Socket-Handling deaktiviert.");
    return;
  }

  game.socket.on(`module.${MODULE_ID}`, data => {
    if (!data || data.action !== "openMinigame") return;

    log("Socket empfangen:", data);

    // Nur reagieren, wenn diese Nachricht für UNSEN User gedacht ist
    if (data.userId !== game.user.id) return;

    _openMinigameForCurrentClient(data);
  });
}

/**
 * Öffnet das Minigame-Fenster auf dem aktuellen Client.
 */
function _openMinigameForCurrentClient(data) {
  const actor = game.actors.get(data.actorId);
  if (!actor) {
    warn("Actor für Minispiel nicht gefunden:", data.actorId);
    return;
  }

  const app = new LockpickingGameApp(actor, data.dc, data.bonus);
  app.render(true);
}

/* ---------------------------------------- */
/*                 Hooks                    */
/* ---------------------------------------- */

Hooks.once("init", () => {
  log("Initialisiere Modul...");

  // Namespace/API bereitstellen
  game.lockpicking = {
    openConfig: openLockpickingConfig,
    openMinigame: _openMinigameForCurrentClient, // optional, falls du mal direkt testen willst
    MODULE_ID
  };
});

Hooks.once("ready", () => {
  log("Ready – Socket registrieren.");
  _registerSocket();

  // Debug: prüfen, ob alles geladen wurde
  log("API verfügbar:", typeof game.lockpicking);
});
