const MODULE_ID = "trashs-dynamic-camera";
const TARGET_SOCKET = `module.${MODULE_ID}`;
const SETTING = "enabled";
const SHOW_TARGET_PINGS = "showTargetPings";
const SHOW_TARGET_LINES = "showTargetLines";
const SHOW_TARGET_TOKEN_GLOW = "showTargetTokenGlow";
const DEFAULT_TARGET_COLORS = { Friendly: "#36c86a", Hostile: "#e64545" };
const TARGET_EFFECTS = [SHOW_TARGET_PINGS, SHOW_TARGET_LINES, SHOW_TARGET_TOKEN_GLOW];
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
let localTargetsChanged = false;
let targetOverlayRefreshQueued = false;
let targetOverlayGraphics;
const sharedTargets = new Map();
const settingsObservers = new WeakMap();
const boundSettingsInputs = new WeakSet();
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
    hint: "Show a pulse when the active combatant targets a visible token.",
    scope: "user",
    config: true,
    type: Boolean,
    default: false
  });
  registerTargetColors(SHOW_TARGET_PINGS);
  game.settings.register(MODULE_ID, SHOW_TARGET_LINES, {
    name: "Show Target Lines",
    hint: "Draw glowing lines from the active combatant to visible targets.",
    scope: "user",
    config: true,
    type: Boolean,
    default: false,
    onChange: refreshTargetOverlay
  });
  registerTargetColors(SHOW_TARGET_LINES);
  game.settings.register(MODULE_ID, SHOW_TARGET_TOKEN_GLOW, {
    name: "Show Target Token Glow",
    hint: "Draw a glowing ring around visible targets.",
    scope: "user",
    config: true,
    type: Boolean,
    default: false,
    onChange: refreshTargetOverlay
  });
  registerTargetColors(SHOW_TARGET_TOKEN_GLOW);
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

function registerTargetColors(effect) {
  for (const [label, color] of Object.entries(DEFAULT_TARGET_COLORS)) {
    game.settings.register(MODULE_ID, `${effect}${label}`, {
      name: label,
      hint: label === "Friendly" ? "Player targeting a player." : "Player targeting a monster, or monster targeting any token.",
      scope: "user",
      config: true,
      type: new foundry.data.fields.ColorField(),
      default: color,
      onChange: effect === SHOW_TARGET_PINGS ? undefined : refreshTargetOverlay
    });
  }
}

function targetEffectColor(effect, combatant, target) {
  const label = combatant.hasPlayerOwner && target.actor?.hasPlayerOwner ? "Friendly" : "Hostile";
  return game.settings.get(MODULE_ID, `${effect}${label}`) ?? DEFAULT_TARGET_COLORS[label];
}

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
  for (const effect of TARGET_EFFECTS) {
    const toggle = findInput(effect);
    if (!toggle) continue;
    bindSettingsToggle(toggle, () => {
      for (const label of Object.keys(DEFAULT_TARGET_COLORS)) {
        const row = findInput(`${effect}${label}`)?.closest(".form-group");
        if (row) row.style.display = toggle.checked ? "" : "none";
      }
    });
  }
  const smoothCamera = findInput(SMOOTH_CAMERA);
  if (!smoothCamera) return;
  bindSettingsToggle(smoothCamera, () => {
    const duration = findInput(TRANSITION_DURATION);
    if (duration) duration.readOnly = !smoothCamera.checked;
  });
}

