/**
 * Lockpicking Minigame - main.js
 * Foundry VTT v11, dnd5e 4.x
 */

/* ----------------------------------------- */
/*  Konstanten                               */
/* ----------------------------------------- */

const LP_ICON_PATHS = {
  up: "modules/lockpicking-minigame/icons/arrow-up.jpg",
  down: "modules/lockpicking-minigame/icons/arrow-down.jpg",
  left: "modules/lockpicking-minigame/icons/arrow-left.jpg",
  right: "modules/lockpicking-minigame/icons/arrow-right.jpg"
};

const LP_KEYS = ["up", "down", "left", "right"];
const LP_KEY_FROM_EVENT = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right"
};

/* ----------------------------------------- */
/*  Hooks                                    */
/* ----------------------------------------- */

Hooks.once("init", () => {
  console.log("lockpicking-minigame | init");
});

Hooks.once("ready", () => {
  console.log("lockpicking-minigame | ready");

  // kleiner Namespace fürs Makro
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

  // Spieler-Seite: auf Chat-Nachricht des Moduls reagieren
  Hooks.on("createChatMessage", (message) => {
    const data = message.flags?.["lockpicking-minigame"];
    if (!data || data.action !== "openGame") return;

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

      const getProp = foundry.utils.getProperty;

      /* ----------- Diebeswerkzeug-Item finden ----------- */

      const thievesToolsItem = actor.items.find((it) => {
        const name = (it.name ?? "").toLowerCase();
        const typeValue = getProp(it, "system.type.value") ?? "";
        return (
          it.type === "tool" &&
          (
            name.includes("diebes") ||      // deutsch
            name.includes("thieves") ||     // englisch
            typeValue === "thievesTools" ||
            typeValue === "thief"
          )
        );
      });

      if (!thievesToolsItem) {
        ui.notifications.warn(
          `${actor.name} besitzt keine Diebeswerkzeuge – Schlossknacken nicht möglich.`
        );
        console.log("lockpicking-minigame | Kein Diebeswerkzeug gefunden für", actor.name);
        return;
      }

      /* ----------- Werte aus dem Actor holen ----------- */

      const dexMod = getProp(actor, "system.abilities.dex.mod") ?? 0;
      const profBonus = getProp(actor, "system.attributes.prof") ?? 0;

      // Versuche, die Tool-Proficiency direkt aus actor.system.tools zu holen
      const toolsData = getProp(actor, "system.tools") ?? {};
      let profMultiplier = 0; // 0 = keine, 0.5 = halb, 1 = normal, 2 = Expertise

      for (const [key, tool] of Object.entries(toolsData)) {
        const label = (tool.label ?? tool.name ?? "").toLowerCase();
        if (label.includes("thieves") || label.includes("diebes")) {
          profMultiplier = Number(tool.value ?? 0);
          break;
        }
      }

      // Fallback: wenn dort nichts eingetragen ist, aber das Item existiert,
      // gehen wir von normaler Proficiency aus
      if (!profMultiplier && thievesToolsItem) {
        profMultiplier = 1;
      }

      const bonus = dexMod + profBonus * profMultiplier;
      const disadvantage = profMultiplier === 0;

      console.log("lockpicking-minigame | Tool-Info:", {
        actor: actor.name,
        user: user.name,
        toolInfo: {
          dexMod,
          profBonus,
          profMultiplier
        }
      });

      /* ----------- Prüfen, ob DC überhaupt erreichbar ist ----------- */
      const maxRoll = bonus + 20; // W20-Maximalwurf
      if (maxRoll < dc) {
        const content =
          `Lockpicking: <b>${actor.name}</b> hat keine Chance, dieses Schloss zu knacken. ` +
          `(DC ${dc}, maximal möglicher Wert ${maxRoll}).`;

        await ChatMessage.create({
          content,
          speaker: { alias: "Lockpicking" }
        });

        ui.notifications.warn(
          `${actor.name} kann diesen Schwierigkeitsgrad selbst mit einem natürlichen 20 nicht erreichen.`
        );
        return;
      }

      console.log("lockpicking-minigame | Berechnete Werte:", {
        actor: actor.name,
        user: user.name,
        dc,
        dexMod,
        profBonus,
        profMultiplier,
        bonus,
        disadvantage
      });

      /* ----------- Chat-Nachricht + Flag fürs Minigame ----------- */

      const content =
        `Lockpicking-Minispiel für <b>${actor.name}</b> gestartet ` +
        `(DC ${dc}, Bonus ${bonus}${disadvantage ? ", mit Nachteil" : ", ohne Nachteil"}).`;

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
/*  Quick-Time-Minispiel (Spieler)           */
/* ----------------------------------------- */

class LockpickingGameApp extends Application {
  constructor(actor, config, options = {}) {
    super(options);
    this.actor = actor;
    this.config = config; // { dc, bonus, disadvantage }

    // Game-Status
    this.sequence = [];      // interne Reihenfolge (z.B. ["up","left",...])
    this.currentIndex = 0;   // wie viele bereits korrekt gedrückt
    this.totalTimeMs = 0;
    this.startTime = null;
    this.running = false;
    this.finished = false;
    this.failed = false;

    this._timerFrame = null;
    this._onKeyDown = this._handleKeyDown.bind(this);
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

  /* ------------ Setup & Listener --------------------- */

  activateListeners(html) {
    super.activateListeners(html);

    this._html = html;
    this._sequenceContainer = html.find(".lp-sequence")[0];
    this._timerFill = html.find(".lp-timer-fill")[0];
    this._currentIcon = html.find(".lp-current-icon")[0];
    this._statusText = html.find(".lp-status-text")[0];

    html.find('[data-action="cancel"]').on("click", (ev) => {
      ev.preventDefault();
      this._finish(false, "Abgebrochen");
    });

    // Minispiel vorbereiten & starten
    this._prepareGame();
    this._startGame();
  }

  async close(options) {
    this._stopTimer();
    window.removeEventListener("keydown", this._onKeyDown);
    return super.close(options);
  }

  /* ------------ Spielparameter ----------------------- */

  _prepareGame() {
    const { dc, bonus, disadvantage } = this.config;

    const diff = Math.max(0, dc - bonus);

    // Länge der Sequenz (3–8 Schritte)
    let steps = 3 + Math.floor(diff / 3);
    steps = Math.min(8, Math.max(3, steps));

    // Gesamtzeit (in Sekunden) – hier kannst du später leicht anpassen
    let baseTime = 10;              // Grundzeit
    baseTime += Math.max(0, (bonus - diff) * 0.2); // guter Skill → etwas mehr Zeit
    baseTime -= diff * 0.1;         // hoher DC → etwas weniger Zeit
    if (disadvantage) baseTime *= 0.8; // Nachteil → etwas straffer

    baseTime = Math.min(18, Math.max(6, baseTime)); // Clamp
    this.totalTimeMs = baseTime * 1000;

    // Zufällige Sequenz erzeugen
    this.sequence = [];
    for (let i = 0; i < steps; i++) {
      const k = LP_KEYS[Math.floor(Math.random() * LP_KEYS.length)];
      this.sequence.push(k);
    }
    this.currentIndex = 0;

    console.log("lockpicking-minigame | QTE-Setup:", {
      dc,
      bonus,
      disadvantage,
      steps: this.sequence.length,
      totalTimeSeconds: baseTime,
      sequenceInternal: this.sequence
    });
  }

  _startGame() {
    if (this.running) return;
    this.running = true;
    this.finished = false;
    this.failed = false;

    this._updateCurrentIcon();
    this.startTime = performance.now();
    this._updateTimer();

    window.addEventListener("keydown", this._onKeyDown);

    if (this._statusText) {
      this._statusText.textContent = "Minispiel läuft – drücke die angezeigten Pfeiltasten.";
    }
  }

  /* ------------ Anzeige aktueller Schritt ------------ */

  _updateCurrentIcon() {
    if (!this._currentIcon) return;

    if (this.currentIndex >= this.sequence.length) {
      this._currentIcon.src = "";
      this._currentIcon.alt = "";
      return;
    }

    const key = this.sequence[this.currentIndex];
    const src = LP_ICON_PATHS[key] ?? "";
    this._currentIcon.src = src;

    let label = "";
    switch (key) {
      case "up": label = "↑"; break;
      case "down": label = "↓"; break;
      case "left": label = "←"; break;
      case "right": label = "→"; break;
    }
    this._currentIcon.alt = label;
  }

  /* ------------ Timer / Fortschritt ------------------ */

  _updateTimer() {
    if (!this.running || this.finished) return;

    const now = performance.now();
    const elapsed = now - this.startTime;
    const ratio = Math.min(1, elapsed / this.totalTimeMs);

    if (this._timerFill) {
      const remaining = 1 - ratio;
      this._timerFill.style.width = `${remaining * 100}%`;

      // Farbverlauf grob: grün → gelb → rot
      if (remaining > 0.5) {
        this._timerFill.style.backgroundColor = "#4caf50";
      } else if (remaining > 0.25) {
        this._timerFill.style.backgroundColor = "#ffc107";
      } else {
        this._timerFill.style.backgroundColor = "#f44336";
      }
    }

    if (ratio >= 1) {
      this._finish(false, "Die Zeit ist abgelaufen.");
      return;
    }

    this._timerFrame = requestAnimationFrame(this._updateTimer.bind(this));
  }

  _stopTimer() {
    if (this._timerFrame) cancelAnimationFrame(this._timerFrame);
    this._timerFrame = null;
  }

  /* ------------ Tasteneingaben ----------------------- */

  _handleKeyDown(event) {
    if (!this.running || this.finished) return;

    const expectedKey = this.sequence[this.currentIndex];
    const pressed = LP_KEY_FROM_EVENT[event.key];

    // andere Tasten ignorieren
    if (!pressed) return;

    event.preventDefault();

    if (pressed !== expectedKey) {
      this._finish(false, "Falsche Taste gedrückt.");
      return;
    }

    // Richtige Taste → Schritt erfolgreich
    this._markStepAsDone(expectedKey);
    this.currentIndex++;

    if (this.currentIndex >= this.sequence.length) {
      this._finish(true, "Alle Tasten korrekt gedrückt.");
    } else {
      this._updateCurrentIcon();
    }
  }

  _markStepAsDone(key) {
    if (!this._sequenceContainer) return;

    const div = document.createElement("div");
    div.classList.add("lp-seq-step", "done");

    const img = document.createElement("img");
    img.classList.add("lp-seq-icon");
    img.src = LP_ICON_PATHS[key] ?? "";
    img.alt = "";

    div.appendChild(img);
    this._sequenceContainer.appendChild(div);
  }

  /* ------------ Abschluss & Chat-Ausgabe ------------- */

  async _finish(success, reason) {
    if (this.finished) return;
    this.finished = true;
    this.running = false;
    this.failed = !success;

    this._stopTimer();
    window.removeEventListener("keydown", this._onKeyDown);

    if (this._statusText) {
      this._statusText.textContent = success
        ? "Erfolg! Du knackst das Schloss."
        : `Fehlschlag: ${reason}`;
    }

    const { dc, bonus, disadvantage } = this.config;
    const steps = this.sequence.length;

    const flavor =
      `Lockpicking-Minispiel – ${this.actor.name} versucht ein Schloss zu knacken.<br>` +
      `DC ${dc}, Bonus ${bonus}${disadvantage ? ", mit Nachteil" : ", ohne Nachteil"}.<br>` +
      `Quick-Time-Event mit ${steps} Eingaben (Pfeiltasten).<br>` +
      (reason ? `Hinweis: ${reason}<br>` : "") +
      `Ergebnis: <b>${success ? "Erfolg" : "Misserfolg"}</b>.`;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content: flavor
    });

    ui.notifications[success ? "info" : "warn"](
      success ? "Du knackst das Schloss!" : "Das Schloss widersteht deinem Versuch."
    );

    // Fenster offen lassen, damit man den Status lesen kann
    // → der Spieler kann es selbst schließen
  }
}
