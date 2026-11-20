const MODULE_ID = "trashs-dynamic-camera";
const TARGET_SOCKET = `module.${MODULE_ID}`;
const SETTING = "enabled";
const SHOW_TARGET_PINGS = "showTargetPings";
const PLAYER_ZOOM = "playerZoom";
const SMOOTH_CAMERA = "smoothCamera";
const TRANSITION_DURATION = "transitionDuration";
const OUT_OF_COMBAT = "outOfCombatFollowing";
const OUT_OF_COMBAT_VIEWING_MODE = "viewingMode";
const IN_COMBAT_VIEWING_MODE = "combatViewingMode";
const VIEWING_MODES = [
  { value: "justPlayer", label: "Just Player" },
  { value: "allPlayers", label: "All Players" },
  { value: "visibleMonsters", label: "All Players And Visible Monsters" },
  { value: "allMonsters", label: "All Players And All Monsters" }
];
const DEFAULT_VIEWING_MODE = "visibleMonsters";
const COMBAT_VIEWING_MODES = [
  VIEWING_MODES[0],
  { value: "playerAndTargets", label: "Just Player and Targets" },
  ...VIEWING_MODES.slice(1)
];
const PLAYER_POV = "seePlayerPOV";
const MONSTER_POV = "monsterPOV";
const PLAYER_ZOOM_DEFAULT = 50;
const PLAYER_ZOOM_RANGE = { min: 10, max: 250 };
let targetUpdateQueued = false;
const sharedTargets = new Map();
const settingsObservers = new WeakMap();
const boundSmoothCameraInputs = new WeakSet();
let povToken;
let previousSelection = [];
const suppressedGraphics = new Map();

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING, {
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
    onChange: (enabled) => {
      if (enabled) followScene();
    }
  });
  game.settings.register(MODULE_ID, OUT_OF_COMBAT, {
    name: "Out Of Combat Following",
    hint: "Follow tokens outside combat while Follow Turns is on.",
    scope: "user",
    config: true,
    type: Boolean,
    default: false,
    onChange: (enabled) => {
      if (enabled) frameParty();
    }
  });
  registerViewingMode(OUT_OF_COMBAT_VIEWING_MODE, VIEWING_MODES,
    "Choose which tokens to frame outside combat. Just Player is best suited to players. GMs and Assistant GMs must select tokens to use it.",
    frameParty);
  registerViewingMode(IN_COMBAT_VIEWING_MODE, COMBAT_VIEWING_MODES,
    "Choose which tokens to frame during combat. Just Player follows the active player’s tokens. Just Player and Targets also frames their visible targets.",
    () => followTurn(game.combats.active, { allowOwnTurn: true }));
  game.settings.register(MODULE_ID, SHOW_TARGET_PINGS, {
    name: "Show Target Pings",
    hint: "Show pings when the active combatant targets a token. Player-to-player pings are green. Other pings are red.",
    scope: "user",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(MODULE_ID, PLAYER_ZOOM, {
    name: "Player Turn Zoom",
    hint: "Set the camera distance when following a player's token alone. Lower values zoom in and higher values zoom out. Default is 50.",
    scope: "user",
    config: true,
    type: new foundry.data.fields.NumberField({ ...PLAYER_ZOOM_RANGE, integer: true }),
    input: (_field, config) => foundry.applications.elements.HTMLRangePickerElement.create({
      ...config,
      ...PLAYER_ZOOM_RANGE,
      step: 1
    }),
    default: PLAYER_ZOOM_DEFAULT,
    onChange: () => {
      const combat = game.combats.active;
      if (combat?.combatant?.hasPlayerOwner) followTurn(combat);
    }
  });
  game.settings.register(MODULE_ID, SMOOTH_CAMERA, {
    name: "Smooth Camera",
    hint: "Ease the camera into position when it pans or zooms automatically.",
    scope: "user",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(MODULE_ID, TRANSITION_DURATION, {
    name: "Transition Duration",
    hint: "Set how long a smooth camera move takes. Enter 0.4 to 3 seconds. Default is 1 second.",
    scope: "user",
    config: true,
    type: new foundry.data.fields.NumberField({ min: 0.4, max: 3, step: 0.01 }),
    default: 1
  });
  game.settings.register(MODULE_ID, PLAYER_POV, {
    name: "See Player POV",
    hint: "On a player's turn, see through their token's vision and senses.",
    scope: "user",
    config: true,
    type: Boolean,
    default: false,
    onChange: syncPlayerPOV
  });
  game.settings.register(MODULE_ID, MONSTER_POV, {
    name: "Monster POV",
    hint: "On a monster or NPC's turn, see through its token's vision and senses.",
    scope: "user",
    config: true,
    type: Boolean,
    default: false,
    onChange: syncPlayerPOV
  });
});

function registerViewingMode(key, modes, hint, onChange) {
  game.settings.register(MODULE_ID, key, {
    name: "Viewing Mode",
    hint,
    scope: "user",
    config: true,
    type: new foundry.data.fields.StringField({ choices: modes.map(({ value }) => value) }),
    input: (_field, config) => {
      const options = isAssistantOrGM() ? modes : modes.filter(({ value }) => value !== "allMonsters");
      return foundry.applications.fields.createSelectInput({
        ...config,
        value: options.some(({ value }) => value === config.value) ? config.value : DEFAULT_VIEWING_MODE,
        options
      });
    },
    default: DEFAULT_VIEWING_MODE,
    onChange
  });
}

Hooks.on("renderSettingsConfig", (app, element) => {
  const root = app.element ?? element;
  settingsObservers.get(app)?.disconnect();
  decorateSettingsPanel(root);
  // CategoryBrowser can replace the settings panel after the application has rendered.
  const observer = new MutationObserver(() => decorateSettingsPanel(root));
  observer.observe(root, { childList: true, subtree: true });
  settingsObservers.set(app, observer);
});

Hooks.on("closeSettingsConfig", (app) => {
  settingsObservers.get(app)?.disconnect();
  settingsObservers.delete(app);
});

function decorateSettingsPanel(root) {
  const findInput = (setting) => root.querySelector(`[name="${MODULE_ID}.${setting}"]`);
  const sections = [
    [OUT_OF_COMBAT, "Out Of Combat"],
    [IN_COMBAT_VIEWING_MODE, "In Combat"],
    [SMOOTH_CAMERA, "Viewing Experience"]
  ];
  if (isAssistantOrGM()) {
    sections.push([PLAYER_POV, "GM & Assistant GMS"]);
  } else {
    for (const setting of [PLAYER_POV, MONSTER_POV]) {
      findInput(setting)?.closest(".form-group")?.remove();
    }
  }

  for (const [setting, title] of sections) {
    const row = findInput(setting)?.closest(".form-group");
    if (!row || row.previousElementSibling?.dataset.dynamicCameraSection === setting) continue;
    root.querySelector(`[data-dynamic-camera-section="${setting}"]`)?.remove();
    const heading = root.ownerDocument.createElement("h3");
    heading.dataset.dynamicCameraSection = setting;
    heading.textContent = title;
    row.before(heading);
  }

  insertSettingsQuote(root);
  const smoothCamera = findInput(SMOOTH_CAMERA);
  if (!smoothCamera) return;
  const updateDurationInput = () => {
    const duration = findInput(TRANSITION_DURATION);
    if (duration) duration.readOnly = !smoothCamera.checked;
  };
  updateDurationInput();
  if (!boundSmoothCameraInputs.has(smoothCamera)) {
    boundSmoothCameraInputs.add(smoothCamera);
    smoothCamera.addEventListener("change", updateDurationInput);
  }
}

function insertSettingsQuote(root) {
  const settings = isAssistantOrGM() ? [MONSTER_POV, TRANSITION_DURATION] : [TRANSITION_DURATION];
  for (const setting of settings) {
    const field = root.querySelector(`[name="${MODULE_ID}.${setting}"]`);
    const row = field?.closest(".form-group");
    if (!row) continue;
    if (row.nextElementSibling?.classList.contains("trashs-dynamic-camera-quote")) return;
    root.querySelector(".trashs-dynamic-camera-quote")?.remove();
    const quote = root.ownerDocument.createElement("blockquote");
    quote.classList.add("trashs-dynamic-camera-quote");
    quote.textContent = '"No excellent soul is exempt from a mixture of being a little Trash." - Trash';
    row.after(quote);
    return;
  }
}

Hooks.on("renderSceneControls", (app, element) => {
  const root = app.element ?? element;
  const layersId = app.constructor.PARTS?.layers?.id ?? "scene-controls-layers";
  const layers = root.querySelector(`[id="${layersId}"], [data-application-part="layers"]`);
  const sample = layers?.querySelector("button");
  if (!sample) return;

  const item = sample.closest("li") ?? sample;
  const column = item.parentElement;
  if (column.querySelector(".trashs-dynamic-camera-control")) return;

  const button = root.ownerDocument.createElement("button");
  button.type = "button";
  button.classList.add("trashs-dynamic-camera-control", "fa-solid", "fa-crosshairs");
  for (const name of sample.classList) {
    if (!name.startsWith("fa-") && name !== "active") button.classList.add(name);
  }
  button.setAttribute("aria-label", "Follow Turns");
  const updateButton = () => {
    const enabled = game.settings.get(MODULE_ID, SETTING);
    button.setAttribute("aria-pressed", String(enabled));
    button.classList.toggle("active", enabled);
    button.dataset.tooltip = `Follow Turns: ${enabled ? "On" : "Off"}`;
  };
  updateButton();
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await game.settings.set(MODULE_ID, SETTING, !game.settings.get(MODULE_ID, SETTING));
    } catch (error) {
      console.error("Trash's Dynamic Camera | Could not save the camera setting.", error);
      ui.notifications.error("Trash's Dynamic Camera could not save the camera setting.");
    } finally {
      updateButton();
      button.disabled = false;
    }
  });

  if (item === sample) {
    column.append(button);
  } else {
    const row = root.ownerDocument.createElement("li");
    row.className = item.className;
    row.classList.remove("active");
    row.append(button);
    column.append(row);
  }
});

