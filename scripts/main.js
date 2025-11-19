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

      // Auto-Check: kann der Charakter DC überhaupt erreichen?
      const minTotal = bonus + 1;   // schlechtester Wurf (1)
      const maxTotal = bonus + 20;  // bester Wurf (20)

      if (maxTotal < dc) {
        // Unmöglich
        const content =
          `Lockpicking-Versuch von <b>${actor.name}</b> gegen DC ${dc}.<br>` +
          `Selbst mit einer 20 (max. ${maxTotal}) ist dieses Schloss <b>regeltechnisch unmöglich</b> zu knacken.`;
        await ChatMessage.create({
          content,
          speaker: { alias: "Lockpicking" }
        });
        ui.notifications.warn(`${actor.name} kann dieses Schloss regeltechnisch nicht knacken (DC zu hoch).`);
        return;
      }

      if (minTotal >= dc) {
        // Immer Erfolg → kein Minigame nötig
        const content =
          `Lockpicking-Versuch von <b>${actor.name}</b> gegen DC ${dc}.<br>` +
          `Mit Bonus ${bonus} erreicht ${actor.name} bereits mit einer 1 mindestens <b>${minTotal}</b> – der Versuch ist ein <b>automatischer Erfolg</b>.`;
        await ChatMessage.create({
          content,
          speaker: { alias: "Lockpicking" }
        });
        ui.notifications.info(`${actor.name} knackt das Schloss mühelos – kein Minispiel nötig.`);
        return;
      }

      console.log("lockpicking-minigame | Berechnete Werte:", {
        actor: actor.name,
        user: user.name,
        dc,
        dexMod,
        profBonus,
        profLevel,
        profLabel,
        bonus,
        disadvantage,
        minTotal,
        maxTotal
      });

      /* ----------------- Chat-Nachricht + Flag (QTE) ------------ */

      const content =
        `Lockpicking-QTE für <b>${actor.name}</b> gestartet ` +
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

      console.log("lockpicking-minigame | ChatMessage mit Flags erstellt (QTE).");
    } catch (err) {
      console.error("lockpicking-minigame | Fehler in _updateObject:", err);
      ui.notifications.error("Beim Start des Lockpicking-Minispiels ist ein Fehler aufgetreten. Siehe Konsole.");
    }
  }
}

/* ----------------------------------------- */
/*  Minigame-Fenster (Spieler) – QTE         */
/* ----------------------------------------- */

