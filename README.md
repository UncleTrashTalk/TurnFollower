# Trash's Dynamic Camera

A system-independent module for Foundry VTT 14 Stable 9 (14.367) and later on The Forge.

## Install on The Forge

1. In Forge **Game Configuration**, open **Table Tools → Summon Import Wizard**.
2. Upload `trashs-dynamic-camera.zip` as a local ZIP. If prompted, disable **Install found packages from the Bazaar** to import the custom module.
3. Launch your world, then enable **Trash's Dynamic Camera** under **Game Settings → Manage Modules**.

For a local Foundry installation, put the manifest and script in your Foundry user data directory under `Data/modules/trashs-dynamic-camera/` and restart Foundry.

## Use

Click the **Follow Turns** crosshairs button at the bottom of the main scene controls column on the left. The button highlights while following is on. The setting starts off and is saved on the current browser client.

The camera follows visible combatants on the current scene. On a player-owned combatant's turn, it centers on that token at the configured **Player Turn Zoom** unless it is framing targets. On a GM-controlled monster or NPC turn, it frames that combatant together with all visible player-owned tokens, centering on the group with padding around it. Players also skip combatants hidden in the tracker.

With **Out Of Combat Following** enabled, **Follow Turns** frames all visible player-owned tokens on the current scene outside combat. It reframes when those tokens move, leaves space around the group, and caps the requested zoom at 100%.

During combat, moving a player-owned token reframes the visible party and active combatant with the same padding. On player turns, the view also includes visible targets when target following applies.

On your own turn, the camera moves once at the start. Automatic adjustments for movement and targets resume for you when combat advances. Other viewers continue receiving camera updates during your turn.

## Module settings

These options are under **Game Settings → Configure Settings → Trash's Dynamic Camera** and are saved per user, per world.

- **Player Turn Zoom** sets the camera distance for a player token framed alone. Drag the slider or type a whole number from 10 to 250 in the adjacent box. The default is 50. Lower values zoom in and higher values zoom out.
- **Focus Target Too** frames the active player token and visible targets selected by its connected player owners. The camera reframes as targets change and zooms out only as needed. When no eligible targets remain, it returns to **Player Turn Zoom**. This option is off by default.
- **Show Target Pings** displays Foundry's pulse on a visible target selected during the targeting combatant's turn. Player-to-player pings are green. Pings involving a monster or NPC are red. This option is off by default and works independently of camera following.
- **Smooth Camera** uses the configured duration for automatic pan and zoom transitions with Foundry's easing. This option is off by default.
- **Transition Duration** sets how long a smooth camera transition takes. It defaults to 1 second and accepts decimal values from 0.4 to 3 seconds.
- **See Player POV** lets Assistant GMs and GMs preview the active player's token vision and detection modes on scenes with Token Vision enabled. The preview hides GM-hidden tokens and restores the previous token selection after player turns. This option is off by default.
- **Monster POV** lets Assistant GMs and GMs use the same vision preview on a monster or GM-controlled NPC turn. It is off by default and can be enabled independently of **See Player POV**.
- **Out Of Combat Following** enables party framing outside combat while **Follow Turns** is on. This option is off by default.

Assistant GMs and GMs automatically follow the active player's visible targets when **Follow Turns** is on, including when they are viewing without a character. The module's target relay fallback is applied only for those roles.

## Credits

Created by **UncleTrashTalk**. Thanks to [DM WolfyQuest](https://www.twitch.tv/wolfyquest) for testing and feature ideas.

## License

See [LICENSE](LICENSE) for the terms of use and redistribution.
