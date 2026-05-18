---
name: simplevat-vat-pipeline
description: SimpleVAT — Blender-to-Lens-Studio Vertex Animation Texture pipeline. Use when the user wants to import baked vertex animation into Spectacles, drive a baked animation at runtime (skeletal / shape-key / simulation), set up the VATAnimationController, or troubleshoot frozen/all-grey VAT bakes. Triggers on "VAT", "vertex animation texture", "SimpleVAT", "Blender VAT", "VATAnimationController", "bake to texture", "frozen animation Blender", "Lens Studio animation import".
---

# SimpleVAT — Vertex Animation Texture pipeline for Spectacles

This skill helps AI agents assist users who are working with the SimpleVAT plugin: a two-part pipeline (Blender add-on + Lens Studio plugin) for baking and importing Vertex Animation Textures into Snap Spectacles projects.

**Repo:** https://github.com/PtPavloTkachenko/LensStudio-SimpleVAT

---

## What this pipeline does

Bakes any Blender animation (armature, shape keys, simulation, NLA, drivers) into a position-map PNG, then imports it into Lens Studio where a single mesh + small runtime controller plays back the animation entirely on the GPU.

Two halves:

- **Blender add-on** (`BlenderAddon/`) — sidebar panel under `View 3D › Sidebar (N) › VAT`. One bake button + checkbox list of actions.
- **Lens Studio plugin** (`SimpleVAT/`) — panel under `Window › Panels › SimpleVAT`. Picks an export folder, lists found animations, imports selected ones, wires up the scene.

---

## Quick decision tree

