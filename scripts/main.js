// scripts/main.js
// Lockpicking-Minigame für Foundry VTT v11
const MODULE_ID = "lockpicking-minigame";

/* ----------------------------------------- */
/*  Hilfsfunktionen                          */
/* ----------------------------------------- */

/**
 * Versuche den Fingerfertigkeit-Bonus (Sleight of Hand) des Actors zu bestimmen.
 * Fällt zurück auf DEX-Mod, falls Skill nicht existiert.
 */
function getLockpickingBonus(actor) {
  const sys = actor.system ?? {};
  const skills = sys.skills ?? {};
  // D&D5e: Sleight of Hand = "slt"
  const slt = skills.slt ?? skills.sleightOfHand;

  if (slt) {
    // neuere D&D5e-Versionen benutzen meist "total" oder "mod"
    if (typeof slt.total === "number") return slt.total;
    if (typeof slt.mod === "number") return slt.mod;
    if (typeof slt.value === "number") return slt.value;
  }

  const dex = sys.abilities?.dex;
  if (dex && typeof dex.mod === "number") return dex.mod;
  return 0;
}

/**
 * Passiver Wert: wenn das System ihn nicht liefert, 10 + Bonus.
 */
function getPassiveLockpicking(actor, bonus) {
  const sys = actor.system ?? {};
  const skills = sys.skills ?? {};
  const slt = skills.slt ?? skills.sleightOfHand;

  if (slt && typeof slt.passive === "number") return slt.passive;
  return 10 + (bonus ?? getLockpickingBonus(actor));
}

/**
 * Hat der Actor "Verlässliches Talent"?
 */
function hasReliableTalent(actor) {
  return actor.items.some((i) => {
    if (i.type !== "feat") return false;
    const name = (i.name || "").toLowerCase();
    return name.includes("verlässliches talent") || name.includes("reliable talent");
  });
}

/**
 * Besitzer-User für einen Actor bestimmen – möglichst ein Spieler, kein GM.
 */
function findActorOwnerUser(actor) {
  const owners = game.users.contents.filter((u) =>
    actor.testUserPermission(u, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
  );

  if (!owners.length) return game.user;

  // bevorzugt einen Nicht-GM
  const nonGm = owners.find((u) => !u.isGM);
  return nonGm ?? owners[0];
}

/* ----------------------------------------- */
/*  Konfigurations-Fenster                   */
/* ----------------------------------------- */

class LockpickingConfigApp extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-config",
      title: "Schlossknacken",
      template: "modules/lockpicking-minigame/templates/lock-config.hbs",
      width: 420,
      height: "auto",
      closeOnSubmit: true,
      submitOnChange: false
    });
  }

  /**
   * Daten fürs Template.
   * Erwartet: <select name="actorId"> & <input name="dc">
   */
  async getData(options = {}) {
    const data = await super.getData(options);

    // Alle Charakter-Token auf der aktuellen Szene
    const tokens = canvas?.tokens?.placeables ?? [];
    const actorEntries = [];

    for (const t of tokens) {
      if (!t.actor) continue;
      if (t.actor.type !== "character") continue;
      actorEntries.push({
        id: t.actor.id,
        name: `${t.name} (${t.actor.name})`
      });
    }

    // Fallback: User-Charakter, falls keine Token gefunden werden
    if (!actorEntries.length && game.user.character) {
      actorEntries.push({
        id: game.user.character.id,
        name: game.user.character.name
      });
    }

    const defaultActorId = actorEntries[0]?.id ?? null;

    return {
      ...data,
      actors: actorEntries,
      defaultActorId,
      defaultDc: 15
    };
  }

  /**
   * Wird aufgerufen, wenn der GM auf "Lockpicking starten" klickt.
   */
  async _updateObject(event, formData) {
    event.preventDefault();
    console.log(`${MODULE_ID} | Config submit`, formData);

    const actorId = formData.actorId;
    const dc = Number(formData.dc) || 10;

    const actor = game.actors.get(actorId);
    if (!actor) {
      ui.notifications.error("Actor nicht gefunden.");
      return;
    }

    const bonus = getLockpickingBonus(actor);
    const passive = getPassiveLockpicking(actor, bonus);
    const reliable = hasReliableTalent(actor);

    console.log(
      `${MODULE_ID} | Actor=${actor.name}, DC=${dc}, Bonus=${bonus}, Passive=${passive}, Reliable=${reliable}`
    );

    // Auto-Erfolg, wenn passiver Wert >= DC
    if (passive >= dc) {
      const content = `
        <b>${actor.name}</b> knackt das Schloss sofort.<br>
        DC: ${dc}<br>
        Bonus: ${bonus >= 0 ? "+" + bonus : bonus}<br>
        Passiver Wert: ${passive} &ge; DC<br>
        <em>Kein Minispiel nötig – der Charakter ist geübt.</em>
      `;
      ChatMessage.create({
        speaker: { actor },
        content
      });
      return;
    }

    // Ziel-User bestimmen
    const targetUser = findActorOwnerUser(actor);
    if (!targetUser) {
      ui.notifications.error("Kein Besitzer für diesen Charakter gefunden.");
      return;
    }

    const socketData = {
      action: "openMinigame",
      actorId: actor.id,
      dc,
      bonus,
      userId: targetUser.id
    };

    console.log(`${MODULE_ID} | Sending openMinigame`, socketData);

    game.socket.emit(`module.${MODULE_ID}`, socketData);

    const msg = `Lockpicking-Minigame für <b>${actor.name}</b> gestartet (DC ${dc}, Bonus ${bonus >= 0 ? "+" + bonus : bonus}).`;
    ChatMessage.create({
      speaker: { actor },
      content: msg
    });
  }
}