Hooks.once("ready", () => {
  game.socket.on(TARGET_SOCKET, (message) => {
    if (message?.type === "targetPing") showTargetPing(message);
    else receiveTargets(message);
  });
  publishTargets(game.combats.active);
});
Hooks.on("combatTurnChange", (combat) => {
  syncPlayerPOV();
  followTurn(combat, { allowOwnTurn: true });
  publishTargets(combat);
});
Hooks.on("updateCombat", (combat, changes) => {
  if ("active" in changes || ("round" in changes && !combat.started)) {
    syncPlayerPOV();
    followScene();
  }
});
Hooks.on("deleteCombat", () => {
  syncPlayerPOV();
  frameParty();
});
Hooks.on("canvasReady", () => {
  syncPlayerPOV();
  followScene();
});
Hooks.on("canvasTearDown", stopPlayerPOV);
Hooks.on("controlToken", (token, controlled) => {
  if (token === povToken && !controlled) stopPlayerPOV({ restoreSelection: false });
  if (viewingMode(OUT_OF_COMBAT_VIEWING_MODE) === "justPlayer") queueMicrotask(frameParty);
});
Hooks.on("refreshToken", updatePOVTokenDisplay);
Hooks.on("sightRefresh", () => {
  if (povToken?.controlled) canvas.tokens.placeables.forEach(updatePOVTokenDisplay);
});
Hooks.on("createToken", refreshPartyAfterTokenChange);
Hooks.on("deleteToken", refreshPartyAfterTokenChange);
Hooks.on("updateToken", (token, changes) => {
  if (["x", "y", "width", "height", "hidden", "elevation", "rotation", "sight", "detectionModes", "actorId", "light"]
    .some((key) => key in changes)) {
    refreshPartyAfterTokenChange(token, "x" in changes || "y" in changes || "elevation" in changes);
  }
});
for (const hook of ["createWall", "updateWall", "deleteWall", "createAmbientLight", "updateAmbientLight", "deleteAmbientLight"]) {
  Hooks.on(hook, (document) => {
    if (document.parent !== canvas?.scene) return;
    const combat = game.combats.active;
    if (combat?.started) {
      if (viewingMode(IN_COMBAT_VIEWING_MODE) === "visibleMonsters") followTurn(combat);
    } else if (viewingMode(OUT_OF_COMBAT_VIEWING_MODE) === "visibleMonsters") frameParty();
  });
}
Hooks.on("targetToken", (user, token, targeted) => {
  if (canvas?.ready && targeted && user.id === game.user.id && token.document.parent === canvas.scene) {
    publishTargetPing(token);
  }

  if (targetUpdateQueued || !canvas?.ready) return;
  const combat = game.combats.active;
  const combatant = combat?.combatant;
  if (!combat?.started || !combatant?.players.some((player) => player.id === user.id)) return;

  // Foundry can emit several events for one change to a player's target set.
  targetUpdateQueued = true;
  queueMicrotask(() => {
    targetUpdateQueued = false;
    if (combat !== game.combats.active || combatant !== combat.combatant) return;
    if (user.id === game.user.id) publishTargets(combat);
    if (shouldFrameTargets()) followTurn(combat);
  });
});