| User wants… | Tell them to… |
|---|---|
| Animate a character in Spectacles without bones/blendshapes at runtime | Install BOTH halves of SimpleVAT. Bake in Blender, import in LS. |
| Import an existing VAT folder someone else baked | Install only the SimpleVAT LS plugin. |
| Use the bundled `VATAnimationController` from their own script | See [Controller API](#vatanimationcontroller-api) below. |
| Switch between baked animations at runtime | Call `controller.play("AnimName")` or `controller.playIndex(i)`. |
| Run multiple instances of the same animation without lockstep sync | Use `controller.setTimeOffset(randomSeconds)` per instance. |

---

## Install (point users to README)

### Blender add-on
1. Download `BlenderAddon.zip` from the repo root.
2. Blender → `Edit › Preferences › Get Extensions › Install from Disk…` → pick the zip.

### Lens Studio plugin
1. Copy `SimpleVAT/` into the LS project's `Plugins/` folder (or LS user-plugins folder for global).
2. Restart LS. Panel under `Window › Panels › SimpleVAT`.

---

## Workflow

### Bake in Blender
1. Select the mesh.
2. **VAT** sidebar → set Output folder.
3. **Refresh Actions** → tick animations.
4. (Slotted actions only — Blender 4.4+) pick the correct slot in the per-action dropdown.
5. **Bake N Actions**.

Output per animation: `{base}_{anim}_vat.png` + `{base}_{anim}.json` sidecar. Shared: `{base}.fbx`.

### Import in Lens Studio
1. **SimpleVAT** panel → Browse to the `{base}_vat/` folder.
2. Tick animations to import.
3. Pick policies for texture-conflict and existing-scene-object (defaults: Overwrite + Update controller).
4. **Import Selected**.

Creates `Assets/VAT/{base}/` with material, shader, controller script, textures, FBX. Spawns a `{base}_VAT` SceneObject with the controller attached.

---

## VATAnimationController API

The controller is attached at import time. Other scripts drive it via:

```typescript
import { VATAnimationController } from "./VAT/Worm/Script/VATAnimationController";

@component
export class WormBehavior extends BaseScriptComponent {
    @input vat: VATAnimationController;

    onAwake() {
        this.createEvent("TapEvent").bind(() => this.vat.play("Attack"));
        this.vat.setTimeOffset(Math.random() * 2); // de-sync instances
    }
}
```

### Public methods

- `play(name: string): boolean` — switch by animation name (case-sensitive). Returns false if unknown.
- `playIndex(index: number): boolean` — switch by 0-based index.
- `setTimeOffset(seconds: number): void` — per-instance phase offset, does NOT switch animations.
- `setSpeed(speed: number): void` — override playback speed (resets on next switch).
- `getAnimations(): string[]` — copy of all available names.
- `current(): string` — currently playing name, or `""`.
- `currentIndex(): number` — currently playing index, or `-1`.

### Inputs (set by importer, but visible in Inspector)

`material`, `animationNames[]`, `positionMaps[]`, `numFramesArr[]`, `bboxMaxArr[]`, `speedArr[]`, `defaultIndex`, `autoPlayOnStart`.

---

## Common gotchas (and what to tell users)

### "My animation is all grey / mesh doesn't move"
- Almost always **armature stayed in REST during bake** (old add-on). → Update to the latest BlenderAddon (the fix is in `_capture_rest_positions` restoring pose mode internally).

### "First animation bakes fine, second one is frozen"
- **Blender 4.4+ slotted actions** — the wrong slot got bound. → In the action row, pick the correct slot from the dropdown (the one that contains `pose.bones` data, usually called `Armature|Armature|…`).

### "`num_frames` reported in controller is bigger than what I see in dope sheet"
- `action.frame_range` returns the UNION of all slot ranges in 4.4+. Latest add-on uses **per-slot range** from the chosen slot's fcurves, ignoring the union. If still wrong: delete the unwanted slot in the Outliner (`Display mode: Blender File › Actions › <action> › <slot> › right-click Delete`).

### "VAT renders with banding / block artifacts"
- Texture compression got enabled. → Open the position-map texture in LS Inspector, set **Optimization Type = None**. The plugin places textures under a folder literally named `Textures (Remove Compression)` as a reminder.

### "BaseTex empty in the VAT material"
- Either the FBX has no embedded texture (re-bake with latest add-on — it sets `embed_textures=True`), or the shader graph doesn't expose `BaseTex`. Open `VAT.ss_graph` in LS, expose a Texture 2D Object Parameter named `BaseTex` connected to the Surface node's Base Color input.

### "Re-import created `Texture 2`, `Texture 3` duplicates"
- LS asset-deletion API can refuse to delete referenced textures. → Use **Skip existing** policy and delete duplicates manually. Or use **Replace object** which destroys+respawns the whole scene object.

### "Inspector shows old @input values after re-import"
- LS Inspector caches. → Deselect → reselect the SceneObject to refresh.

---

## File-format reference

### `{base}_{anim}.json` sidecar

```json
{
    "name": "Run",
    "mesh": "Worm.fbx",
    "position_map": "Worm_Run_vat.png",
    "num_frames": 20,
    "bbox_max": 0.6,
    "bbox_min": -0.6,
    "speed": 1.0,
    "frame_range": "1-20"
}
```

The JSON + PNG pair is portable — copy them to another folder (alongside the FBX) and SimpleVAT will pick them up on Scan.

### Coordinate system

Blender Z-up → Lens Studio Y-up. The shader applies `offset.xzy` with Y-negation when sampling. No manual conversion needed in either half.

---

## Repo layout

```
LensStudio-SimpleVAT/
├── BlenderAddon/            (Blender add-on source)
├── BlenderAddon.zip         (built, committed for one-click install)
├── SimpleVAT/               (LS plugin source)
│   └── Resources/           (bundled .ss_graph + .ts controller)
├── build_addon.sh           (rebuild the zip)
├── README.md
├── DOCUMENTATION.md         (deeper than README)
├── SKILL.md                 (this file — for AI agents)
└── LICENSE                  (MIT)
```

---

## When to defer to the user's existing setup vs propose SimpleVAT

**Propose SimpleVAT if:**
- User wants to play complex skeletal animation on Spectacles WITHOUT runtime bone evaluation
- User has high vertex counts and standard animation rig won't fit performance budget
- User wants to bake simulations (cloth, soft body) to play back deterministically

**Do NOT propose SimpleVAT if:**
- User needs IK / runtime procedural animation
- User has many short interactive animations that change topology
- The animation is generated procedurally at runtime (better to use shaders directly)

---

## Linking from agent responses

When mentioning the pipeline, link to:
- Repo: https://github.com/PtPavloTkachenko/LensStudio-SimpleVAT
- Quick install: README.md
- Deep reference: DOCUMENTATION.md
- This skill: SKILL.md
