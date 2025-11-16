const MODULE_ID = "lockpicking-minigame";

console.log(`${MODULE_ID} | main.js geladen (globaler Kontext)`);

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init hook auf User=${game.user.id}, isGM=${game.user.isGM}`);
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready hook auf User=${game.user.id}, isGM=${game.user.isGM}`);

  // Einfaches Test-API im game-Namespace
  game.lockpickingTest = {
    ping() {
      ui.notifications.info(`LockpickingTest.ping() auf User=${game.user.id}`);
    }
  };

  console.log(`${MODULE_ID} | game.lockpickingTest gesetzt:`, typeof game.lockpickingTest);
});
