// modules/lockpicking-minigame/scripts/main.js

const MODULE_ID = "lockpicking-minigame";

/**
 * Konfigurationsdialog: GM wählt Actor & DC
 */
class LockpickingConfigApp extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-config",
      title: "Schlossknacken",
      template: `modules/${MODULE_ID}/templates/lock-config.hbs`,
      width: 450,
      resizable: false,
      classes: ["lockpicking-minigame", "lp-config-app"]
    });
  }

  /** Daten für das Template */
  getData(options = {}) {
    const tokens = canvas?.tokens?.placeables ?? [];

    // Eindeutige Actor-Liste aus der aktuellen Szene
    const actors = [];
    const seen = new Set();
    for (const t of tokens) {
      const a = t.actor;
      if (!a || seen.has(a.id)) continue;
      seen.add(a.id);
      actors.push({ id: a.id, name: a.name });
    }

    return {
      actors,
      defaultDc: 15
    };
  }

  /**
   * Wird ausgeführt, wenn der GM auf "Lockpicking starten" klickt
   * bzw. das Formular abschickt.
   */
  async _updateObject(event, formData) {
    event.preventDefault();

    const actorId = formData.actorId;
    const dc = Number(formData.dc) || 10;

    if (!actorId) {
      ui.notifications.warn("Bitte einen Charakter auswählen.");
      return;
    }

    // Actor holen (über Actors-Liste oder Tokens)
    let actor = game.actors.get(actorId);
    if (!actor) {
      actor = canvas.tokens.placeables.find(t => t.actor?.id === actorId)?.actor ?? null;
    }

    if (!actor) {
      ui.notifications.error("Ausgewählter Charakter wurde nicht gefunden.");
      return;
    }

    // Fingerfertigkeit-Bonus (DnD5e: skill "sle")
    const sleight = actor.system?.skills?.sle;
    const bonus = typeof sleight?.total === "number"
      ? sleight.total
      : (sleight?.mod ?? 0);

    const passive = 10 + bonus;
    const hasReliable = LockpickingConfigApp._hasReliableTalent(actor);

    // Chat-Zusammenfassung vorbereiten
    const lines = [];
    lines.push(`<b>${actor.name}</b> versucht das Schloss zu knacken.`);
    lines.push(`• DC: <b>${dc}</b>`);
    lines.push(`• Bonus: <b>${bonus >= 0 ? "+" + bonus : bonus}</b>`);
    lines.push(`• Passiver Wert: <b>${passive}</b>`);
    if (hasReliable) {
      lines.push(`• Merkmal: <b>Verlässliches Talent</b>`);
    }

    // AUTO-ERFOLG, wenn passiv >= DC
    if (passive >= dc) {
      lines.push(`<p><b>Kein Minispiel nötig – der Charakter ist zu geübt.</b></p>`);

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: lines.join("<br>"),
        type: CONST.CHAT_MESSAGE_TYPES.OTHER
      });

      return; // kein Minigame
    }

    // Kein Auto-Erfolg → Minigame anwerfen
    lines.push(`<p>Das Schloss ist anspruchsvoll – es wird ein Minispiel gestartet.</p>`);

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: lines.join("<br>"),
      type: CONST.CHAT_MESSAGE_TYPES.OTHER
    });

    // Ziel-User bestimmen: Actor-Besitzer
    const targetUser = LockpickingConfigApp._getPrimaryOwner(actor) ?? game.user;
    const targetUserId = targetUser?.id ?? game.user.id;

    // Socket an Spieler schicken
    console.log(
      `${MODULE_ID} | sending socket`,
      { action: "openMinigame", actorId: actor.id, dc, bonus, targetUserId }
    );

    game.socket.emit(`module.${MODULE_ID}`, {
      action: "openMinigame",
      actorId: actor.id,
      dc,
      bonus,
      targetUserId
    });

    // Falls der GM selbst der Spieler ist → direkt öffnen
    if (targetUserId === game.user.id) {
      const app = new LockpickingGameApp(actor, { dc, bonus });
      app.render(true);
    }
  }

  /** Prüft, ob der Actor das Merkmal "Verlässliches Talent"/"Reliable Talent" hat */
  static _hasReliableTalent(actor) {
    const items = actor.items?.contents ?? actor.items ?? [];
    return items.some(i => {
      const n = (i.name || "").toLowerCase();
      return n.includes("verlässliches talent") || n.includes("reliable talent");
    });
  }

  /** Eigentümer des Actors ermitteln */
  static _getPrimaryOwner(actor) {
    // Foundry V12: actor.primaryOwner ist ein User oder null
    if (actor.primaryOwner) return actor.primaryOwner;

    // Fallback: erster Spieler mit OWNER-Rechten
    const players = game.users.players.filter(u => actor.testUserPermission(u, "OWNER"));
    return players[0] ?? null;
  }
}