function publishTargetPing(token) {
  const combat = game.combats.active;
  const context = targetContext(combat);
  if (!context || !canPingOnTurn(combat.combatant, game.user)) return;

  const message = { type: "targetPing", context, tokenId: token.id, userId: game.user.id };
  showTargetPing(message);
  game.socket.emit(TARGET_SOCKET, message);
}

function canPingOnTurn(combatant, user) {
  if (!user) return false;
  return combatant.hasPlayerOwner
    ? combatant.players.some((player) => player.id === user.id)
    : user.role >= CONST.USER_ROLES.ASSISTANT;
}

function showTargetPing({ context, tokenId, userId }) {
  const combat = game.combats.active;
  if (!context || context !== targetContext(combat) || typeof tokenId !== "string"
      || !game.settings.get(MODULE_ID, SHOW_TARGET_PINGS)) return;
  const user = userId === game.user.id ? game.user : game.users.get(userId);
  if (!canPingOnTurn(combat.combatant, user)) return;
  const target = canvas.tokens.get(tokenId);
  if (!target || !isVisibleForCamera(target)) return;

  const color = combat.combatant.hasPlayerOwner && target.actor?.hasPlayerOwner ? "#36c86a" : "#e64545";
  const controls = foundry.canvas.layers.ControlsLayer.instance;
  void controls.drawPing(target.center, { style: "pulse", color }).catch((error) => {
    console.error("Trash's Dynamic Camera | Could not draw a target ping.", error);
  });
}