function bindSettingsToggle(toggle, update) {
  update();
  if (!boundSettingsInputs.has(toggle)) {
    boundSettingsInputs.add(toggle);
    toggle.addEventListener("change", update);
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
  refreshTargetOverlay();
});
Hooks.on("combatTurnChange", (combat) => {
  syncPlayerPOV();
  followTurn(combat, { allowOwnTurn: true });
  publishTargets(combat);
  refreshTargetOverlay();
});
Hooks.on("updateCombat", (combat, changes) => {
  if ("active" in changes || ("round" in changes && !combat.started)) {
    syncPlayerPOV();
    followScene();
    refreshTargetOverlay();
  }
});
Hooks.on("deleteCombat", () => {
  syncPlayerPOV();
  frameParty();
  refreshTargetOverlay();
});
Hooks.on("canvasReady", () => {
  syncPlayerPOV();
  followScene();
  refreshTargetOverlay();
});
Hooks.on("canvasTearDown", stopPlayerPOV);
Hooks.on("canvasTearDown", clearTargetOverlay);
Hooks.on("controlToken", (token, controlled) => {
  if (token === povToken && !controlled) stopPlayerPOV({ restoreSelection: false });
  if (viewingMode(OUT_OF_COMBAT_VIEWING_MODE) === "justPlayer") queueMicrotask(frameParty);
});
Hooks.on("refreshToken", (token) => {
  updatePOVTokenDisplay(token);
  queueTargetOverlayRefresh();
});
Hooks.on("sightRefresh", () => {
  if (povToken?.controlled) canvas.tokens.placeables.forEach(updatePOVTokenDisplay);
  queueTargetOverlayRefresh();
});
Hooks.on("createToken", refreshPartyAfterTokenChange);
Hooks.on("deleteToken", (token) => {
  refreshPartyAfterTokenChange(token);
  queueTargetOverlayRefresh();
});
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
      if (usesMonsterFraming(combat.combatant) || viewingMode(IN_COMBAT_VIEWING_MODE) === "visibleMonsters") {
        followTurn(combat);
      }
    } else if (viewingMode(OUT_OF_COMBAT_VIEWING_MODE) === "visibleMonsters") frameParty();
  });
}
Hooks.on("targetToken", (user, token, targeted) => {
  if (canvas?.ready && targeted && user.id === game.user.id && token.document.parent === canvas.scene) {
    publishTargetPing(token);
  }

  if (!canvas?.ready) return;
  const combat = game.combats.active;
  const combatant = combat?.combatant;
  if (!combat?.started || !combatant || !canTargetOnTurn(combatant, user)) return;

  if (user.id === game.user.id) localTargetsChanged = true;
  if (targetUpdateQueued) return;
  // Foundry can emit several events for one change to a player's target set.
  targetUpdateQueued = true;
  queueMicrotask(() => {
    targetUpdateQueued = false;
    const publish = localTargetsChanged;
    localTargetsChanged = false;
    if (combat !== game.combats.active || combatant !== combat.combatant) return;
    if (publish) publishTargets(combat, { includeMonster: true });
    refreshTargetOverlay();
    if (combatant.hasPlayerOwner && shouldFrameTargets()) followTurn(combat);
  });
});

function publishTargetPing(token) {
  const combat = game.combats.active;
  const context = targetContext(combat);
  if (!context || !canTargetOnTurn(combat.combatant, game.user)) return;

  const message = { type: "targetPing", context, tokenId: token.id, userId: game.user.id };
  showTargetPing(message);
  game.socket.emit(TARGET_SOCKET, message);
}

function canTargetOnTurn(combatant, user) {
  if (!user) return false;
  return combatant.hasPlayerOwner
    ? combatant.players.some((player) => player.id === user.id)
    : user.role >= CONST.USER_ROLES.ASSISTANT;
}

async function showTargetPing({ context, tokenId, userId }) {
  const combat = game.combats.active;
  if (!context || context !== targetContext(combat) || typeof tokenId !== "string"
      || !game.settings.get(MODULE_ID, SHOW_TARGET_PINGS)) return;
  const user = userId === game.user.id ? game.user : game.users.get(userId);
  if (!canTargetOnTurn(combat.combatant, user)) return;
  const target = canvas.tokens.get(tokenId);
  if (!target || !isVisibleForCamera(target)) return;

  const color = targetEffectColor(SHOW_TARGET_PINGS, combat.combatant, target);
  let ping;
  try {
    const container = foundry.canvas.layers.ControlsLayer.instance?.pings;
    if (!container) return;
    const { class: PulsePing, duration, size } = CONFIG.Canvas.pings.styles.pulse;
    ping = new PulsePing(target.center, { color, duration, size });
    container.addChild(ping);
    await ping.animate();
  } catch (error) {
    console.error("Trash's Dynamic Camera | Could not draw a target ping.", error);
  } finally {
    if (ping && !ping.destroyed) ping.destroy();
  }
}