/**
 * Minigame-App: Balken + Button-Interaktion
 */
class LockpickingGameApp extends Application {
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.dc = Number(options.dc) || 10;
    this.bonus = Number(options.bonus) || 0;

    this._markerPos = 0;      // 0–100 %
    this._direction = 1;      // 1 oder -1
    this._interval = null;
    this._running = false;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-game",
      title: "Schlossknacken",
      template: `modules/${MODULE_ID}/templates/lock-game.hbs`,
      width: 500,
      height: "auto",
      resizable: false,
      classes: ["lockpicking-minigame", "lp-game-app"]
    });
  }

  getData(options = {}) {
    return {
      actor: this.actor,
      actorName: this.actor?.name ?? "",
      dc: this.dc,
      bonus: this.bonus
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    const btnStart = html.find('[data-action="start"]');
    const btnPick = html.find('[data-action="pick"]');
    this._markerEl = html.find(".lp-marker");
    this._hotzoneEl = html.find(".lp-hotzone");

    btnStart.on("click", () => this._startMovement());
    btnPick.on("click", () => this._tryPick());
  }

  /** Startet die Balkenbewegung */
  _startMovement() {
    if (this._interval) clearInterval(this._interval);

    this._running = true;
    this._markerPos = 0;
    this._direction = 1;

    // alle 30ms Marker verschieben
    this._interval = setInterval(() => {
      if (!this._running) return;

      this._markerPos += this._direction * 2;
      if (this._markerPos >= 100) {
        this._markerPos = 100;
        this._direction = -1;
      } else if (this._markerPos <= 0) {
        this._markerPos = 0;
        this._direction = 1;
      }

      if (this._markerEl) {
        this._markerEl.css("left", `${this._markerPos}%`);
      }
    }, 30);
  }

  /** Beendet Bewegung und wertet aus */
  async _tryPick() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._running = false;

    // Hotzone-Bereich (in %), z.B. mittleres Drittel
    const hotMin = 35;
    const hotMax = 65;
    const inHotzone = this._markerPos >= hotMin && this._markerPos <= hotMax;

    // Optional: tatsächlichen Wurf einbauen
    const roll = await (new Roll("1d20 + @bonus", { bonus: this.bonus })).evaluate({ async: true });

    const skillSuccess = roll.total >= this.dc;
    const success = inHotzone && skillSuccess;

    const resultLines = [];
    resultLines.push(`<b>${this.actor.name}</b> versucht, das Schloss zu knacken.`);
    resultLines.push(`• DC: <b>${this.dc}</b>`);
    resultLines.push(`• Wurf: <b>${roll.result}</b> = <b>${roll.total}</b>`);
    resultLines.push(`• Marker-Position: <b>${Math.round(this._markerPos)}%</b> ${inHotzone ? "(im Bereich)" : "(außerhalb des Bereichs)"}`);

    if (success) {
      resultLines.push(`<p style="color: #0a0;"><b>Erfolg!</b> Das Schloss öffnet sich.</p>`);
    } else {
      resultLines.push(`<p style="color: #a00;"><b>Fehlschlag!</b> Das Schloss bleibt verschlossen.</p>`);
    }

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content: resultLines.join("<br>"),
      type: CONST.CHAT_MESSAGE_TYPES.OTHER
    });

    this.close();
  }

  close(options) {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    return super.close(options);
  }
}

/* ----------------------------- Hooks ----------------------------- */

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init (user=${game.user.id})`);

  // Globale API, z.B. für Makro: game.lockpickingMinigame.openConfig()
  game.lockpickingMinigame = {
    openConfig: () => {
      const app = new LockpickingConfigApp();
      app.render(true);
    }
  };
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready (user=${game.user.id})`);

  // Socket-Listener: reagiert auf Nachrichten vom GM
  game.socket.on(`module.${MODULE_ID}`, async (data) => {
    console.log(`${MODULE_ID} | socket received`, data, "client user=", game.user.id);

    if (!data || data.action !== "openMinigame") return;

    // Nur der adressierte User reagiert
    if (data.targetUserId && data.targetUserId !== game.user.id) {
      console.log(`${MODULE_ID} | not for me -> ignoring`);
      return;
    }

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

/* ----------------------------- Globals ---------------------------- */

// Klassen und Hilfsfunktion global verfügbar machen (für Konsole, andere Module, etc.)
window.LockpickingGameApp = LockpickingGameApp;
window.LockpickingConfigApp = LockpickingConfigApp;
window.openLockpickingGame = function (actorId, dc = 15) {
  const actor = game.actors.get(actorId);
  if (!actor) return;
  const app = new LockpickingGameApp(actor, { dc, bonus: 0 });
  app.render(true);
};