class LockpickingGameApp extends Application {
  constructor(actor, config, options = {}) {
    super(options);
    this.actor = actor;
    this.config = config; // { dc, bonus, disadvantage, ... }

    // QTE-Status
    this.sequence = [];          // interne Keys (z.B. 'q','w',...)
    this.displaySequence = [];   // Anzeige (z.B. 'Q','W',...)
    this.currentIndex = 0;

    this.timeLimit = 0;          // Gesamtzeit (Sekunden)
    this.remainingTime = 0;      // Restzeit
    this.running = false;
    this.finished = false;

    this._timerInterval = null;
    this._keyHandler = this._onKeyDown.bind(this);

    // DOM-Refs
    this._html = null;
    this._startButton = null;
    this._timerEl = null;
    this._timerFillEl = null;
    this._currentKeyEl = null;
    this._keyStepsEls = [];

    // direkt beim Erzeugen: Sequenz & Zeit basierend auf DC / Bonus berechnen
    this._setupQTEParameters();
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-game",
      classes: ["lockpicking-game"],
      title: "Lockpicking",
      template: "modules/lockpicking-minigame/templates/lock-game.hbs",
      width: 480,
      height: "auto",
      resizable: false
    });
  }

  /** Sequenz & Zeit abhängig von DC / Bonus / Nachteil bestimmen */
  _setupQTEParameters() {
    const dc = Number(this.config.dc ?? 10);
    const bonus = Number(this.config.bonus ?? 0);
    const disadvantage = !!this.config.disadvantage;

    const diff = Math.max(0, dc - bonus);

    // Sequenzlänge: Basis 3, wird mit höherem diff länger, mit Deckel
    let length = 3 + Math.round(diff / 4); // diff 0 →3, diff 8→5, diff 16→7
    length = Math.max(3, Math.min(8, length));

    if (disadvantage) {
      length = Math.min(length + 1, 9);
    }

    // Zeitlimit: Basis 6s, modifiziert durch (Bonus - DC), gekappt
    let timeLimit = 10 + (bonus - dc) * 0.2;
    timeLimit = Math.max(2, Math.min(10, timeLimit));
    if (disadvantage) timeLimit *= 0.75;

    this.timeLimit = timeLimit;
    this.remainingTime = timeLimit;

    // Tastenpool – bewusst wenige, leicht erreichbare Tasten
    const KEY_POOL = ["w","a", "s", "d"];

    this.sequence = [];
    this.displaySequence = [];
    for (let i = 0; i < length; i++) {
      const key = KEY_POOL[Math.floor(Math.random() * KEY_POOL.length)];
      this.sequence.push(key);
      this.displaySequence.push(key.toUpperCase());
    }

    console.log("lockpicking-minigame | QTE-Parameter:", {
      dc,
      bonus,
      disadvantage,
      diff,
      sequence: this.sequence,
      timeLimit: this.timeLimit
    });
  }

  getData(options) {
    const dc = Number(this.config.dc ?? 10);
    const bonus = Number(this.config.bonus ?? 0);
    const disadvantage = !!this.config.disadvantage;

    const keyCount = this.displaySequence.length;
    const keySteps = [];
    for (let i = 0; i < keyCount; i++) {
      keySteps.push({ index: i });
    }

    return {
      actorName: this.actor.name,
      dc,
      bonus,
      disadvantage,
      timeLimit: this.timeLimit.toFixed(1),
      keyCount,
      keySteps
    };
  }

  /* --------- Rendering & Listener ---------------- */

  activateListeners(html) {
    super.activateListeners(html);

    this._html = html;
    this._startButton = html.find('[data-action="start"]')[0];
    this._timerEl = html.find(".lp-timer-value")[0];
    this._timerFillEl = html.find(".lp-timer-fill")[0];
    this._currentKeyEl = html.find(".lp-current-key")[0];
    this._keyStepsEls = html.find(".lp-key-step").toArray();

    // Initialanzeige
    this._updateTimerDisplay();
    this._renderSequence();

    html.find('[data-action="start"]').on("click", this._onStartClick.bind(this));
    html.find('[data-action="close"]').on("click", (ev) => {
      ev.preventDefault();
      this._endGame(false, { aborted: true });
    });
  }

  _renderSequence() {
    // kleine Symbole für Anzahl der Tasten
    if (this._keyStepsEls?.length) {
      this._keyStepsEls.forEach((el, idx) => {
        el.classList.toggle("lp-key-step--done", idx < this.currentIndex);
        el.classList.toggle("lp-key-step--active", idx === this.currentIndex);
        el.classList.toggle("lp-key-step--upcoming", idx > this.currentIndex);
      });
    }

    // aktuelle Taste anzeigen
    if (this._currentKeyEl) {
      if (this.finished) {
        this._currentKeyEl.textContent = "✓";
      } else if (!this.running) {
        // vor Start nur Platzhalter
        this._currentKeyEl.textContent = "?";
      } else {
        const key = this.displaySequence[this.currentIndex] ?? "?";
        this._currentKeyEl.textContent = key;
      }
    }
  }

  _updateTimerDisplay() {
    if (this._timerEl) {
      this._timerEl.textContent =
        this.remainingTime.toFixed(1).replace(".", ",") + " s";
    }

    if (this._timerFillEl) {
      const ratio = Math.max(0, Math.min(1, this.remainingTime / this.timeLimit || 1));
      this._timerFillEl.style.width = `${ratio * 100}%`;
    }
  }

  _startGame() {
    if (this.running || this.finished) return;

    this.running = true;
    this.finished = false;
    this.currentIndex = 0;
    this.remainingTime = this.timeLimit;
    this._updateTimerDisplay();
    this._renderSequence(); // zeigt erste Taste an

    if (this._startButton) {
      this._startButton.textContent = "QTE läuft – drücke die Taste!";
      this._startButton.disabled = true;
    }

    window.addEventListener("keydown", this._keyHandler, true);

    this._timerInterval = setInterval(() => {
      if (!this.running) return;
      this.remainingTime -= 0.1;
      if (this.remainingTime <= 0) {
        this.remainingTime = 0;
        this._updateTimerDisplay();
        this._endGame(false, { reason: "timeout" });
      } else {
        this._updateTimerDisplay();
      }
    }, 100);
  }

  _onStartClick(event) {
    event.preventDefault();
    if (!this.running && !this.finished) {
      this._startGame();
    }
  }

  _onKeyDown(event) {
    if (!this.running || this.finished) return;

    const key = (event.key || "").toLowerCase();
    const expected = this.sequence[this.currentIndex];

    // Nur Eingaben aus unserem Pool interessieren uns überhaupt
    const KEY_POOL = ["w","a", "s", "d"];
    if (!KEY_POOL.includes(key)) return;

    event.preventDefault();
    event.stopPropagation();

    if (key === expected) {
      this.currentIndex++;
      this._renderSequence();

      if (this.currentIndex >= this.sequence.length) {
        this._endGame(true, { reason: "completed" });
      }
    } else {
      // Falsche Taste → sofortiger Fehlschlag
      this._endGame(false, { reason: "wrong-key", pressed: key, expected });
    }
  }

  _cleanup() {
    this.running = false;

    if (this._timerInterval) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
    }

    window.removeEventListener("keydown", this._keyHandler, true);
  }

  async _endGame(success, details = {}) {
    if (this.finished) return;
    this.finished = true;
    this._cleanup();

    if (this._startButton) {
      this._startButton.disabled = true;
    }

    // Wenn der Spieler einfach abbricht, kein Chatspam
    if (details.aborted) {
      await this.close();
      return;
    }

    const { dc, bonus, disadvantage } = this.config;

    let reasonText = "";
    if (details.reason === "timeout") {
      reasonText = " – die Zeit ist abgelaufen.";
    } else if (details.reason === "wrong-key") {
      reasonText =
        ` – falsche Taste gedrückt (erwartet: ${details.expected?.toUpperCase()}, ` +
        `gedrückt: ${details.pressed?.toUpperCase()}).`;
    } else if (details.reason === "completed") {
      reasonText = " – alle Tasten wurden rechtzeitig korrekt eingegeben.";
    }

    const seqString = this.displaySequence.join(" → ");

    const flavor =
      `Lockpicking-QTE – ${this.actor.name} versucht ein Schloss zu knacken.<br>` +
      `DC ${dc}, Bonus ${bonus}${disadvantage ? ", mit Nachteil" : ", ohne Nachteil"}.<br>` +
      `Zugrunde liegende Tastenfolge: <code>${seqString}</code><br>` +
      `Ergebnis: <b>${success ? "Erfolg" : "Misserfolg"}</b>${reasonText}`;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      content: flavor
    });

    ui.notifications[success ? "info" : "warn"](
      success ? "Du knackst das Schloss!" : "Das Schloss widersteht deinem Versuch."
    );

    await this.close();
  }

  async close(options) {
    this._cleanup();
    return super.close(options);
  }
}
