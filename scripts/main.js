
// scripts/main.js

// Kleiner Helper zum Clampen
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* ----------------------------------------- */
/*  Konfigurations-Fenster (GM)              */
/* ----------------------------------------- */

class LockpickingConfigApp extends FormApplication {
  static get defaultOptions() {
    const options = super.defaultOptions;
    options.id = "lockpicking-config";
    options.title = "Schlossknacken";
    options.template = "modules/lockpicking-minigame/templates/lock-config.hbs";
    options.width = 400;
    options.height = "auto";
    return options;
  }

  /** Daten für das Template */
  getData(options) {
    const users = game.users.contents.filter(u => u.active);
    return {
      users,
      defaultDc: 15
    };
  }

  /** Formular-Submit */
  async _updateObject(event, formData) {
    const userId = formData.userId;
    const dc = Number(formData.dc) || 15;

    const user = game.users.get(userId);
    if (!user) {
      ui.notifications.error("Ausgewählter Spieler wurde nicht gefunden.");
      return;
    }

    const actor = user.character;
    if (!actor) {
      ui.notifications.error("Dieser Spieler hat keinen verknüpften Charakter.");
      return;
    }

    // 1) Hat der Charakter Diebeswerkzeug?
    const thievesTools = actor.items.find(it => {
      const name = (it.name ?? "").toLowerCase();
      const type = getProperty(it, "system.type.value") ?? "";
      return (
        it.type === "tool" &&
        (
          name.includes("diebes") ||          // „Diebeswerkzeug“
          name.includes("thieves") ||         // „Thieves' Tools“
          type === "thievesTools" || type === "thief"
        )
      );
    });

    if (!thievesTools) {
      ui.notifications.warn(`${actor.name} besitzt keine Diebeswerkzeuge – Schlossknacken nicht möglich.`);
      return;
    }

    // 2) Werte für Geschicklichkeit + Übung
    const dexMod = getProperty(actor, "system.abilities.dex.mod") ?? 0;
    const profBonus = getProperty(actor, "system.attributes.prof") ?? 0;
    const proficient = getProperty(thievesTools, "system.proficient") ?? 0;

    // DnD5e: 0 = keine, 1 = halb, 2 = Prof., 3 = Expertise
    let bonus = dexMod;
    let disadvantage = true;

    if (proficient >= 2) {
      // Geübt mit Diebeswerkzeug → Volle Profi-Bonus, kein Nachteil
      bonus = dexMod + profBonus;
      disadvantage = false;
    } else {
      // Ungeübt → nur Dex, mit Nachteil
      bonus = dexMod;
      disadvantage = true;
    }

    // Chat-Nachricht + Flag, damit beim Spieler das Spiel aufgeht
    const content = `Lockpicking-Minispiel für <b>${actor.name}</b> gestartet (DC ${dc}, Bonus ${bonus}${disadvantage ? ", mit Nachteil" : ""}).`;

    await ChatMessage.create({
      content,
      speaker: { alias: "Lockpicking" },
      // alle sollen sehen – wenn du nur GM+Spieler willst, nutze "whispers"
      flags: {
        "lockpicking-minigame": {
          action: "openGame",
          userId,
          actorId: actor.id,
          dc,
          bonus,
          disadvantage
        }
      }
    });
  }
}

/* ----------------------------------------- */
/*  Minigame-Fenster (Spieler)              */
/* ----------------------------------------- */

class LockpickingGameApp extends Application {
  constructor(actor, config, options = {}) {
    super(options);
    this.actor = actor;
    this.config = config; // { dc, bonus, disadvantage, ... }
    this._interval = null;
    this._position = 0;
    this._direction = 1;
  }

  static get defaultOptions() {
    const options = super.defaultOptions;
    options.id = "lockpicking-game";
    options.title = "Schlossknacken";
    options.template = "modules/lockpicking-minigame/templates/lock-game.hbs";
    options.width = 420;
    options.height = "auto";
    return options;
  }

