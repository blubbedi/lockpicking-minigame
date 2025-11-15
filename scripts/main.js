// scripts/main.js

const MODULE_ID = "lockpicking-minigame";

/* ----------------------- Konfiguration (GM-Dialog) ----------------------- */

class LockpickingConfigApp extends FormApplication {
  static get defaultOptions() {
    const opts = super.defaultOptions;
    return foundry.utils.mergeObject(opts, {
      id: "lockpicking-config",
      title: "Schlossknacken",
      template: `modules/${MODULE_ID}/templates/lock-config.hbs`,
      width: 480,
      closeOnSubmit: true,
      submitOnChange: false,
      submitOnClose: false
    });
  }

  getData() {
    const tokens = canvas?.tokens?.placeables ?? [];
    const seen = new Set();
    const actors = [];

    for (const t of tokens) {
      const a = t.actor;
      if (!a) continue;
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      actors.push({ id: a.id, name: a.name });
    }

    const defaultDc = game.settings.get(MODULE_ID, "defaultDc") ?? 15;

    return {
      actors,
      defaultDc
    };
  }

  /**
   * Wird aufgerufen, wenn im Konfig-Dialog auf "Lockpicking starten" geklickt wird.
   */
  async _updateObject(event, formData) {
    const actorId = formData.actorId;
    const dc = Number(formData.dc) || 10;

    const actor = game.actors.get(actorId);
    if (!actor) {
      ui.notifications.error("Kein gültiger Charakter ausgewählt.");
      return;
    }

    const { bonus, passive, reliable } = computeLockpickingValues(actor);

    console.log(
      `${MODULE_ID} | Actor=${actor.name}, Bonus=${bonus}, Passive=${passive}, DC=${dc}, Reliable=${reliable}`
    );

    // 1) Auto-Erfolg über passiven Wert
    if (passive >= dc) {
      await postChatResult({
        actor,
        dc,
        bonus,
        passive,
        reliable,
        auto: true
      });
      return;
    }

    // 2) Minigame wird benötigt
    await postChatResult({
      actor,
      dc,
      bonus,
      passive,
      reliable,
      auto: false
    });

    const targetUser = findControllingUser(actor);

    const payload = {
      action: "openMinigame",
      actorId: actor.id,
      dc,
      bonus,
      userId: targetUser ? targetUser.id : null
    };

    console.log(`${MODULE_ID} | Sending openMinigame`, payload);
    game.socket.emit(`module.${MODULE_ID}`, payload);
  }
}

/* ----------------------------- Minigame-App ------------------------------ */

class LockpickingGameApp extends Application {
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.dc = Number(options.dc) || 10;
    this.bonus = Number(options.bonus) || 0;

    // Minigame-State
    this.position = 0;      // 0–100 (Prozent)
    this.direction = 1;     // +1 / -1
    this.interval = null;
    this.isRunning = false;

    // Zielbereich auf der Leiste (in Prozent)
    this.targetMin = 35;
    this.targetMax = 65;
  }

  static get defaultOptions() {
    const opts = super.defaultOptions;
    return foundry.utils.mergeObject(opts, {
      id: "lockpicking-game",
      title: "Schlossknacken",
      template: `modules/${MODULE_ID}/templates/lock-game.hbs`,
      width: 520,
      height: "auto",
      resizable: true
    });
  }

  getData() {
    return {
      actor: this.actor,
      dc: this.dc,
      bonus: this.bonus,
      targetMin: this.targetMin,
      targetMax: this.targetMax,
      position: this.position
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Elemente im Template:
    //  - .lp-bar        : Container der Leiste
    //  - .lp-bar-fill   : der bewegte Balken
    //  - [data-action="start"] : Button "Bewegung starten"
    //  - [data-action="stop"]  : Button "Jetzt knacken!"
    this._bar = html.find(".lp-bar-fill");
    this._barContainer = html.find(".lp-bar");

    html.find("[data-action='start']").on("click", this._onStart.bind(this));
    html.find("[data-action='stop']").on("click", this._onStop.bind(this));
  }

  close(options) {
    this._stopMovement();
    return super.close(options);
  }

  /* ---------------------------- Button-Logik ---------------------------- */

  _onStart() {
    if (this.isRunning) return;
    this.isRunning = true;

    // Zufällige Startrichtung
    this.direction = Math.random() < 0.5 ? -1 : 1;

    const stepMs = 16; // ~60 FPS
    this.interval = setInterval(() => this._tick(stepMs), stepMs);
  }

  async _onStop() {
    if (!this.isRunning) return;
    this._stopMovement();

    const pos = this.position;
    const inRange = pos >= this.targetMin && pos <= this.targetMax;

    const roll = await new Roll(`1d20 + ${this.bonus}`).roll({ async: true });
    const total = roll.total;

    const success = inRange && total >= this.dc;

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      flavor: "Schlossknacken – Versuch",
      content: `
        <p><strong>${this.actor.name}</strong> versucht das Schloss zu knacken.</p>
        <ul>
          <li>Zielbereich auf der Leiste: ${this.targetMin}&ndash;${this.targetMax}%</li>
          <li>Gestoppte Position: ${Math.round(pos)}%</li>
          <li>Wurf: ${roll.result} = <strong>${total}</strong> (DC ${this.dc})</li>
        </ul>
        <p><strong>${success ? "Erfolg!" : "Fehlschlag!"}</strong></p>
      `
    });

    if (success) {
      ui.notifications.info("Das Schloss wurde geknackt!");
    } else {
      ui.notifications.warn("Das Schloss bleibt verschlossen.");
    }

    this.close();
  }

  _stopMovement() {
    this.isRunning = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /* ---------------------------- Bewegung / Tick ---------------------------- */

  _tick(deltaMs) {
    const speed = 0.04; // Prozent pro ms -> 0.04 * 16 ≈ 0.64 pro Frame
    this.position += this.direction * speed * deltaMs;

    // Grenzen & Richtung umkehren
    if (this.position >= 100) {
      this.position = 100;
      this.direction = -1;
    } else if (this.position <= 0) {
      this.position = 0;
      this.direction = 1;
    }

    this._renderBar();
  }

  _renderBar() {
    if (!this._bar || !this._bar.length) return;
    this._bar.css("width", `${this.position}%`);
  }
}