function targetContext(combat) {
  if (!canvas?.ready || !combat?.isActive || !combat.started) return;
  const combatant = combat.combatant;
  if (!combatant?.token || combatant.token.parent !== canvas.scene) return;
  return JSON.stringify([canvas.scene.id, combat.id, combat.round, combat.turn, combatant.id]);
}

function publishTargets(combat) {
  const context = targetContext(combat);
  if (!context || !combat.combatant.hasPlayerOwner
      || !combat.combatant.players.some((player) => player.id === game.user.id)) return;
  game.socket.emit(TARGET_SOCKET, {
    context,
    userId: game.user.id,
    tokenIds: Array.from(game.user.targets, (token) => token.id)
  });
}

function receiveTargets(message) {
  if (!canUseTargetFallback()) return;
  const combat = game.combats.active;
  const context = targetContext(combat);
  if (!context || !combat.combatant.hasPlayerOwner
      || message?.context !== context || !Array.isArray(message.tokenIds)) return;
  if (message.userId === game.user.id
      || !combat.combatant.players.some((player) => player.id === message.userId)) return;
  sharedTargets.set(message.userId, {
    context,
    tokenIds: message.tokenIds.filter((id) => typeof id === "string")
  });
  if (shouldFrameTargets()) followTurn(combat);
}

function shouldFrameTargets() {
  return viewingMode(IN_COMBAT_VIEWING_MODE) === "playerAndTargets";
}

function canUseTargetFallback() {
  return isAssistantOrGM();
}

function isAssistantOrGM() {
  return game.user.role >= CONST.USER_ROLES.ASSISTANT;
}

function syncPlayerPOV() {
  const combat = game.combats.active;
  const combatant = combat?.isActive && combat.started ? combat.combatant : null;
  const document = combatant?.token;
  const setting = combatant?.hasPlayerOwner ? PLAYER_POV : MONSTER_POV;
  const token = isAssistantOrGM() && game.settings.get(MODULE_ID, setting)
    && canvas?.ready && canvas.visibility.tokenVision && document?.parent === canvas.scene
    && (!document.hidden || setting === MONSTER_POV)
    ? document.object
    : null;

  if (token && token === povToken && token.controlled) return;
  stopPlayerPOV();
  if (!token) return;

  const selected = [...canvas.tokens.controlled];
  // Select the token through Foundry so its configured vision and detection modes drive the canvas.
  token.control({ releaseOthers: false, pan: false, switchView: false });
  if (!token.controlled) return;
  previousSelection = selected;
  povToken = token;
  for (const other of selected) {
    if (other !== token) other.release();
  }
  canvas.tokens.placeables.forEach(updatePOVTokenDisplay);
}

