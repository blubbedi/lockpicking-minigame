/**
 * Lockpicking Minigame - main.js
 * Foundry VTT v11, dnd5e 5.x
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
      console.log("lockpicking-minigame | Öffne Konfig-Dialog");
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

    console.log("lockpicking-minigame | Minigame wird für User geöffnet:", {
      userId: data.userId,
      actor: actor.name,
      dc: data.dc,
      bonus: data.bonus,
      disadvantage: data.disadvantage
    });

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
    console.log("lockpicking-minigame | _updateObject aufgerufen:", formData);

    try {
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

      const getProp = foundry.utils.getProperty;

      const thievesTools = actor.items.find((it) => {
        const name = (it.name ?? "").toLowerCase();
        const typeValue = getProp(it, "system.type.value") ?? "";
        return (
          it.type === "tool" &&
          (
            name.includes("diebes") ||      // „Diebeswerkzeug“
            name.includes("thieves") ||     // „Thieves' Tools“
            typeValue === "thievesTools" ||
            typeValue === "thief"
          )
        );
      });

      if (!thievesTools) {
        ui.notifications.warn(
          `${actor.name} besitzt keine Diebeswerkzeuge – Schlossknacken nicht möglich.`
        );
        console.log("lockpicking-minigame | Kein Diebeswerkzeug gefunden für", actor.name);
        return;
      }

      // Grundwerte
      const dexMod = getProp(actor, "system.abilities.dex.mod") ?? 0;
      const profBonus = getProp(actor, "system.attributes.prof") ?? 0;

      // Proficiency-Level des Tools (0, 0.5, 1, 2)
      const profLevelRaw = getProp(thievesTools, "system.proficient") ?? 0;
      const profLevel = Number(profLevelRaw);

      let bonus = dexMod;
      let disadvantage = false;
      let profLabel = "keine";

      if (profLevel === 0) {
        // keine Proficiency → nur DEX, mit Nachteil
        bonus = dexMod;
        disadvantage = true;
        profLabel = "keine";
      } else if (profLevel === 0.5) {
        // halbe Proficiency
        bonus = dexMod + Math.floor(profBonus / 2);
        disadvantage = false;
        profLabel = "halb";
      } else if (profLevel === 1) {
        // normale Proficiency
        bonus = dexMod + profBonus;
        disadvantage = false;
        profLabel = "geübt";
      } else if (profLevel >= 2) {
        // Expertise (doppelte Proficiency)
        bonus = dexMod + profBonus * 2;
        disadvantage = false;
        profLabel = "Expertise";
      }

      console.log("lockpicking-minigame | Tool-Info:", {
        actor: actor.name,
        user: user.name,
        toolItem: thievesTools.name,
        profLevelRaw,
        profLevel,
        dexMod,
        profBonus
      });

      console.log("lockpicking-minigame | Berechnete Werte:", {
        actor: actor.name,
        user: user.name,
        dc,
        dexMod,
        profBonus,
        profLevel,
        profLabel,
        bonus,
        disadvantage
      });

      /* ----------------- Chat-Nachricht + Flag ------------------ */

      const content =
        `Lockpicking-Minispiel für <b>${actor.name}</b> gestartet ` +
        `(DC ${dc}, Bonus ${bonus}${disadvantage ? ", mit Nachteil" : ", ohne Nachteil"}) ` +
        `(<i>${profLabel} mit Diebeswerkzeug</i>).`;

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

      console.log("lockpicking-minigame | ChatMessage mit Flags erstellt.");
    } catch (err) {
      console.error("lockpicking-minigame | Fehler in _updateObject:", err);
      ui.notifications.error("Beim Start des Lockpicking-Minispiels ist ein Fehler aufgetreten. Siehe Konsole.");
    }
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

    // Minigame-State
    this.running = false;
    this.finished = false;
    this.barPosition = 0.5; // Mittelpunkt des Balkens (0..1)
    this.direction = 1;
    this.barSize = 0.25; // Anteil der Gesamtbreite (0..1)
    this.speed = 0.7;    // Einheiten pro Sekunde (0..1)
    this._animFrame = null;
    this._lastTime = null;
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
    const dc = Number(this.config.dc ?? 10);
    const bonus = Number(this.config.bonus ?? 0);
    const disadvantage = !!this.config.disadvantage;

    // benötigter Wurf auf dem W20
    let neededRoll = dc - bonus;
    let impossible = false;
    let autoSuccess = false;

    if (neededRoll <= 1) {
      neededRoll = 1;
      autoSuccess = true;
    } else if (neededRoll > 20) {
      neededRoll = 20;
      impossible = true;
    }

    return {
      actorName: this.actor.name,
      dc,
      bonus,
      disadvantage,
      neededRoll,
      impossible,
      autoSuccess
    };
  }

  /* ------------ Minigame-Setup & Animation ----------- */

  activateListeners(html) {
    super.activateListeners(html);

    this._html = html;
    this._track = html.find(".lp-track")[0];
    this._bar = html.find(".lp-bar")[0];
    this._center = html.find(".lp-center")[0];
    this._startButton = html.find('[data-action="start"]')[0];

    // Größe & Geschwindigkeit auf Basis von DC / Bonus bestimmen
    this._setupGameParameters();

    // Anfangsposition zeichnen
    this._renderBar();

    html.find('[data-action="start"]').on("click", this._onStartClick.bind(this));
    html.find('[data-action="close"]').on("click", (ev) => {
      ev.preventDefault();
      this._stopAnimation();
      this.close();
    });
  }

  /** Berechnet Balken-Größe & Geschwindigkeit */
  _setupGameParameters() {
    const { dc, bonus, disadvantage } = this.config;

    // effektive Schwierigkeit: höher = schwieriger
    const diff = Math.max(0, dc - bonus);

    // Grundgröße: bei diff <= 5 etwa 45%, wird kleiner bis min ~10%
    let size = 0.45 - diff * 0.02;
    size = Math.min(0.45, Math.max(0.1, size));

    // bei Nachteil: halb so groß
    if (disadvantage) size *= 0.5;

    this.barSize = size;

    // Grundgeschwindigkeit, bei diff höher etwas schneller
    let speed = 0.7 + diff * 0.02;
    if (disadvantage) speed *= 1.3;
    this.speed = speed;

    console.log("lockpicking-minigame | Minigame-Parameter:", {
      dc,
      bonus,
      disadvantage,
      barSize: this.barSize,
      speed: this.speed
    });
  }

  /** Zeichnet Balken an aktueller Position */
  _renderBar() {
    if (!this._bar) return;

    const half = this.barSize / 2;
    // Sicherheits-Clamps
    this.barPosition = Math.min(1 - half, Math.max(half, this.barPosition));

    const leftPercent = (this.barPosition - half) * 100;
    const widthPercent = this.barSize * 100;

    this._bar.style.width = `${widthPercent}%`;
    this._bar.style.left = `${leftPercent}%`;
  }

  _startAnimation() {
    if (this.running) return;
    this.running = true;
    this.finished = false;
    this._lastTime = null;
    this._animFrame = requestAnimationFrame(this._animate.bind(this));
  }

  _stopAnimation() {
    this.running = false;
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
    this._animFrame = null;
    this._lastTime = null;
  }

  _animate(timestamp) {
    if (!this.running) return;

    if (this._lastTime === null) {
      this._lastTime = timestamp;
    }
    const dt = (timestamp - this._lastTime) / 1000; // Sekunden
    this._lastTime = timestamp;

    const half = this.barSize / 2;

    // Position fortschreiben
    this.barPosition += this.direction * this.speed * dt;

    // an den Rändern umkehren
    if (this.barPosition - half <= 0) {
      this.barPosition = half;
      this.direction = 1;
    } else if (this.barPosition + half >= 1) {
      this.barPosition = 1 - half;
      this.direction = -1;
    }

    this._renderBar();
    this._animFrame = requestAnimationFrame(this._animate.bind(this));
  }

  /* ------------ Button-Logik & Auswertung ----------- */

  async _onStartClick(event) {
    event.preventDefault();

    if (!this.running && !this.finished) {
      // 1. Klick → Bewegung starten
      this._startAnimation();
      if (this._startButton) {
        this._startButton.textContent = "Jetzt knacken! (zum Stoppen klicken)";
      }
      return;
    }

    if (this.running && !this.finished) {
      // 2. Klick → Bewegung stoppen & auswerten
      this._stopAnimation();
      this.finished = true;
      if (this._startButton) {
        this._startButton.textContent = "Ergebnis im Chat anzeigen";
        this._startButton.disabled = true;
      }
      await this._evaluateResult();
      return;
    }
  }

  /** Prüft, ob der Balken den Mittelpunkt trifft und schreibt Ergebnis in den Chat */
  async _evaluateResult() {
    const { dc, bonus, disadvantage } = this.config;

    const center = 0.5;
    const dist = Math.abs(this.barPosition - center);
    const margin = this.barSize / 2;

    const success = dist <= margin;

    // kleine Qualitätsabstufung
    let quality = "";
    if (success) {
      const rel = dist / margin; // 0 = perfekt Mitte, 1 = gerade so
      if (rel <= 0.3) quality = " (perfekter Treffer)";
      else if (rel <= 0.7) quality = " (guter Treffer)";
      else quality = " (knapp geschafft)";
    }

    const flavor =
      `Lockpicking-Minispiel – ${this.actor.name} versucht ein Schloss zu knacken.<br>` +
      `DC ${dc}, Bonus ${bonus}${disadvantage ? ", mit Nachteil" : ", ohne Nachteil"}.<br>` +
      `Ergebnis: <b>${success ? "Erfolg" : "Misserfolg"}</b>${quality}.`;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content: flavor
    });

    ui.notifications[success ? "info" : "warn"](
      success ? "Du knackst das Schloss!" : "Das Schloss widersteht deinem Versuch."
    );

    this.close();
  }
}