  /** Daten fürs Template */
  getData(options) {
    const dc = Number(this.config.dc) || 15;
    const bonus = Number(this.config.bonus) || 0;
    const disadvantage = !!this.config.disadvantage;

    // Zielbereich (Trefferzone) in % der Leiste
    const baseSize = 30;
    const difficultyFactor = clamp(dc - bonus, 0, 10); // wie hart ist's relativ zum Skill?
    let targetSize = baseSize - difficultyFactor * 2;  // kleiner bei schwieriger Probe
    targetSize = clamp(targetSize, 8, 40);
    if (disadvantage) targetSize *= 0.5;

    return {
      actorName: this.actor?.name ?? "Unbekannt",
      dc,
      bonus,
      disadvantage,
      targetSize
    };
  }

  /** Event-Handler und Animation */
  activateListeners(html) {
    super.activateListeners(html);

    const indicator = html[0].querySelector(".lp-indicator");
    const target = html[0].querySelector(".lp-target");

    if (!indicator || !target) return;

    // Geschwindigkeit: etwas schneller bei Nachteil
    const disadvantage = !!this.config.disadvantage;
    const step = disadvantage ? 2.7 : 1.8; // Prozent pro Tick
    const intervalMs = 25;

    this._position = 0;
    this._direction = 1;

    this._interval = setInterval(() => {
      this._position += this._direction * step;
      if (this._position >= 100) {
        this._position = 100;
        this._direction = -1;
      } else if (this._position <= 0) {
        this._position = 0;
        this._direction = 1;
      }
      indicator.style.left = `${this._position}%`;
    }, intervalMs);

    // Klick auf "Versuch starten"
    html.find("button[data-action='attempt']").on("click", ev => {
      ev.preventDefault();
      this._resolveAttempt(indicator, target);
    });
  }

  async _resolveAttempt(indicator, target) {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }

    const indRect = indicator.getBoundingClientRect();
    const tgtRect = target.getBoundingClientRect();

    const center = (indRect.left + indRect.right) / 2;
    const success = center >= tgtRect.left && center <= tgtRect.right;

    const dc = Number(this.config.dc) || 15;
    const bonus = Number(this.config.bonus) || 0;
    const disadvantage = !!this.config.disadvantage;

    const msg = success
      ? `${this.actor.name} knackt das Schloss (DC ${dc}, Bonus ${bonus}${disadvantage ? ", mit Nachteil" : ""}).`
      : `${this.actor.name} scheitert beim Schlossknacken (DC ${dc}, Bonus ${bonus}${disadvantage ? ", mit Nachteil" : ""}).`;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content: msg
    });

    this.close();
  }

  async close(options) {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    return super.close(options);
  }
}

/* ----------------------------------------- */
/*  Hooks & globaler Zugriff                 */
/* ----------------------------------------- */

// Init: nur Log
Hooks.once("init", () => {
  console.log("lockpicking-minigame | init");
});

// Ready: globales Objekt für Makro
Hooks.once("ready", () => {
  console.log("lockpicking-minigame | ready");

  // Nur einmal anlegen
  game.lockpickingMinigame = {
    openConfig: () => {
      if (!game.user.isGM) {
        ui.notifications.warn("Nur der Spielleiter kann das Schlossknacken-Konfigurationsfenster öffnen.");
        return;
      }
      new LockpickingConfigApp().render(true);
    }
  };
});

// Chat-Flag abfangen → beim richtigen Spieler das Minigame öffnen
Hooks.on("createChatMessage", (message, options, userId) => {
  const data = message.getFlag("lockpicking-minigame", "action")
    ? {
        action: message.getFlag("lockpicking-minigame", "action"),
        userId: message.getFlag("lockpicking-minigame", "userId"),
        actorId: message.getFlag("lockpicking-minigame", "actorId"),
        dc: message.getFlag("lockpicking-minigame", "dc"),
        bonus: message.getFlag("lockpicking-minigame", "bonus"),
        disadvantage: message.getFlag("lockpicking-minigame", "disadvantage")
      }
    : message.flags["lockpicking-minigame"];

  if (!data || data.action !== "openGame") return;

  // Nur für den ausgewählten Spieler
  if (game.user.id !== data.userId) return;

  const actor = game.actors.get(data.actorId) || game.user.character;
  if (!actor) return;

  new LockpickingGameApp(actor, data).render(true);
});
