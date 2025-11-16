const MODULE_ID = "lockpicking-minigame";

console.log(`${MODULE_ID} | main.js geladen (globaler Kontext)`);

// Hier NICHT mehr auf game.user.id zugreifen, weil game.user noch null sein kann
Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init hook aufgerufen, game.user ist:`, game.user);
});

Hooks.once("ready", () => {
  const u = game.user;
  console.log(
    `${MODULE_ID} | ready hook aufgerufen auf Client`,
    {
      userId: u?.id ?? null,
      isGM: u?.isGM ?? null
    }
  );

  // Einfaches Test-API im game-Namespace
  game.lockpickingTest = {
    ping() {
      ui.notifications.info(
        `LockpickingTest.ping() auf User=${game.user?.id ?? "unbekannt"}`
      );
      console.log(`${MODULE_ID} | ping() wurde aufgerufen`, game.user);
    }
  };

  console.log(
    `${MODULE_ID} | game.lockpickingTest gesetzt:`,
    typeof game.lockpickingTest
  );
});