function targetContext(combat) {
  if (!canvas?.ready || !combat?.isActive || !combat.started) return;
  const combatant = combat.combatant;
  if (!combatant?.token || combatant.token.parent !== canvas.scene) return;
  return JSON.stringify([canvas.scene.id, combat.id, combat.round, combat.turn, combatant.id]);
}

function publishTargets(combat, { includeMonster = false } = {}) {
  const context = targetContext(combat);
  if (!context || !canTargetOnTurn(combat.combatant, game.user)) return;
  if (!combat.combatant.hasPlayerOwner && !includeMonster) return;
  const message = {
    context,
    userId: game.user.id,
    tokenIds: Array.from(game.user.targets, (token) => token.id)
  };
  if (!combat.combatant.hasPlayerOwner) sharedTargets.set(game.user.id, message);
  game.socket.emit(TARGET_SOCKET, message);
}

function receiveTargets(message) {
  const combat = game.combats.active;
  const context = targetContext(combat);
  if (!context || message?.context !== context || !Array.isArray(message.tokenIds)) return;
  if (message.userId === game.user.id || !canTargetOnTurn(combat.combatant, game.users.get(message.userId))) return;
  sharedTargets.set(message.userId, {
    context,
    tokenIds: message.tokenIds.filter((id) => typeof id === "string")
  });
  refreshTargetOverlay();
  if (combat.combatant.hasPlayerOwner && canUseTargetFallback() && shouldFrameTargets()) followTurn(combat);
}

function queueTargetOverlayRefresh() {
  if (targetOverlayRefreshQueued || (!game.settings.get(MODULE_ID, SHOW_TARGET_LINES)
    && !game.settings.get(MODULE_ID, SHOW_TARGET_TOKEN_GLOW))) return;
  targetOverlayRefreshQueued = true;
  queueMicrotask(() => {
    targetOverlayRefreshQueued = false;
    refreshTargetOverlay();
  });
}

function clearTargetOverlay() {
  if (targetOverlayGraphics && !targetOverlayGraphics.destroyed) targetOverlayGraphics.destroy();
  targetOverlayGraphics = undefined;
}

