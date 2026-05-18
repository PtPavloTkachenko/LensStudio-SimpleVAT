# SimpleVAT — Documentation

Deeper reference than the README: architecture, data formats, full controller API, troubleshooting and contributor notes.

> For installation and quick start, see [README.md](README.md).

---

## Table of contents

- [Architecture](#architecture)
- [Data formats](#data-formats)
  - [Per-animation JSON sidecar](#per-animation-json-sidecar)
  - [PNG texture encoding](#png-texture-encoding)
  - [FBX rest mesh](#fbx-rest-mesh)
- [Blender add-on](#blender-add-on)
  - [Operators](#operators)
  - [Slotted actions (Blender 4.4+)](#slotted-actions-blender-44)
- [Lens Studio plugin](#lens-studio-plugin)
  - [Import flow](#import-flow)
  - [Conflict & scene-object policies](#conflict--scene-object-policies)
  - [Project layout after import](#project-layout-after-import)
  - [Base texture carry-over](#base-texture-carry-over)
- [VATAnimationController — full API](#vatanimationcontroller--full-api)
- [Shader graph](#shader-graph)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

---

## Architecture

Two independent halves connected only through a folder on disk:

```
┌──────────────────────────┐    {base}_vat/ folder           ┌──────────────────────────┐
│  Blender add-on          │ ─────────────────────────────▶  │  SimpleVAT (LS plugin)   │
│                          │                                  │                          │
│  • Direct-bake operator  │   {base}.fbx                     │  • Scan folder           │
│  • Reads evaluated mesh  │   {base}_{anim}_vat.png  ……      │  • Checkbox UI           │
│  • Writes PNG + JSON     │   {base}_{anim}.json     ……      │  • Import + spawn        │
│                          │                                  │  • Attach controller     │
└──────────────────────────┘                                  └──────────────────────────┘
```

- The Blender add-on **does not need** the LS plugin installed.
- The LS plugin **does not need** Blender — it can consume any folder that follows the file naming convention.

---

## Data formats

### Per-animation JSON sidecar

Filename: `{base}_{action}.json`. One per baked animation, sits next to its PNG.

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

Fields:

| Field | Type | Purpose |
|---|---|---|
| `name` | string | Human display name (shown in importer + controller) |
| `mesh` | string | Filename of the shared rest mesh (FBX) |
| `position_map` | string | Filename of this anim's position-map PNG |
| `num_frames` | int | Number of frames baked; equals the PNG height |
| `bbox_max` / `bbox_min` | float | Symmetric BBOX used to encode offsets into [0..1] pixel space. Importer sets `bbox = vec2(max, min)` on the shader |
| `speed` | float | Default playback speed |
| `frame_range` | string | "{start}-{end}" — informational |

The sidecar is **self-contained** — copy a `{anim}.png` + `{anim}.json` pair to another export folder and the LS importer can pick it up as long as the FBX is there too.

### PNG texture encoding

- Format: PNG8 RGBA
- Width: number of vertices
- Height: number of frames
- Top row = frame 0, bottom row = last frame (LS plugin uses `(uv.y * height) - 0.5` indexing internally via shader)
- Per pixel: `(R, G, B)` encodes `(offset.x, offset.y, offset.z)` mapped from `[-bbox, +bbox]` into `[0, 255]`. Centre value 128 = zero offset.
- A is always 255 (unused).
- Color space: `Non-Color` (Linear) — must be Nearest-filter, no compression in LS or values get garbled. (This is why the LS importer places textures under a folder literally named `Textures (Remove Compression)` — a reminder.)

### FBX rest mesh

- One FBX per object, named `{base}.fbx`, exported once per bake session and shared by every animation.
- Two UV layers: `UVMap` (original) + `VAT_UV` (per-vertex `u = vertex_index / num_verts`).
- `embed_textures=True` + `path_mode='COPY'` so the FBX brings its original base-color texture along — the LS importer detects this texture and assigns it to `passInfo.BaseTex` (see [Base texture carry-over](#base-texture-carry-over)).
- Mesh is the **rest pose** (armature pose set to REST + all shape keys zeroed at export time).

---

## Blender add-on

### Operators

| Operator | bl_idname | Description |
|---|---|---|
| Bake VAT | `vat.bake` | Bake every enabled row; falls back to scene timeline if none enabled. |
| Refresh Actions | `vat.refresh_actions` | Scan `bpy.data.actions`, populate the UI list. Pre-selects the bone-bearing slot for 4.4+ slotted actions. |
| Open Output Directory | `vat.open_output_directory` | OS file browser at the chosen output folder. |

### Slotted actions (Blender 4.4+)

In Blender 4.4+, an Action is a **collection of slots**, each holding fcurves for a particular target (armature, material, mesh, shape keys, …). Assigning an action via `armature.animation_data.action = my_action` does *not* automatically bind the correct slot — Blender will guess, and the wrong choice produces a frozen bake.

The add-on handles this explicitly:

1. **Refresh Actions** displays each action with a slot dropdown. Auto-selects the slot whose fcurves drive `pose.bones.*`.
2. **Bake** sets `armature.animation_data.action_slot = chosen_slot` after assigning the action.
3. **Frame range** is computed from the *chosen slot's actual keyframes*, not from `action.frame_range` (which is the union of all slots and would inflate `num_frames`).

For legacy actions (pre-4.4) the dropdown is hidden — there's only one slot anyway.

---

## Lens Studio plugin

### Import flow

When the user clicks **Import Selected**:

1. **Snapshot** the project's asset list (used later to detect what the FBX brings in).
2. **Read policy combos** for texture-conflict and existing-scene-object behavior.
3. **Conflict check** — for each selected animation, look up an asset named `{base}_{anim}_vat`. Apply policy (Overwrite → delete old asset, Skip → drop that anim from the list).
4. **Existing-object check** — `scene.sceneObjects.find(o => o.name === '{base}_VAT')`. Apply policy (Update / Replace / Skip).
5. **Import controller TS first** — gives LS the longest possible window to compile its `@input` schema before the plugin writes to it.
6. **Import FBX** (skipped in Update mode; the existing prefab is reused).
7. **Import bundled shader graph** and create a fresh `Material` via `assetManager.createNativeAsset("Material", name, dest) + addPass(graph)`. In Update mode, the existing material on the object is reused.
8. **Import each selected PNG** into `paths.tex`.
9. **Detect base texture** (see below) and set `passInfo.BaseTex`.
10. **Apply VAT material** to the spawned prefab's `RenderMeshVisual`s.
11. **Attach `ScriptComponent` with `VATAnimationController`** asset and populate its `@input` arrays. In Update mode the existing controller's arrays are read back and merged (new entries appended, same-name entries replaced).

### Conflict & scene-object policies

| Combo | Choices | Default |
|---|---|---|
| **On texture conflict** | Overwrite · Skip existing | Overwrite |
| **On existing object** | Update controller · Replace object · Skip scene | Update controller |

- **Update controller** preserves existing animations in the controller arrays and merges the new ones in by name.
- **Replace object** destroys the old `{base}_VAT` SceneObject and spawns a fresh one.
- **Skip scene** still imports all assets (textures, material, controller script) but leaves the scene untouched — useful if you only need updated assets and will wire the scene up by hand.

### Project layout after import

```
Assets/VAT/{base}/
├── Materials/
│   ├── Shaders/
│   │   └── VAT                       (shader graph)
│   └── {base}_VAT_Material
├── Script/
│   └── VATAnimationController
├── Textures (Remove Compression)/    ← name is a deliberate reminder
│   ├── {base}_{anim}_vat
│   └── ...
└── {base}                            (FBX prefab)
```

### Base texture carry-over

The plugin tries hard to find the base-color texture from the FBX's original material so the new VAT material doesn't render naked:

1. **Walk the spawned prefab.** Look at each `MeshVisual`'s materials, check `mainPass[<base-color key>]` — tries common names (`baseTexture`, `baseColor`, `BaseTex`, `mainTexture`, `albedoMap`, …) and, on miss, enumerates all pass properties skipping anything that looks like roughness / metallic / normal / AO / specular / emissive / rim / opacity / lighting.
2. **Delta-scan the project assets.** Before importing the FBX, the plugin records every existing asset id. After import it diffs to find new Texture assets, filters out our own `_vat` position maps and obvious non-base names (`white`, `black`, `*rough*`, `*metal*`, `*normal*`, `*_orm*`, etc.), and picks the first remaining one.
3. **Iterate `meshResult.files[].getNativePackageItems()`** (older LS layout).

The result is assigned to `passInfo.BaseTex` (try `Asset` form first, then `Editor.Assets.TextureParameter` wrapper). Both shader parameter types are supported.

If your shader graph **does not expose `BaseTex`**, this step silently skips with a log line — the import still completes without the base texture.

---

## VATAnimationController — full API

The controller lives at `SimpleVAT/Resources/VATAnimationController.ts` and is attached by the importer to the spawned `{base}_VAT` SceneObject.

### Inputs (populated by the importer)

| Field | Type | Notes |
|---|---|---|
| `material` | `Material` | The VAT material this controller writes into |
| `animationNames` | `string[]` | Display names, parallel array index ↔ all other arrays |
| `positionMaps` | `Texture[]` | One per animation |
| `numFramesArr` | `number[]` | One per animation |
| `bboxMaxArr` | `number[]` | Symmetric BBOX max (min = -max) |
| `speedArr` | `number[]` | Default speed per animation |
| `defaultIndex` | `number` | Animation to apply on Awake |
| `autoPlayOnStart` | `boolean` | If false, the controller stays idle until you call `play(…)` |

### Methods

```typescript
play(name: string): boolean
```
Switch to the animation with the given name. Case-sensitive. Returns `true` on success, `false` if the name isn't in the list (logs a warning and lists available names).

```typescript
playIndex(index: number): boolean
```
Switch by index. Returns `false` if out of range.

```typescript
setTimeOffset(seconds: number): void
```
Per-instance phase offset. Useful for de-syncing many copies of the same animation (each copy gets a different offset so they don't loop in lockstep).

```typescript
setSpeed(speed: number): void
```
Override playback speed. Resets to the authored value next time you switch animations.

```typescript
getAnimations(): string[]
```
Copy of the animation-name list.

```typescript
current(): string
```
Currently-playing name, or `""` if nothing has played yet.

```typescript
currentIndex(): number
```
Currently-playing index, or `-1`.

### Example: external script driving the controller

```typescript
@component
export class WormBehavior extends BaseScriptComponent {
    @input vat: VATAnimationController;

    onAwake() {
        // Switch on tap.
        this.createEvent("TapEvent").bind(() => this.vat.play("Attack"));
        // Random phase so multiple worms don't move in lockstep.
        this.vat.setTimeOffset(Math.random() * 2);
    }

    onHurt() {
        this.vat.play("Hurt");
    }
}
```

---

## Shader graph

`SimpleVAT/Resources/VAT.ss_graph` exposes these Parameters (visible in the Material Inspector and settable from script):

| Parameter | Type | Purpose |
|---|---|---|
| `Position Map` | Texture 2D | The VAT |
| `Number of Frames` | float | Total animation length in frames |
| `Speed` | float | Playback rate (frames per second of `getTime()`) |
| `BBOX Max/Min` | vec2 | `(max, min)` of the symmetric encoding range |
| `TimeOffset` | float | Phase offset in seconds (per-instance — set via `setTimeOffset()`) |
| `BaseTex` | Texture 2D Object | Base color texture (optional — carry-over from FBX) |

The Code node decodes pixels: reads `VAT_UV.x` to pick the vertex column, derives the row from `(getTime() * speed + TimeOffset) * 60 % numFrames` (roughly), samples the texture, maps `[0..1] → [-bbox..+bbox]` and applies the offset to `Surface.WorldPosition` (with the Blender→LS axis swap baked in).

To extend the look (rim light, custom AO, etc.) — edit the .ss_graph in the bundled `Shader + Material/` Lens Studio project, save, then copy the updated `VAT.ss_graph` + `.meta` back into `SimpleVAT/Resources/`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| All-grey textures, mesh doesn't animate | Armature stayed in REST during bake | Pull latest add-on — the issue is fixed via explicit pose-mode restore inside `_capture_rest_positions`. |
| One animation bakes correctly, another is frozen | Wrong slot bound on slotted action (Blender 4.4+) | Pick the right slot in the **Slot** dropdown next to the action row. |
| `num_frames` larger than visible animation in dope sheet | `action.frame_range` includes keyframes from OTHER slots | Already handled — frame range comes from the chosen slot's fcurves. If still wrong, delete the unwanted slot in the Outliner. |
| `Worm_Game_vat 2`, `Worm_Game_vat 3` etc. accumulating | LS asset-delete API rejected the old asset (likely referenced by something) | Use **Skip existing** policy, delete duplicates manually. We're tracking better deletion in the issue tracker. |
| VAT rendering shows banding / blocks | Texture compression got enabled | Folder is literally named `Textures (Remove Compression)` — open each texture in LS Inspector and set Optimization Type to **None**. |
| `BaseTex` empty after import | Shader graph doesn't expose `BaseTex` parameter | Re-export from Blender after enabling `embed_textures` (latest add-on does this by default), or expose a `BaseTex` parameter in your custom shader graph. |
| TypeScript compilation error about `NativeLogger` | The controller used to depend on SIK | Pull the latest controller — it uses bare `print()` and has zero external dependencies. |

If you hit something not in this table, please open a GitHub issue with:
- The LS console log (especially `[SimpleVAT]` lines)
- The Blender system console log (especially `[VAT]` lines)
- Blender version + LS version

---

## Contributing

```
.
├── BlenderAddon/            ← Python source (Blender 4.2+)
├── SimpleVAT/               ← JS source (Lens Studio 5)
│   └── Resources/           ← bundled assets the plugin imports into projects
├── build_addon.sh           ← rebuilds BlenderAddon.zip from sources
└── BlenderAddon.zip         ← committed binary so end users can install directly
```

After editing anything under `BlenderAddon/`, run `./build_addon.sh` and commit both the source changes and the refreshed `.zip` together.

The codebases are intentionally small (a few hundred lines per side) and **dependency-free** — please keep it that way. If you need a library, justify it in the PR.
