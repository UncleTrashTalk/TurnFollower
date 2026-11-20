const MODULE_ID = "trashs-dynamic-camera";
const TARGET_SOCKET = `module.${MODULE_ID}`;
const SETTING = "enabled";
const FOCUS_TARGETS = "focusTargets";
const SHOW_TARGET_PINGS = "showTargetPings";
const PLAYER_ZOOM = "playerZoom";
const SMOOTH_CAMERA = "smoothCamera";
const TRANSITION_DURATION = "transitionDuration";
const OUT_OF_COMBAT = "outOfCombatFollowing";
const PLAYER_POV = "seePlayerPOV";
const MONSTER_POV = "monsterPOV";
const PLAYER_ZOOM_DEFAULT = 50;
const PLAYER_ZOOM_RANGE = { min: 10, max: 250 };
let targetUpdateQueued = false;
const sharedTargets = new Map();
const settingsObservers = new WeakMap();
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
    hint: "Keep visible player tokens in frame as they move outside combat while Follow Turns is on.",
    scope: "user",
    config: true,
    type: Boolean,
    default: false,
    onChange: (enabled) => {
      if (enabled) frameParty();
    }
  });
  game.settings.register(MODULE_ID, FOCUS_TARGETS, {
    name: "Focus Target Too",
    hint: "Frame the active player's token and their visible targets together.",
    scope: "user",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => followTurn(game.combats.active)
  });
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

Hooks.on("renderSettingsConfig", (app, element) => {
  const root = app.element ?? element;
  settingsObservers.get(app)?.disconnect();
  insertSettingsQuote(root);
  // CategoryBrowser can replace the settings panel after the application has rendered.
  const observer = new MutationObserver(() => insertSettingsQuote(root));
  observer.observe(root, { childList: true, subtree: true });
  settingsObservers.set(app, observer);

  if (!isAssistantOrGM()) {
    for (const setting of [PLAYER_POV, MONSTER_POV]) {
      element.querySelector(`input[name="${MODULE_ID}.${setting}"]`)?.closest(".form-group")?.remove();
    }
  }
  const smoothCamera = element.querySelector(`input[name="${MODULE_ID}.${SMOOTH_CAMERA}"]`);
  const duration = element.querySelector(`input[name="${MODULE_ID}.${TRANSITION_DURATION}"]`);
  if (!smoothCamera || !duration) return;

  const updateDurationInput = () => {
    duration.readOnly = !smoothCamera.checked;
  };
  updateDurationInput();
  smoothCamera.addEventListener("change", updateDurationInput);
});

Hooks.on("closeSettingsConfig", (app) => {
  settingsObservers.get(app)?.disconnect();
  settingsObservers.delete(app);
});

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
});
Hooks.on("refreshToken", updatePOVTokenDisplay);
Hooks.on("sightRefresh", () => {
  if (povToken?.controlled) canvas.tokens.placeables.forEach(updatePOVTokenDisplay);
});
Hooks.on("createToken", refreshPartyAfterTokenChange);
Hooks.on("deleteToken", refreshPartyAfterTokenChange);
Hooks.on("updateToken", (token, changes) => {
  if (["x", "y", "width", "height", "hidden", "elevation"].some((key) => key in changes)) {
    refreshPartyAfterTokenChange(token, "x" in changes || "y" in changes || "elevation" in changes);
  }
});
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
  return game.settings.get(MODULE_ID, FOCUS_TARGETS) || canUseTargetFallback();
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
  if (combatant?.hasPlayerOwner && (moved !== true || !token.actor?.hasPlayerOwner)) return;
  if (!token.actor?.hasPlayerOwner && token !== combatant?.token) return;

  try {
    await token.object?.movementAnimationPromise;
  } catch (error) {
    console.error("Trash's Dynamic Camera | Token movement animation failed.", error);
  } finally {
    if (token.parent !== canvas.scene) return;
    if (combatant && combat === game.combats.active && combatant === combat.combatant) {
      followTurn(combat, { framePlayers: true });
    }
    else frameParty();
  }
}

function frameParty() {
  if (!canvas?.ready || game.combats.active?.started || !game.settings.get(MODULE_ID, SETTING)) return;
  if (!game.settings.get(MODULE_ID, OUT_OF_COMBAT)) return;

  const tokens = visiblePlayerTokens();
  if (tokens.length) panToView(fitParty(tokens));
}

function visiblePlayerTokens() {
  return canvas.tokens.placeables.filter((token) => token.actor?.hasPlayerOwner && isVisibleForCamera(token));
}

function fitParty(tokens) {
  return fitTokens(tokens, { maxScale: 1, viewportFraction: 0.75 });
}

function followTurn(combat, { framePlayers = false, allowOwnTurn = false } = {}) {
  if (!canvas?.ready || !combat?.isActive || !combat.started) return;
  if (!game.settings.get(MODULE_ID, SETTING)) return;

  const combatant = combat.combatant;
  if (!combatant || (combatant.hidden && !game.user.isGM)) return;
  if (!allowOwnTurn && combatant.players.some((player) => player.id === game.user.id)) return;

  const tokenDocument = combatant.token;
  if (!tokenDocument || tokenDocument.parent !== canvas.scene) return;
  const token = tokenDocument.object;
  if (!token?.isVisible) return;

  if (!combatant.hasPlayerOwner) {
    const players = visiblePlayerTokens();
    const view = players.length ? fitParty([token, ...players]) : token.center;
    panToView(view ?? token.center);
    return;
  }

  if (framePlayers) {
    const tokens = new Set([token, ...visiblePlayerTokens()]);
    if (shouldFrameTargets()) addVisibleTargets(tokens, combat);
    panToView(fitParty(tokens));
    return;
  }

  const targetView = shouldFrameTargets()
    ? frameTargets(token, combat)
    : undefined;
  const { x, y } = token.center;
  const distance = game.settings.get(MODULE_ID, PLAYER_ZOOM);
  // At the default distance, keep the same scale as the previous 50% zoom.
  panToView(targetView ?? { x, y, scale: 0.5 * PLAYER_ZOOM_DEFAULT / distance });
}

function frameTargets(token, combat) {
  const tokens = new Set([token]);
  addVisibleTargets(tokens, combat);
  if (tokens.size > 1) return fitTokens(tokens, { maxScale: canvas.stage.scale.x, viewportFraction: 0.8 });
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
