// scripts/main.js

const MODULE_ID = "lockpicking-minigame";

/* ===========================
 *  Hilfsfunktionen
 * =========================*/

/**
 * Fingerfertigkeit-Bonus + passiver Wert + Verlässliches Talent
 * DnD5e-orientiert, aber mit Fallbacks.
 */
function computeLockpickingValues(actor) {
  const system = actor.system ?? {};
  const abilities = system.abilities ?? {};
  const dexMod = abilities.dex?.mod ?? 0;

  const skills = system.skills ?? {};
  // verschiedene mögliche Keys: sle (engl), slt, slh etc.
  const sle = skills.sle ?? skills.slt ?? skills.slh ?? null;
  let skillBonus = 0;

  if (sle && typeof sle.total === "number") {
    skillBonus = sle.total;
  } else if (sle && typeof sle.mod === "number") {
    skillBonus = sle.mod + (sle.prof || 0);
  } else {
    skillBonus = dexMod;
  }

  const passive = 10 + skillBonus;
  const reliable = hasReliableTalent(actor);

  return { bonus: skillBonus, passive, reliable };
}

/**
 * Prüft, ob der Actor ein Feature "Verlässliches Talent" / "Reliable Talent" hat.
 */
function hasReliableTalent(actor) {
  if (!actor.items) return false;
  return actor.items.some((i) =>
    i.type === "feat" &&
    /verlässliches talent|reliable talent/i.test(i.name ?? "")
  );
}

/**
 * Sucht den Besitzer des Actors (Spieler mit OWNER-Recht), Fallback: aktiver GM.
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

/* ===========================
 *  GM-Konfiguration
 * =========================*/

class LockpickingConfigApp extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-config",
      title: "Schlossknacken",
      template: `modules/${MODULE_ID}/templates/lock-config.hbs`,
      width: 450,
      closeOnSubmit: true
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

    return {
      actors,
      defaultDc: 15
    };
  }

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

    // Auto-Erfolg?
    if (passive >= dc) {
      const content = `
        <p><strong>${actor.name}</strong> knackt das Schloss ohne Mühe.</p>
        <ul>
          <li>DC: <strong>${dc}</strong></li>
          <li>Fingerfertigkeits-Bonus: <strong>${bonus >= 0 ? "+" : ""}${bonus}</strong></li>
          <li>Passiver Wert: <strong>${passive}</strong>${reliable ? " (Verlässliches Talent)" : ""}</li>
        </ul>
        <p>Kein Minispiel nötig – der Charakter ist zu geübt.</p>
      `;
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content
      });
      return;
    }

    // Kein Auto-Erfolg → Chat-Hinweis & Minigame an Spieler schicken
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `
        <p><strong>${actor.name}</strong> versucht, ein Schloss zu knacken.</p>
        <ul>
          <li>DC: <strong>${dc}</strong></li>
          <li>Fingerfertigkeits-Bonus: <strong>${bonus >= 0 ? "+" : ""}${bonus}</strong></li>
          <li>Passiver Wert: <strong>${passive}</strong>${reliable ? " (Verlässliches Talent)" : ""}</li>
        </ul>
        <p>Ein Minispiel ist erforderlich.</p>
      `
    });

    const targetUser = findControllingUser(actor);

    const payload = {
      action: "openLockpickingGame",
      actorId: actor.id,
      dc,
      bonus,
      userId: targetUser ? targetUser.id : null
    };

    console.log(`${MODULE_ID} | sending socket`, payload);
    game.socket.emit(`module.${MODULE_ID}`, payload);

    ui.notifications.info(
      `Lockpicking-Minispiel an ${targetUser ? targetUser.name : "Spieler"} gesendet.`
    );
  }
}

/* ===========================
 *  Minigame-App (Spieler)
 * =========================*/

class LockpickingGameApp extends Application {
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.dc = Number(options.dc) || 10;
    this.bonus = Number(options.bonus) || 0;

