# LensStudio-SimpleVAT

**Bake vertex-animation textures in Blender, drop them into Lens Studio with one click.**

A two-part open-source pipeline for Snap Spectacles:
- A **Blender add-on** that bakes any skeletal / shape-key / simulation animation into a Vertex Animation Texture (VAT) export folder.
- A **Lens Studio plugin** (`SimpleVAT`) that scans that folder, imports the meshes / textures / shader / runtime controller, and wires everything up in the scene.

> _If you only need the LS plugin — install just `SimpleVAT/` and feed it a VAT folder you exported elsewhere._
> _If you want the full pipeline — install the Blender add-on too._

---

## How it looks

```
┌──────────────────────┐    folder of files     ┌────────────────────┐
│  Blender Add-on      │ ────────────────────▶ │  Lens Studio       │
│  ─────────────       │                        │  Plugin            │
│  • pick actions      │   {base}.fbx           │  • scan folder     │
│  • bake → folder     │   {base}_{anim}_vat.png│  • tick animations │
│                      │   {base}_{anim}.json   │  • import → scene  │
└──────────────────────┘                        └────────────────────┘
```

---

## Repository layout

```
LensStudio-SimpleVAT/
├── BlenderAddon/            ← Blender 4.2+ add-on (Direct Bake, no GeoNodes)
├── SimpleVAT/               ← Lens Studio 5 plugin
│   ├── module.json
│   ├── main.js
│   └── Resources/
│       ├── VAT.ss_graph                  (bundled shader)
│       └── VATAnimationController.ts     (runtime API)
├── README.md
└── LICENSE
```

---

## Install

### Blender add-on

1. Zip the `BlenderAddon/` folder.
2. Blender → **Edit › Preferences › Get Extensions › Install from Disk…** → pick the zip.
3. The panel appears in `View 3D › Sidebar (N) › VAT`.

### Lens Studio plugin

1. Copy the `SimpleVAT/` folder into your project's `Plugins/` directory (or LS user-plugins folder for global use).
2. Restart Lens Studio.
3. Open `Window › Panels › SimpleVAT`.

---

## Workflow

### 1) Bake in Blender

1. Select the mesh (with armature, shape keys, or simulation modifiers).
2. Open the **VAT** sidebar.
3. Set the **Output** folder.
4. Click **Refresh Actions** → tick the animations you want.
5. (Optional) if an action has multiple slots, pick the right one in the dropdown.
6. Click **Bake N Actions**.

Output per animation: `{base}_{action}_vat.png` (position texture) + `{base}_{action}.json` (metadata sidecar).
Plus a shared `{base}.fbx` (rest pose, with `VAT_UV` layer).

### 2) Import in Lens Studio

1. Open the **SimpleVAT** panel.
2. **Browse** to the `{base}_vat/` export folder. The plugin auto-scans.
3. Tick the animations to import.
4. Configure import policies:
   - **On texture conflict:** Overwrite / Skip existing
   - **On existing object:** Update controller / Replace object / Skip scene
5. Click **Import Selected**.

The plugin creates `Assets/VAT/{base}/` with:
- `Materials/Shaders/VAT` (bundled shader graph)
- `Materials/{base}_VAT_Material`
- `Script/VATAnimationController`
- `Textures (Remove Compression)/...` (one PNG per animation — **set compression to None on these**)
- the imported FBX

And spawns a `{base}_VAT` SceneObject with the material applied and the controller attached.

---

## Runtime API — VATAnimationController

The controller is attached to the spawned mesh and exposes a small, stable API for other scripts to drive playback.

```typescript
class VATAnimationController extends BaseScriptComponent {
    // Inputs populated at import time:
    material: Material;
    animationNames: string[];
    positionMaps: Texture[];
    numFramesArr: number[];
    bboxMaxArr: number[];
    speedArr: number[];
    defaultIndex: number;
    autoPlayOnStart: boolean;

    // API:
    play(name: string): boolean;
    playIndex(index: number): boolean;
    setTimeOffset(seconds: number): void;
    setSpeed(speed: number): void;
    getAnimations(): string[];
    current(): string;
    currentIndex(): number;
}
```

### Connect from your own script

```typescript
@component
export class WormBehavior extends BaseScriptComponent {
    @input vat: VATAnimationController;

    onAwake() {
        this.createEvent("TapEvent").bind(() => this.vat.play("Attack"));
    }

    onHurt() {
        this.vat.play("Hurt");
    }
}
```

In the Inspector, drag the spawned `{base}_VAT` object into the `vat` field — LS resolves the component automatically.

---

## Coordinate system

Blender is Z-up, Lens Studio is Y-up. The shader applies the swap as it samples the texture (`offset.xzy` with Y-negation), so the export and import are direct — no manual conversion needed.

---

## Known limitations

- **Topology must stay constant** across all baked frames. The bake aborts if vertex count changes mid-animation.
- **One material per imported mesh.** The controller writes into that material at runtime to switch animations. If you instantiate the same mesh prefab manually elsewhere in the scene, duplicate the material asset so each copy has its own playhead.
- **No normal-map output.** The new shader uses face-derived normals from the rest mesh.
- **Lens Studio asset deletion API is finicky.** On re-import with **Overwrite**, sometimes old texture assets remain alongside the new ones with a numeric suffix (`Texture 2`). Delete manually if it bothers you, or use **Skip existing** policy.

---

## Tested with

- Blender 4.2 → 5.1
- Lens Studio 5.10+
- Snap Spectacles (2024)

---

## Contributing

PRs welcome. The codebase is intentionally small (a few hundred lines per side) so it's easy to read and modify. Please keep new dependencies minimal — both plugins should be drop-in installable.

---

## License

[MIT](LICENSE) — do what you want, attribution appreciated.

## Author

**Pavlo Tkachenko** · 2026