function stopPlayerPOV({ restoreSelection = true } = {}) {
  if (!povToken) return;
  const token = povToken;
  povToken = undefined;
  for (const [graphic, renderable] of suppressedGraphics) {
    if (!graphic.destroyed) graphic.renderable = renderable;
  }
  suppressedGraphics.clear();
  if (restoreSelection) {
    if (token.controlled && !token.destroyed && !previousSelection.includes(token)) token.release();
    for (const previous of previousSelection) {
      if (!previous.destroyed && !previous.controlled) {
        previous.control({ releaseOthers: false, pan: false, switchView: false });
      }
    }
  }
  previousSelection = [];
}

function updatePOVTokenDisplay(token) {
  if (!povToken?.controlled) return;
  for (const graphic of [token, token.mesh, token.detectionFilterMesh, token.voidMesh]) {
    if (!graphic) continue;
    if (token !== povToken && token.document.hidden) {
      if (!suppressedGraphics.has(graphic)) suppressedGraphics.set(graphic, graphic.renderable);
      graphic.renderable = false;
    } else if (suppressedGraphics.has(graphic)) {
      graphic.renderable = suppressedGraphics.get(graphic);
      suppressedGraphics.delete(graphic);
    }
  }
}

function isVisibleForCamera(token) {
  return token.isVisible && !(povToken?.controlled && token !== povToken && token.document.hidden);
}

function followScene() {
  const combat = game.combats.active;
  if (combat?.started) followTurn(combat, { allowOwnTurn: true });
  else frameParty();
}

async function refreshPartyAfterTokenChange(token, moved = false) {
  if (!canvas?.ready || token.parent !== canvas.scene || !game.settings.get(MODULE_ID, SETTING)) return;
  const combat = game.combats.active;
  const combatant = combat?.started ? combat.combatant : null;
  if (combat?.started) {
    const mode = viewingMode(IN_COMBAT_VIEWING_MODE);
    if (mode === "justPlayer" && (moved !== true || (token !== combatant?.token
      && !canActivePlayerControl(token.actor, combatant)))) return;
  } else if (!game.settings.get(MODULE_ID, OUT_OF_COMBAT)) return;

  try {
    await token.object?.movementAnimationPromise;
  } catch (error) {
    console.error("Trash's Dynamic Camera | Token movement animation failed.", error);
  } finally {
    if (token.parent !== canvas.scene) return;
    if (combatant && combat === game.combats.active && combatant === combat.combatant) {
      followTurn(combat);
    }
    else frameParty();
  }
}

function frameParty() {
  if (!canvas?.ready || game.combats.active?.started || !game.settings.get(MODULE_ID, SETTING)) return;
  if (!game.settings.get(MODULE_ID, OUT_OF_COMBAT)) return;

  const tokens = explorationTokens(viewingMode(OUT_OF_COMBAT_VIEWING_MODE));
  if (tokens.length) panToView(fitParty(tokens));
}

function viewingMode(key) {
  const mode = game.settings.get(MODULE_ID, key);
  if (mode === "allMonsters" && !isAssistantOrGM()) return DEFAULT_VIEWING_MODE;
  return mode ?? DEFAULT_VIEWING_MODE;
}

function explorationTokens(mode) {
  if (mode === "justPlayer") {
    const { placeables, controlled } = canvas.tokens;
    const tokens = controlled.length || isAssistantOrGM()
      ? controlled
      : placeables.filter((token) => token.document.isOwner);
    return tokens.filter(isVisibleForCamera);
  }
  return groupViewingTokens(mode);
}