/* ----------------------------------------- */
/*  Minigame-Fenster                         */
/* ----------------------------------------- */

class LockpickingGameApp extends Application {
  constructor(actor, options) {
    super(options);
    this.actor = actor;
    this.dc = Number(options.dc) || 10;
    this.bonus = Number(options.bonus) || 0;
    this._running = false;
    this._interval = null;
    this._currentValue = 0;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-game",
      title: "Schlossknacken",
      template: "modules/lockpicking-minigame/templates/lock-game.hbs",
      width: 500,
      height: "auto"
    });
  }

  getData(options = {}) {
    const data = super.getData(options);
    return {
      ...data,
      actorName: this.actor?.name ?? "",
      dc: this.dc,
      bonus: this.bonus
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    const startBtn = html.find('[data-action="start"]');
    const knockBtn = html.find('[data-action="knock"]');
    const bar = html.find(".lp-bar-inner");
    const marker = html.find(".lp-marker");

    const setMarker = (value) => {
      this._currentValue = value;
      const pct = Math.max(0, Math.min(100, value));
      marker.css("left", `${pct}%`);
    };

    startBtn.on("click", (ev) => {
      ev.preventDefault();
      if (this._running) return;
      this._running = true;

      // simple Ping-Pong-Animation
      let value = 0;
      let dir = 1;
      this._interval = setInterval(() => {
        value += dir * 2; // Schrittweite
        if (value >= 100) {
          value = 100;
          dir = -1;
        } else if (value <= 0) {
          value = 0;
          dir = 1;
        }
        setMarker(value);
      }, 25);

      ui.notifications.info("Bewegung gestartet – drück 'Jetzt knacken!' im richtigen Moment.");
    });

    knockBtn.on("click", async (ev) => {
      ev.preventDefault();
      if (!this._running) {
        ui.notifications.warn("Starte zuerst die Bewegung.");
        return;
      }
      this._running = false;
      if (this._interval) {
        clearInterval(this._interval);
        this._interval = null;
      }

      // Erfolgsbereich: mittlere 30% der Leiste
      const successMin = 35;
      const successMax = 65;

      const inZone = this._currentValue >= successMin && this._currentValue <= successMax;

      // zusätzlich klassischer Wurf: d20 + Bonus vs DC
      const roll = await new Roll(`1d20 + ${this.bonus}`).roll({ async: true });
      const total = roll.total;
      const success = inZone && total >= this.dc;

      const flavor = `
        <b>${this.actor?.name ?? "Jemand"}</b> versucht das Schloss zu knacken.<br>
        DC: ${this.dc}, Bonus: ${this.bonus >= 0 ? "+" + this.bonus : this.bonus}<br>
        Marker-Position: ${Math.round(this._currentValue)}% (${successMin}–${successMax}% ist der Erfolgsbereich).<br>
        Wurf: ${roll.result} = <b>${total}</b> ${success ? "≥" : "<"} DC ${this.dc}
      `;

      await roll.toMessage({
        speaker: { actor: this.actor },
        flavor: flavor + `<br><b>Ergebnis:</b> ${success ? "Das Schloss klickt und öffnet sich!" : "Das Schloss bleibt verschlossen."}`
      });

      this.close();
    });
  }
}

/* ----------------------------------------- */
/*  Öffentliche API                          */
/* ----------------------------------------- */

/**
 * Vom Makro aufrufen: öffnet das Konfig-Fenster beim GM.
 */
export function openLockpickingConfig() {
  if (!game.user.isGM) {
    ui.notifications.warn("Nur der SL kann das Lockpicking-Minispiel starten.");
    return;
  }
  new LockpickingConfigApp().render(true);
}

/* ----------------------------------------- */
/*  Hooks                                    */
/* ----------------------------------------- */

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready`);

  // Socket-Listener: Minigame auf Client des Ziel-Users öffnen
  game.socket.on(`module.${MODULE_ID}`, (data) => {
    if (!data || data.action !== "openMinigame") return;
    if (data.userId && data.userId !== game.user.id) return;

    const actor = game.actors.get(data.actorId);
    if (!actor) {
      console.warn(`${MODULE_ID} | Actor auf Client nicht gefunden`, data.actorId);
      return;
    }

    console.log(`${MODULE_ID} | opening minigame on client`, {
      actor: actor.name,
      dc: data.dc,
      bonus: data.bonus
    });

    const app = new LockpickingGameApp(actor, {
      dc: data.dc,
      bonus: data.bonus
    });
    app.render(true);
  });

  // kleine API für Makros
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = mod.api || {};
    mod.api.openConfig = openLockpickingConfig;
  }

  // Optional: globale Referenzen (nur zur Fehlersuche)
  window.LockpickingConfigApp = LockpickingConfigApp;
  window.LockpickingGameApp = LockpickingGameApp;
  window.openLockpickingConfig = openLockpickingConfig;
});
