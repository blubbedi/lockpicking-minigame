const MODULE_ID = "lockpicking-minigame";

/**
 * Kleines Lockpicking-Minispiel
 * - GM startet per Makro
 * - Minigame öffnet sich beim Spieler, der den Actor besitzt
 */

/* ----------------------------------------- */
/*  Basis: Minigame-Application              */
/* ----------------------------------------- */

class LockpickingGameApp extends Application {
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.dc = Number(options.dc) || 15;
    this.bonus = Number(options.bonus) || 0;

    // Minigame-State
    this._interval = null;
    this._position = 0;        // 0..1
    this._direction = 1;       // 1 oder -1
    this._running = false;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "lockpicking-game",
      title: "Schlossknacken",
      template: `modules/${MODULE_ID}/templates/lock-game.hbs`,
      classes: ["lockpicking-game"],
      width: 480,
      height: "auto",
      resizable: false
    });
  }

  getData(options = {}) {
    const data = super.getData(options);
    data.actor = this.actor;
    data.dc = this.dc;
    data.bonus = this.bonus;
    data.position = this._position;
    return data;
  }

  activateListeners(html) {
    super.activateListeners(html);

    const startBtn = html.find("button.lp-start");
    const stopBtn = html.find("button.lp-stop");

    startBtn.on("click", (ev) => {
      ev.preventDefault();
      this._startMovement(html);
    });

    stopBtn.on("click", (ev) => {
      ev.preventDefault();
      this._stopAndResolve(html);
    });
  }

  _startMovement(html) {
    if (this._running) return;
    this._running = true;

    const bar = html.find(".lp-bar-fill")[0];
    if (!bar) return;

    this._interval = setInterval(() => {
      // Position bewegen
      this._position += 0.02 * this._direction;
      if (this._position >= 1) {
        this._position = 1;
        this._direction = -1;
      } else if (this._position <= 0) {
        this._position = 0;
        this._direction = 1;
      }

      // Visuell aktualisieren
      bar.style.width = `${this._position * 100}%`;
    }, 30);
  }

  async _stopAndResolve(html) {
    if (!this._running) return;
    this._running = false;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }

    // Trefferzone in der Mitte (z.B. 0.4–0.6)
    const minZone = 0.4;
    const maxZone = 0.6;
    const inSweetSpot = this._position >= minZone && this._position <= maxZone;

    // Würfelwurf nur, wenn außerhalb Sweet Spot -> leichter Bonus / Malus möglich
    let rollResult;
    if (inSweetSpot) {
      // Vorteil: Mindestwurf 10
      const roll = await new Roll("1d20").roll({ async: true });
      const value = Math.max(10, roll.total);
      rollResult = { roll, value };
    } else {
      const roll = await new Roll("1d20").roll({ async: true });
      rollResult = { roll, value: roll.total };
    }

    const total = rollResult.value + this.bonus;
    const success = total >= this.dc;

    // Chat-Ausgabe
    const roll = rollResult.roll;
    const flavor = `
      <p><strong>${this.actor.name}</strong> versucht das Schloss zu knacken.</p>
      <ul>
        <li>DC: ${this.dc}</li>
        <li>Bonus: ${this.bonus >= 0 ? "+" + this.bonus : this.bonus}</li>
        <li>Wurf: ${roll.total} (effektiv ${rollResult.value})</li>
        <li>Gesamt: ${total}</li>
      </ul>
      <p><strong>Ergebnis: ${success ? "Erfolg ✔" : "Fehlschlag ✘"}</strong></p>
    `;

    roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      flavor
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

/* ----------------------------------------- */
/*  Ready-Hook & Socket-Handling             */
/* ----------------------------------------- */

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready on user=${game.user.id}`);

  // Socket-Listener auf ALLEN Clients
  game.socket.on(`module.${MODULE_ID}`, async (data) => {
    if (!data || data.action !== "openMinigame") return;

    console.log(
      `${MODULE_ID} | socket received`,
      data,
      "on user",
      game.user.id
    );

    // Falls eine userId gesetzt ist, nur für diesen Client reagieren
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

  // Optional: kleine Helper-API bereitstellen
  game.lockpickingMinigame = {
    openForActor(actor, { dc = 15, bonus = 0 } = {}, userId = null) {
      game.socket.emit(`module.${MODULE_ID}`, {
        action: "openMinigame",
        actorId: actor.id,
        dc,
        bonus,
        userId
      });
    }
  };

  console.log(`${MODULE_ID} | API registered: game.lockpickingMinigame`);
});