function groupViewingTokens(mode) {
  const { placeables } = canvas.tokens;
  if (mode === "allMonsters") return placeables;
  const players = visiblePlayerTokens();
  if (mode === "allPlayers") return players;
  const monsters = placeables.filter((token) => !token.actor?.hasPlayerOwner
    && !token.document.hidden && isVisibleForCamera(token));
  if (!canvas.visibility.tokenVision || !monsters.length) return [...players, ...monsters];

  const sources = [];
  try {
    // Detached sources let GMs test player sight without changing their own view or token selection.
    for (const player of placeables) {
      if (!player.actor?.hasPlayerOwner || player.document.hidden || !player.hasSight) continue;
      const source = new CONFIG.Canvas.visionSourceClass({ object: player, sourceId: `${MODULE_ID}.${player.id}` });
      const modes = Object.entries(player.detectionModes);
      sources.push({ source, modes });
      source.initialize(player._getVisionSourceData());
    }
    const visibleMonsters = monsters.filter((monster) => {
      const point = { x: monster.center.x, y: monster.center.y, elevation: monster.document.elevation };
      const config = canvas.visibility._createVisibilityTestConfig([point], { object: monster, tolerance: 2 });
      return sources.some(({ source, modes }) => modes.some(([id, mode]) =>
        CONFIG.Canvas.detectionModes[id]?.testVisibility(source, mode, config)
      ));
    });
    return [...players, ...visibleMonsters];
  } catch (error) {
    console.error("Trash's Dynamic Camera | Could not test player vision.", error);
    return players;
  } finally {
    for (const { source } of sources) source.destroy();
  }
}

function visiblePlayerTokens() {
  return canvas.tokens.placeables.filter((token) => token.actor?.hasPlayerOwner && isVisibleForCamera(token));
}

function fitParty(tokens) {
  return fitTokens(tokens, { maxScale: 1, viewportFraction: 0.75 });
}

function followTurn(combat, { allowOwnTurn = false } = {}) {
  if (!canvas?.ready || !combat?.isActive || !combat.started) return;
  if (!game.settings.get(MODULE_ID, SETTING)) return;

  const combatant = combat.combatant;
  if (!combatant) return;
  if (!allowOwnTurn && combatant.players.some((player) => player.id === game.user.id)) return;

  const mode = viewingMode(IN_COMBAT_VIEWING_MODE);
  if (mode !== "justPlayer" && mode !== "playerAndTargets") {
    const tokens = groupViewingTokens(mode);
    if (tokens.length) panToView(fitParty(tokens));
    return;
  }

  if (combatant.hidden && !game.user.isGM) return;
  const tokenDocument = combatant.token;
  if (!tokenDocument || tokenDocument.parent !== canvas.scene) return;
  const token = tokenDocument.object;
  if (!token?.isVisible) return;

  if (!combatant.hasPlayerOwner) {
    panToView(token.center);
    return;
  }

  const tokens = new Set([token]);
  for (const other of visiblePlayerTokens()) {
    if (canActivePlayerControl(other.actor, combatant)) tokens.add(other);
  }
  if (mode === "playerAndTargets") addVisibleTargets(tokens, combat);
  const { x, y } = token.center;
  const distance = game.settings.get(MODULE_ID, PLAYER_ZOOM);
  // At the default distance, keep the same scale as the previous 50% zoom.
  const scale = 0.5 * PLAYER_ZOOM_DEFAULT / distance;
  const view = tokens.size > 1 ? fitTokens(tokens, { maxScale: scale, viewportFraction: 0.8 }) : undefined;
  panToView(view ?? { x, y, scale });
}

function canActivePlayerControl(actor, combatant) {
  return Boolean(actor && combatant?.hasPlayerOwner && combatant.players.some((player) =>
    actor.testUserPermission(player, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
  ));
}

function addVisibleTargets(tokens, combat) {
  const context = targetContext(combat);
  for (const player of combat.combatant.players) {
    if (!player.active) continue;
    const shared = canUseTargetFallback() ? sharedTargets.get(player.id) : undefined;
    const targets = shared && shared.context === context
      ? shared.tokenIds.map((id) => canvas.tokens.get(id))
      : player.targets;
    for (const target of targets) {
      if (target?.document.parent === canvas.scene && isVisibleForCamera(target)) tokens.add(target);
    }
  }
}

function fitTokens(tokens, { maxScale, viewportFraction }) {
  const [width, height] = canvas.screenDimensions;
  if (!(width > 0 && height > 0)) return;

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const { bounds } of tokens) {
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }

  const scale = Math.min(maxScale, (viewportFraction * width) / (right - left), (viewportFraction * height) / (bottom - top));
  return { x: (left + right) / 2, y: (top + bottom) / 2, scale };
}

function panToView(view) {
  if (!view) return;
  const duration = game.settings.get(MODULE_ID, SMOOTH_CAMERA)
    ? game.settings.get(MODULE_ID, TRANSITION_DURATION) * 1000
    : 350;
  void canvas.animatePan({ x: view.x, y: view.y, scale: view.scale, duration }).catch((error) => {
    console.error("Trash's Dynamic Camera | Could not move the camera.", error);
  });
}