    this.position = 0;    // 0–100
    this.direction = 1;
    this.interval = null;
    this.running = false;

    this.targetMin = 35;
    this.targetMax = 65;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-game",
      title: "Schlossknacken",
      template: `modules/${MODULE_ID}/templates/lock-game.hbs`,
      width: 500,
      height: "auto",
      resizable: false
    });
  }

  getData() {
    return {
      actor: this.actor,
      dc: this.dc,
      bonus: this.bonus,
      position: this.position,
      targetMin: this.targetMin,
      targetMax: this.targetMax
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    this._barFill = html.find(".lp-bar-fill");

    html.find("[data-action='start']").on("click", () => this._start());
    html.find("[data-action='stop']").on("click", () => this._stopAndRoll());

    this._renderBar();
  }

  close(options) {
    this._stopMovement();
    return super.close(options);
  }

  /* ---- Minigame-Logik ---- */

  _start() {
    if (this.running) return;
    this.running = true;

    const width = 15 + Math.random() * 15; // 15–30 % breit
    const start = 20 + Math.random() * (60 - width);
    this.targetMin = start;
    this.targetMax = start + width;

    const speed = 0.04; // „Geschwindigkeit“

    this.interval = setInterval(() => {
      this.position += speed * this.direction * 16;
      if (this.position >= 100) {
        this.position = 100;
        this.direction = -1;
      } else if (this.position <= 0) {
        this.position = 0;
        this.direction = 1;
      }
      this._renderBar();
    }, 16);
  }

  async _stopAndRoll() {
    if (!this.running) return;
    this._stopMovement();

    const pos = this.position;
    const inZone = pos >= this.targetMin && pos <= this.targetMax;

    // Wenn in der Zone → Vorteil (2d20kh), sonst normaler Wurf
    const formula = inZone
      ? `2d20kh + ${this.bonus}`
      : `1d20 + ${this.bonus}`;

    const roll = await new Roll(formula).roll({ async: true });
    const total = roll.total;
    const success = total >= this.dc;

    const content = `
      <p><strong>${this.actor.name}</strong> versucht das Schloss zu knacken.</p>
      <ul>
        <li>Leistenposition: ${Math.round(pos)}%</li>
        <li>Zielbereich: ${Math.round(this.targetMin)}–${Math.round(this.targetMax)}%</li>
        <li>Wurf: ${roll.result} = <strong>${total}</strong> (DC ${this.dc})</li>
      </ul>
      <p><strong>${success ? "Erfolg!" : "Fehlschlag."}</strong></p>
    `;

    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      flavor: "Schlossknacken-Minispiel",
      content
    });

    this.close();
  }

  _stopMovement() {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  _renderBar() {
    if (!this._barFill) return;
    this._barFill.css("width", `${Math.max(0, Math.min(100, this.position))}%`);
  }
}

/* ===========================
 *  Hooks & Socket
 * =========================*/

Hooks.once("ready", () => {
  console.log(
    `${MODULE_ID} | ready, user=${game.user.id}, isGM=${game.user.isGM}`
  );

  // API für Makros
  game.lockpickingMinigame = {
    openConfig() {
      if (!game.user.isGM) {
        ui.notifications.info(
          "Nur der GM kann die Lockpicking-Konfiguration öffnen."
        );
        return;
      }
      new LockpickingConfigApp().render(true);
    }
  };

  // Socket-Listener – auf allen Clients
  game.socket.on(`module.${MODULE_ID}`, (data) => {
    if (!data || data.action !== "openLockpickingGame") return;

    console.log(
      `${MODULE_ID} | socket received`,
      data,
      "on user",
      game.user.id
    );

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

/* ---------------- Makro-Kompatibilität (optional) ---------------- */

window.LockpickingConfigApp = LockpickingConfigApp;
window.LockpickingGameApp = LockpickingGameApp;
window.openLockpickingConfig = function () {
  game.lockpickingMinigame?.openConfig();
};