/* --------------------------- Hilfsfunktionen ---------------------------- */

/**
 * Berechnet Bonus, passiven Wert und "Verlässliches Talent" für den Actor.
 */
function computeLockpickingValues(actor) {
  const system = actor.system ?? {};
  const abilities = system.abilities ?? {};
  const dexMod = abilities.dex?.mod ?? 0;

  const skills = system.skills ?? {};
  const sle = skills.sle ?? skills.slh ?? null; // je nach Sprach-/Systemvariante
  let skillBonus = 0;

  if (sle && typeof sle.total === "number") {
    skillBonus = sle.total;
  } else if (sle && typeof sle.mod === "number") {
    skillBonus = sle.mod + (sle.prof || 0);
  } else {
    // Fallback: nur DEX-Modifikator
    skillBonus = dexMod;
  }

  const passive = 10 + skillBonus;
  const reliable = hasReliableTalent(actor);

  return { bonus: skillBonus, passive, reliable };
}

/**
 * Prüft, ob der Actor das Merkmal "Verlässliches Talent" / "Reliable Talent" besitzt.
 */
function hasReliableTalent(actor) {
  if (!actor.items) return false;
  return actor.items.some((i) =>
    i.type === "feat" &&
    /verlässliches talent|reliable talent/i.test(i.name)
  );
}

/**
 * Schreibt ein Ergebnis in den Chat (Auto-Erfolg oder Minigame nötig).
 */
async function postChatResult({ actor, dc, bonus, passive, reliable, auto }) {
  const lines = [];
  lines.push(`<li>DC: <strong>${dc}</strong></li>`);
  lines.push(
    `<li>Fingerfertigkeits-Bonus: <strong>${bonus >= 0 ? "+" : ""}${bonus}</strong></li>`
  );
  lines.push(
    `<li>Passiver Wert: <strong>${passive}</strong>${
      reliable ? " (Verlässliches Talent)" : ""
    }</li>`
  );

  let intro;
  let footer;

  if (auto) {
    if (reliable && passive >= dc) {
      intro = `${actor.name} knackt das Schloss mühelos.`;
      footer =
        "Dank Verlässlichem Talent ist ein Fehlschlag praktisch ausgeschlossen.";
    } else {
      intro = `${actor.name} knackt das Schloss ohne großes Risiko.`;
      footer = "Kein Minispiel nötig – der passive Wert reicht aus.";
    }
  } else {
    intro = `${actor.name} versucht das Schloss zu knacken…`;
    footer =
      "Der passive Wert reicht nicht aus – ein Minispiel ist erforderlich.";
  }

  const content = `
    <p><strong>${intro}</strong></p>
    <ul>${lines.join("")}</ul>
    <p>${footer}</p>
  `;

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content
  });
}

/**
 * Sucht den Spieler, der den Actor kontrolliert. Fallback: aktiver GM.
 */
function findControllingUser(actor) {
  const users = game.users.contents ?? game.users;

  const owners = users.filter((u) => {
    if (u.isGM) return false;
    try {
      if (typeof actor.testUserPermission === "function") {
        return actor.testUserPermission(
          u,
          CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
        );
      }
      const lvl = actor.ownership?.[u.id];
      return lvl >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
    } catch (e) {
      return false;
    }
  });

  if (owners.length > 0) return owners[0];

  const gms = users.filter((u) => u.isGM && u.active);
  return gms[0] ?? null;
}

/* ------------------------- Initialisierung & Socket ---------------------- */

Hooks.once("ready", () => {
  console.log(
    `${MODULE_ID} | ready, user=${game.user.id}, isGM=${game.user.isGM}`
  );

  // Globales Objekt für Makros
  game.lockpickingMinigame = {
    openConfig() {
      if (!game.user.isGM) {
        ui.notifications.info(
          "Nur der GM kann die Lockpicking-Konfiguration öffnen."
        );
        return;
      }
      const app = new LockpickingConfigApp();
      app.render(true);
    }
  };

  // Socket-Listener – läuft auf ALLEN Clients
  game.socket.on(`module.${MODULE_ID}`, (data) => {
    if (!data || data.action !== "openMinigame") return;

    console.log(
      `${MODULE_ID} | socket received`,
      data,
      "on user",
      game.user.id
    );

    // Wenn ein bestimmter User adressiert ist, nur dieser reagiert
    if (data.userId && data.userId !== game.user.id) return;

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

/* --------------------------- Makro-Kompatibilität ------------------------ */

// Für alte Makros, die noch window.* verwenden
window.LockpickingGameApp = LockpickingGameApp;
window.LockpickingConfigApp = LockpickingConfigApp;
window.openLockpickingConfig = function () {
  if (!game.user.isGM) {
    ui.notifications.info(
      "Nur der GM kann die Lockpicking-Konfiguration öffnen."
    );
    return;
  }
  const app = new LockpickingConfigApp();
  app.render(true);
};
