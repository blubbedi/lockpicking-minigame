// scripts/main.js

// Kleiner Helper zum Clampen
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Robust einen passenden Actor für einen User finden */
function getActorForUser(user) {
  if (!user) return null;

  // 1) Assigned Character (offizielle Verknüpfung)
  if (user.character) return user.character;

  // 2) Aktuell kontrollierter Token des Users (falls vorhanden)
  const controlled = canvas.tokens?.controlled ?? [];
  const tokenForUser = controlled.find(t =>
    t.actor &&
    t.actor.testUserPermission(user, "OWNER")
  );
  if (tokenForUser?.actor) return tokenForUser.actor;

  // 3) Erster Actor, den der User besitzt (Typ "character")
  const ownedActor = game.actors.find(a =>
    a.type === "character" &&
    a.testUserPermission(user, "OWNER")
  );
  if (ownedActor) return ownedActor;

  // 4) Nichts gefunden
  return null;
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

    const actor = getActorForUser(user);
    if (!actor) {
      ui.notifications.error("Dieser Spieler hat keinen verknüpften oder besessenen Charakter.");
      console.warn("lockpicking-minigame | Konnte keinen Actor für User finden:", user);
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
  const flags = message.flags["lockpicking-minigame"];
  if (!flags || flags.action !== "openGame") return;

  // Nur für den ausgewählten Spieler
  if (game.user.id !== flags.userId) return;

  const actor = game.actors.get(flags.actorId) || getActorForUser(game.user);
  if (!actor) return;

  new LockpickingGameApp(actor, flags).render(true);
});
