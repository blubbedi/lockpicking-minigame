// scripts/main.js
const MODULE_ID = "lockpicking-minigame";

/**
 * Kleiner Helper fürs Logging
 */
function log(...args) {
  console.log(`${MODULE_ID} |`, ...args);
}

/**
 * GM: Konfigurationsdialog öffnen
 */
function openLockpickingConfig() {
  if (!game.user.isGM) {
    ui.notifications?.warn("Nur der SL kann das Lockpicking-Minispiel starten.");
    return;
  }

  // Alle Actoren mit Spieler-Besitzer
  const actors = game.actors.filter(a => a.hasPlayerOwner);
  if (!actors.length) {
    ui.notifications?.warn("Es gibt keine Charaktere mit Spielerbesitz.");
    return;
  }

  // Alle Nicht-GM-User
  const users = game.users.filter(u => !u.isGM);
  if (!users.length) {
    ui.notifications?.warn("Es sind keine Spieler im Spiel.");
    return;
  }

  const actorOptions = actors
    .map(a => `<option value="${a.id}">${a.name}</option>`)
    .join("");

  const userOptions = users
    .map(u => `<option value="${u.id}">${u.name}</option>`)
    .join("");

  const content = `
    <form>
      <div class="form-group">
        <label>Charakter:</label>
        <select name="actorId">
          ${actorOptions}
        </select>
      </div>

      <div class="form-group">
        <label>Schwierigkeitsgrad (DC):</label>
        <input type="number" name="dc" value="15" />
      </div>

      <div class="form-group">
        <label>Fertigkeitsbonus:</label>
        <input type="number" name="bonus" value="0" />
      </div>

      <div class="form-group">
        <label>Spieler:</label>
        <select name="userId">
          ${userOptions}
        </select>
      </div>
    </form>
  `;

  new Dialog({
    title: "Schlossknacken – Konfiguration",
    content,
    buttons: {
      start: {
        label: "Lockpicking starten",
        callback: html => {
          const form = html[0].querySelector("form");
          const fd = new FormData(form);

          const data = {
            action: "openMinigame",
            actorId: fd.get("actorId"),
            dc: Number(fd.get("dc")) || 10,
            bonus: Number(fd.get("bonus")) || 0,
            userId: fd.get("userId")
          };

          log("Config submit:", data);

          // Nachricht an alle Clients – der Zielspieler filtert nach userId
          game.socket.emit(`module.${MODULE_ID}`, data);

          const actor = game.actors.get(data.actorId);
          ChatMessage.create({
            speaker: { alias: "Lockpicking" },
            content: `Lockpicking-Minispiel für ${actor?.name ?? "Unbekannt"} gestartet (DC ${data.dc}, Bonus ${data.bonus}).`
          });
        }
      },
      cancel: {
        label: "Abbrechen"
      }
    },
    default: "start"
  }).render(true);
}

/**
 * Spieler: Einfaches Lockpicking-Minispiel anzeigen
 * (aktuell nur Testdialog, hier kann später das echte Minigame rein)
 */
function openLockpickingGame(actor, dc, bonus) {
  const bonusLabel = bonus >= 0 ? `+${bonus}` : `${bonus}`;

  const content = `
    <p><strong>${actor.name}</strong> versucht, das Schloss zu knacken!</p>
    <p>Schwierigkeit (DC): <strong>${dc}</strong>, Fertigkeitsbonus: <strong>${bonusLabel}</strong></p>

    <div class="lockpicking-bar" style="position:relative; height:20px; background:#444; border:1px solid #222; margin-top:8px;">
      <div class="lockpicking-highlight" style="position:absolute; top:0; bottom:0; width:20%; left:40%; background:#3a3;"></div>
      <div class="lockpicking-marker" style="position:absolute; top:0; bottom:0; width:4px; left:0; background:#fff;"></div>
    </div>

    <p style="margin-top:8px;"><em>Dies ist vorerst nur eine Testanzeige – hier kann später das eigentliche Minispiel eingebaut werden.</em></p>
  `;

  let intervalId = null;
  let position = 0;

  const dlg = new Dialog({
    title: `Schlossknacken – ${actor.name}`,
    content,
    buttons: {
      success: {
        label: "Erfolg!",
        callback: () => {
          clearInterval(intervalId);
          ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `${actor.name} knackt das Schloss erfolgreich!`
          });
        }
      },
      fail: {
        label: "Fehlschlag",
        callback: () => {
          clearInterval(intervalId);
          ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `${actor.name} scheitert beim Schlossknacken.`
          });
        }
      }
    },
    default: "success",
    close: () => {
      if (intervalId) clearInterval(intervalId);
    },
    render: html => {
      const marker = html[0].querySelector(".lockpicking-marker");
      const bar = html[0].querySelector(".lockpicking-bar");
      if (!marker || !bar) return;

      intervalId = setInterval(() => {
        position = (position + 2) % 100;
        marker.style.left = `${position}%`;
      }, 30);
    }
  });

  dlg.render(true);
}

/**
 * Hooks
 */
Hooks.once("ready", () => {
  log("ready – User:", game.user.id, "isGM:", game.user.isGM);

  // API für Makros: nur beim GM
  if (game.user.isGM) {
    game.lockpickingMinigame = {
      openConfig: openLockpickingConfig
    };
    log("GM-API registriert: game.lockpickingMinigame.openConfig()");
  }

  // Socket-Listener auf ALLEN Clients registrieren
  game.socket.on(`module.${MODULE_ID}`, data => {
    log("Socket received:", data, "auf User", game.user.id);

    if (!data || data.action !== "openMinigame") return;

    // Nur der angesprochene Spieler reagiert
    if (data.userId !== game.user.id) {
      return;
    }

    const actor = game.actors.get(data.actorId);
    if (!actor) {
      log("Actor nicht gefunden auf Client:", data.actorId);
      return;
    }

    openLockpickingGame(actor, data.dc, data.bonus);
  });
});