function refreshTargetOverlay() {
  const combat = game.combats.active;
  const context = targetContext(combat);
  const showLines = game.settings.get(MODULE_ID, SHOW_TARGET_LINES);
  const showGlow = game.settings.get(MODULE_ID, SHOW_TARGET_TOKEN_GLOW);
  if (!context || (!showLines && !showGlow)) return clearTargetOverlay();

  const combatant = combat.combatant;
  const source = combatant.token.object;
  if (!source || !isVisibleForCamera(source) || (combatant.hidden && !isAssistantOrGM())) return clearTargetOverlay();

  const targets = new Set();
  const users = combatant.hasPlayerOwner ? combatant.players : game.users.filter((user) => canTargetOnTurn(combatant, user));
  for (const user of users) {
    if (!user.active) continue;
    if (!combatant.hasPlayerOwner && sharedTargets.get(user.id)?.context !== context) continue;
    for (const target of targetsForUser(user, context, true)) {
      if (target && target !== source && target.document.parent === canvas.scene && isVisibleForCamera(target)) {
        targets.add(target);
      }
    }
  }
  if (!targets.size) return clearTargetOverlay();

  const layer = foundry.canvas.layers.ControlsLayer.instance?.pings;
  if (!layer) return clearTargetOverlay();
  if (!targetOverlayGraphics || targetOverlayGraphics.destroyed) {
    targetOverlayGraphics = new PIXI.Graphics();
    targetOverlayGraphics.eventMode = "none";
    layer.addChildAt(targetOverlayGraphics, 0);
  }
  const graphics = targetOverlayGraphics;
  graphics.clear();
  const origin = source.center;
  for (const target of targets) {
    const destination = target.center;
    const lineColor = showLines ? Number(foundry.utils.Color.from(targetEffectColor(SHOW_TARGET_LINES, combatant, target))) : 0;
    const glowColor = showGlow ? Number(foundry.utils.Color.from(targetEffectColor(SHOW_TARGET_TOKEN_GLOW, combatant, target))) : 0;
    const { width: tokenWidth, height: tokenHeight } = target.bounds;
    for (const [width, alpha] of [[12, 0.13], [7, 0.35], [3, 0.95]]) {
      if (showLines) {
        graphics.lineStyle({ width, color: lineColor, alpha }).moveTo(origin.x, origin.y).lineTo(destination.x, destination.y);
      }
      if (showGlow) {
        graphics.lineStyle({ width, color: glowColor, alpha })
          .drawEllipse(destination.x, destination.y, tokenWidth / 2 + 5, tokenHeight / 2 + 5);
      }
    }
  }
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
    if (!usesMonsterFraming(combatant) && mode === "justPlayer" && (moved !== true || (token !== combatant?.token
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
  const observers = placeables.filter((token) => token.actor?.hasPlayerOwner && !token.document.hidden);
  return [...players, ...tokensWithinVision(monsters, observers)];
}

function tokensWithinVision(targets, observers) {
  if (!canvas.visibility.tokenVision) return targets;
  if (!targets.length) return [];

  const sources = [];
  try {
    // Detached sources test token sight without changing the viewer's vision or selection.
    for (const observer of observers) {
      if (!observer.hasSight) continue;
      const source = new CONFIG.Canvas.visionSourceClass({ object: observer, sourceId: `${MODULE_ID}.${observer.id}` });
      const modes = Object.entries(observer.detectionModes);
      sources.push({ source, modes });
      source.initialize(observer._getVisionSourceData());
    }
    return targets.filter((target) => {
      const { x, y } = target.center;
      const point = { x, y, elevation: target.document.elevation };
      const config = canvas.visibility._createVisibilityTestConfig([point], { object: target, tolerance: 2 });
      return sources.some(({ source, modes }) => modes.some(([id, mode]) =>
        CONFIG.Canvas.detectionModes[id]?.testVisibility(source, mode, config)
      ));
    });
  } catch (error) {
    console.error("Trash's Dynamic Camera | Could not test token vision.", error);
    return [];
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

function usesMonsterFraming(combatant) {
  return Boolean(combatant && !combatant.hasPlayerOwner && isAssistantOrGM());
}

function followTurn(combat, { allowOwnTurn = false } = {}) {
  if (!canvas?.ready || !combat?.isActive || !combat.started) return;
  if (!game.settings.get(MODULE_ID, SETTING)) return;

  const combatant = combat.combatant;
  if (!combatant) return;
  if (!allowOwnTurn && combatant.players.some((player) => player.id === game.user.id)) return;

  if (usesMonsterFraming(combatant)) {
    const document = combatant.token;
    const monster = document?.parent === canvas.scene ? document.object : null;
    if (!monster) return;
    const players = canvas.tokens.placeables.filter((token) => token.actor?.hasPlayerOwner && !token.document.hidden);
    const detected = tokensWithinVision(players, [monster]);
    const view = detected.length ? fitParty([monster, ...detected]) : undefined;
    panToView(view ?? monster.center);
    return;
  }

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
    for (const target of targetsForUser(player, context, canUseTargetFallback())) {
      if (target?.document.parent === canvas.scene && isVisibleForCamera(target)) tokens.add(target);
    }
  }
}

function targetsForUser(user, context, useShared) {
  const shared = useShared ? sharedTargets.get(user.id) : undefined;
  return shared && shared.context === context
    ? shared.tokenIds.map((id) => canvas.tokens.get(id))
    : user.targets;
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
