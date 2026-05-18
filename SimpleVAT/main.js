//@ts-nocheck
import PanelPlugin from "LensStudio:PanelPlugin";
import * as Ui from "LensStudio:Ui";
import * as FileSystem from "LensStudio:FileSystem";

/**
 * SimpleVAT — Lens Studio Importer
 *
 * Reads a folder exported by the BlenderAddon, lists every animation
 * found per JSON sidecar, lets the user tick which ones to import,
 * then for each VAT mesh:
 *   - imports the FBX rest mesh (once)
 *   - imports each selected position-map PNG
 *   - imports the bundled VAT.ss_graph and creates a fresh Material via
 *     createNativeAsset + addPass (one material per imported mesh)
 *   - spawns a SceneObject and attaches a VATAnimationController
 *     script populated with all animation data
 *
 * Author: Pavlo Tkachenko
 */
export class SimpleVATPanel extends PanelPlugin {
    static descriptor() {
        return {
            id: "com.spectacles.simplevat",
            name: "SimpleVAT",
            description: "Import Vertex Animation Textures from Blender into Lens Studio",
            dependencies: [Ui.IGui, Editor.Model.IModel]
        };
    }

    constructor(pluginSystem, descriptor) {
        super(pluginSystem, descriptor);
        this._model = null;
        this._gui = null;
        this._signals = [];
        this._rowSignals = [];
        this._rowWidgets = [];
        this._rowCheckboxes = [];
        this._scan = null; // { folder, base, animations: [{name, png, numFrames, bboxMax, speed}] }
    }

    get gui() {
        if (!this._gui) this._gui = this.pluginSystem.findInterface(Ui.IGui);
        return this._gui;
    }
    get model() {
        if (!this._model) this._model = this.pluginSystem.findInterface(Editor.Model.IModel);
        return this._model;
    }
    get assetManager() { return this.model.project.assetManager; }
    get scene() { return this.model.project.scene; }

    // ---------- UI ----------
    createWidget(parent) {
        // Outer widget hosts a single VerticalScrollArea so the WHOLE panel
        // scrolls when LS shrinks it, instead of clipping content.
        const w = new Ui.Widget(parent);
        const outerLayout = new Ui.BoxLayout();
        outerLayout.setDirection(Ui.Direction.TopToBottom);
        outerLayout.setContentsMargins(0, 0, 0, 0);
        outerLayout.spacing = 0;

        const content = new Ui.Widget(w);
        const root = new Ui.BoxLayout();
        root.setDirection(Ui.Direction.TopToBottom);
        root.spacing = 14;
        root.setContentsMargins(14, 14, 14, 14);

        const BTN_H = 30;
        const ROW_H = 30;

        // ----- Section 1: Folder -----
        const folderSection = this._makeSection(content, "1.  Pick the export folder");

        const folderRow = new Ui.Widget(content);
        const folderRowLayout = new Ui.BoxLayout();
        folderRowLayout.setDirection(Ui.Direction.LeftToRight);
        folderRowLayout.spacing = 6;
        folderRowLayout.setContentsMargins(0, 0, 0, 0);
        folderRow.setFixedHeight(ROW_H);

        this.pathEdit = new Ui.LineEdit(content);
        this.pathEdit.placeholderText = "/path/to/ObjectName_vat/";
        this.pathEdit.setSizePolicy(Ui.SizePolicy.Policy.Expanding, Ui.SizePolicy.Policy.Fixed);
        folderRowLayout.addWidget(this.pathEdit);

        const browseBtn = new Ui.PushButton(content);
        browseBtn.text = "Browse…";
        browseBtn.setSizePolicy(Ui.SizePolicy.Policy.Fixed, Ui.SizePolicy.Policy.Fixed);
        this._signals.push(browseBtn.onClick.connect(() => this.browseFolder()));
        folderRowLayout.addWidget(browseBtn);
        folderRow.layout = folderRowLayout;
        folderSection.layout.addWidget(folderRow);

        const scanBtn = new Ui.PushButton(content);
        scanBtn.text = "Scan Folder";
        scanBtn.primary = true;
        scanBtn.setFixedHeight(BTN_H);
        scanBtn.setSizePolicy(Ui.SizePolicy.Policy.Expanding, Ui.SizePolicy.Policy.Fixed);
        this._signals.push(scanBtn.onClick.connect(() => this.scanFolder()));
        folderSection.layout.addWidget(scanBtn);

        root.addWidget(folderSection);

        // ----- Section 2: Animations -----
        const animSection = this._makeSection(content, "2.  Choose animations");

        this.summaryLabel = new Ui.Label(content);
        this.summaryLabel.text = "Pick a folder and click Scan.";
        try { this.summaryLabel.foregroundRole = Ui.ColorRole.PlaceholderContent; } catch (_) {}
        this.summaryLabel.setSizePolicy(Ui.SizePolicy.Policy.Expanding, Ui.SizePolicy.Policy.Fixed);
        animSection.layout.addWidget(this.summaryLabel);

        const selRow = new Ui.Widget(content);
        const selRowLayout = new Ui.BoxLayout();
        selRowLayout.setDirection(Ui.Direction.LeftToRight);
        selRowLayout.spacing = 6;
        selRowLayout.setContentsMargins(0, 0, 0, 0);
        selRow.setFixedHeight(ROW_H);
        const selAllBtn = new Ui.PushButton(content);
        selAllBtn.text = "Select All";
        selAllBtn.setSizePolicy(Ui.SizePolicy.Policy.Expanding, Ui.SizePolicy.Policy.Fixed);
        this._signals.push(selAllBtn.onClick.connect(() => this.toggleAll(true)));
        const selNoneBtn = new Ui.PushButton(content);
        selNoneBtn.text = "Clear";
        selNoneBtn.setSizePolicy(Ui.SizePolicy.Policy.Expanding, Ui.SizePolicy.Policy.Fixed);
        this._signals.push(selNoneBtn.onClick.connect(() => this.toggleAll(false)));
        selRowLayout.addWidget(selAllBtn);
        selRowLayout.addWidget(selNoneBtn);
        selRow.layout = selRowLayout;
        animSection.layout.addWidget(selRow);

        // Checkbox list grows naturally; the OUTER scroll wraps everything.
        this.listWidget = new Ui.Widget(content);
        this.listLayout = new Ui.BoxLayout();
        this.listLayout.setDirection(Ui.Direction.TopToBottom);
        this.listLayout.spacing = 2;
        this.listLayout.setContentsMargins(0, 4, 0, 0);
        this.listWidget.layout = this.listLayout;
        this.listWidget.setSizePolicy(Ui.SizePolicy.Policy.Expanding, Ui.SizePolicy.Policy.Fixed);
        animSection.layout.addWidget(this.listWidget);

        root.addWidget(animSection);

        // ----- Section 3: Import -----
        const importSection = this._makeSection(content, "3.  Import to scene");

        // Inline conflict-policy combos so users pick behavior up-front,
        // no modal popups needed.
        const policyRow1 = new Ui.Widget(content);
        const policyRow1Layout = new Ui.BoxLayout();
        policyRow1Layout.setDirection(Ui.Direction.LeftToRight);
        policyRow1Layout.spacing = 6;
        policyRow1Layout.setContentsMargins(0, 0, 0, 0);
        policyRow1.setFixedHeight(ROW_H);

        const policyRow1Label = new Ui.Label(content);
        policyRow1Label.text = "On texture conflict:";
        policyRow1Label.setSizePolicy(Ui.SizePolicy.Policy.Fixed, Ui.SizePolicy.Policy.Fixed);
        policyRow1Label.setFixedWidth(140);
        policyRow1Layout.addWidget(policyRow1Label);

        this.conflictCombo = new Ui.ComboBox(content);
        this.conflictCombo.addItem("Overwrite");
        this.conflictCombo.addItem("Skip existing");
        this.conflictCombo.setSizePolicy(Ui.SizePolicy.Policy.Expanding, Ui.SizePolicy.Policy.Fixed);
        policyRow1Layout.addWidget(this.conflictCombo);

        policyRow1.layout = policyRow1Layout;
        importSection.layout.addWidget(policyRow1);

        const policyRow2 = new Ui.Widget(content);
        const policyRow2Layout = new Ui.BoxLayout();
        policyRow2Layout.setDirection(Ui.Direction.LeftToRight);
        policyRow2Layout.spacing = 6;
        policyRow2Layout.setContentsMargins(0, 0, 0, 0);
        policyRow2.setFixedHeight(ROW_H);

        const policyRow2Label = new Ui.Label(content);
        policyRow2Label.text = "On existing object:";
        policyRow2Label.setSizePolicy(Ui.SizePolicy.Policy.Fixed, Ui.SizePolicy.Policy.Fixed);
        policyRow2Label.setFixedWidth(140);
        policyRow2Layout.addWidget(policyRow2Label);

        this.sceneCombo = new Ui.ComboBox(content);
        this.sceneCombo.addItem("Update controller");
        this.sceneCombo.addItem("Replace object");
        this.sceneCombo.addItem("Skip scene");
        this.sceneCombo.setSizePolicy(Ui.SizePolicy.Policy.Expanding, Ui.SizePolicy.Policy.Fixed);
        policyRow2Layout.addWidget(this.sceneCombo);

        policyRow2.layout = policyRow2Layout;
        importSection.layout.addWidget(policyRow2);

        const importBtn = new Ui.PushButton(content);
        importBtn.text = "Import Selected";
        importBtn.primary = true;
        importBtn.setFixedHeight(36);
        importBtn.setSizePolicy(Ui.SizePolicy.Policy.Expanding, Ui.SizePolicy.Policy.Fixed);
        this._signals.push(importBtn.onClick.connect(() => this.importSelected()));
        importSection.layout.addWidget(importBtn);

        this.statusLabel = new Ui.Label(content);
        this.statusLabel.text = "Ready.";
        try { this.statusLabel.foregroundRole = Ui.ColorRole.PlaceholderContent; } catch (_) {}
        this.statusLabel.setSizePolicy(Ui.SizePolicy.Policy.Expanding, Ui.SizePolicy.Policy.Fixed);
        this.statusLabel.wordWrap = true;
        importSection.layout.addWidget(this.statusLabel);

        root.addWidget(importSection);

        // Subtle footer credits.
        const credits = new Ui.Label(content);
        credits.text = "SimpleVAT · by Pavlo Tkachenko";
        try { credits.foregroundRole = Ui.ColorRole.PlaceholderContent; } catch (_) {}
        try { credits.fontRole = Ui.FontRole.Small; } catch (_) {}
        credits.setSizePolicy(Ui.SizePolicy.Policy.Expanding, Ui.SizePolicy.Policy.Fixed);
        root.addWidget(credits);

        // Push content to top — without this the scroll-area would center it.
        root.addStretch(1);

        content.layout = root;
        content.setSizePolicy(Ui.SizePolicy.Policy.Expanding, Ui.SizePolicy.Policy.Fixed);

        const scroll = new Ui.VerticalScrollArea(w);
        scroll.setWidget(content);
        scroll.setSizePolicy(Ui.SizePolicy.Policy.Expanding, Ui.SizePolicy.Policy.Expanding);
        outerLayout.addWidget(scroll);

        w.layout = outerLayout;
        return w;
    }

    /** Build a titled section: bold heading, thin underline separator,
     *  body below. Returns the outer widget; append children to section.layout. */
    _makeSection(parent, titleText) {
        const section = new Ui.Widget(parent);
        const sectionLayout = new Ui.BoxLayout();
        sectionLayout.setDirection(Ui.Direction.TopToBottom);
        sectionLayout.spacing = 6;
        sectionLayout.setContentsMargins(0, 0, 0, 0);

        const title = new Ui.Label(parent);
        title.text = titleText;
        // Bigger + bolder than body text for clear hierarchy.
        try { title.fontRole = Ui.FontRole.MediumTitleBold; }
        catch (_) { try { title.fontRole = Ui.FontRole.DefaultBold; } catch (_) {} }
        try { title.foregroundRole = Ui.ColorRole.BrightText; } catch (_) {}
        title.setFixedHeight(22);
        sectionLayout.addWidget(title);

        // Thin separator under the title — visually anchors each section.
        const sep = new Ui.Separator(Ui.Orientation.Horizontal, Ui.Shadow.Plain, parent);
        sectionLayout.addWidget(sep);

        section.layout = sectionLayout;
        section.setSizePolicy(Ui.SizePolicy.Policy.Expanding, Ui.SizePolicy.Policy.Fixed);
        return section;
    }

    stop() {
        for (const sig of this._signals) { try { sig.disconnect(); } catch (_) {} }
        this._signals.length = 0;
        this._clearRows();
    }

    // ---------- folder + scan ----------

    browseFolder() {
        try {
            const folderPath = this.gui.dialogs.selectFolderToOpen(
                { caption: "Select VAT Export Folder" },
                new Editor.Path("")
            );
            if (folderPath && !folderPath.isEmpty) {
                this.pathEdit.text = folderPath.toString();
                this.scanFolder();
            }
        } catch (e) {
            this.log("Browse dialog error: " + e.message);
        }
    }

    baseName(folderPath) {
        const parts = folderPath.replace(/\/+$/, "").split("/");
        const folder = parts[parts.length - 1] || "";
        return folder.replace(/_vat$/i, "");
    }

    tryReadFile(absPath) {
        try { return FileSystem.readFile(new Editor.Path(absPath)); }
        catch (_) { return null; }
    }

    scanFolder() {
        const folder = this.pathEdit.text.trim();
        if (!folder) {
            this.statusLabel.text = "Enter the VAT export folder path first.";
            return;
        }
        const base = this.baseName(folder);

        // List the folder, then pair every {base}_{action}.json with its PNG.
        let entries;
        try {
            entries = FileSystem.readDir(new Editor.Path(folder), { recursive: false });
        } catch (e) {
            this.statusLabel.text = "Cannot read folder: " + e.message;
            this._scan = null;
            this._clearRows();
            return;
        }

        const animations = [];
        const prefix = base + "_";
        for (const entry of entries) {
            const name = String(entry).split("/").pop();
            if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;

            const raw = this.tryReadFile(folder + "/" + name);
            if (!raw) continue;

            let data;
            try { data = JSON.parse(raw); }
            catch (_) { continue; }

            if (!data || !data.name || !data.position_map) continue;

            const pngPath = folder + "/" + data.position_map;
            let pngExists = false;
            try { pngExists = FileSystem.exists(new Editor.Path(pngPath)); }
            catch (_) { pngExists = this.tryReadFile(pngPath) !== null; }
            if (!pngExists) {
                this.log(`Skipping "${data.name}": PNG missing (${data.position_map})`);
                continue;
            }

            animations.push({
                name: String(data.name),
                png: pngPath,
                numFrames: Number(data.num_frames),
                bboxMax: Number(data.bbox_max),
                speed: Number(data.speed) || 1.0,
                selected: true,
            });
        }

        if (animations.length === 0) {
            this.statusLabel.text = `No animations found. Looking for ${base}_*.json next to PNGs.`;
            this._scan = null;
            this._clearRows();
            return;
        }

        animations.sort((a, b) => a.name.localeCompare(b.name));
        this._scan = { folder, base, animations };
        this._buildRows();
        this.summaryLabel.text = `Found ${animations.length} animation(s) for "${base}".`;
        this.statusLabel.text = "Tick the ones you want and click Import Selected.";
    }

    _clearRows() {
        for (const sig of this._rowSignals) { try { sig.disconnect(); } catch (_) {} }
        this._rowSignals.length = 0;
        // LS BoxLayout has no count()/takeAt() — track row widgets ourselves
        // and hide/destroy them explicitly.
        for (const w of this._rowWidgets) {
            try { w.visible = false; } catch (_) {}
            try { w.deleteLater(); } catch (_) {
                try { w.destroy(); } catch (_) {}
            }
        }
        this._rowWidgets.length = 0;
        this._rowCheckboxes.length = 0;
    }

    _buildRows() {
        this._clearRows();
        if (!this._scan) return;
        for (let i = 0; i < this._scan.animations.length; i++) {
            const anim = this._scan.animations[i];
            const rowWidget = new Ui.Widget(this.listWidget);
            rowWidget.setFixedHeight(22);
            rowWidget.setSizePolicy(Ui.SizePolicy.Policy.Expanding, Ui.SizePolicy.Policy.Fixed);
            const rowLayout = new Ui.BoxLayout();
            rowLayout.setDirection(Ui.Direction.LeftToRight);
            rowLayout.setContentsMargins(0, 0, 0, 0);
            rowLayout.spacing = Ui.Sizes.Padding;

            const cb = new Ui.CheckBox(rowWidget);
            const existing = this._findExistingTexture(this._scan.base, anim.name);
            const tag = existing ? "  [already imported]" : "";
            cb.text = `${anim.name}  (${anim.numFrames}f, ±${anim.bboxMax})${tag}`;
            cb.checked = true;
            cb.setSizePolicy(Ui.SizePolicy.Policy.Expanding, Ui.SizePolicy.Policy.Fixed);
            const idx = i;
            this._rowSignals.push(cb.onToggle.connect((checked) => {
                this._scan.animations[idx].selected = checked;
            }));
            rowLayout.addWidget(cb);
            rowWidget.layout = rowLayout;
            this.listLayout.addWidget(rowWidget);
            this._rowWidgets.push(rowWidget);
            this._rowCheckboxes.push(cb);
        }
    }

    toggleAll(state) {
        if (!this._scan) return;
        for (let i = 0; i < this._scan.animations.length; i++) {
            this._scan.animations[i].selected = state;
            if (this._rowCheckboxes && this._rowCheckboxes[i]) {
                this._rowCheckboxes[i].blockSignals(true);
                this._rowCheckboxes[i].checked = state;
                this._rowCheckboxes[i].blockSignals(false);
            }
        }
    }

    // ---------- bundled resources ----------

    async importBundled(filename, destPath, resultType) {
        const url = import.meta.resolve("Resources/" + filename);
        const filePath = url.replace(/^file:\/\//, "");
        const result = await this.assetManager.importExternalFileAsync(
            new Editor.Path(filePath),
            destPath,
            resultType || Editor.Model.ResultType.Auto
        );
        if (!result || !result.primary) {
            throw new Error("Bundled import returned no primary asset: " + filename);
        }
        return result.primary;
    }

    // ---------- conflict detection ----------

    /** Remove an asset from the project. LS texture assets don't always
     *  expose `.path`, so the caller may pass a guessed path constructed
     *  from the import destination. */
    _removeAssetSafely(asset, guessedPath) {
        if (!asset) return false;
        const name = String(asset.name || "?");
        const assetPath = asset.path || asset.url || asset.filePath ||
                          asset.relativePath || null;
        const path = assetPath || guessedPath || null;
        this.log(`Removing "${name}" (assetPath="${assetPath}", guessed="${guessedPath}", type="${asset.type}")`);
        // Diagnostic: list asset's enumerable keys so we see what's actually there.
        try {
            const keys = [];
            for (const k in asset) keys.push(k);
            this.log(`  asset keys: [${keys.slice(0, 20).join(", ")}]`);
        } catch (_) {}

        const attempts = [
            ["assetManager.remove(string path)", () => {
                if (!path) throw new Error("no path");
                this.assetManager.remove(String(path));
            }],
            ["assetManager.remove(Editor.Path)", () => {
                if (!path) throw new Error("no path");
                this.assetManager.remove(new Editor.Path(String(path)));
            }],
            ["assetManager.remove(asset.id)", () => {
                if (!asset.id) throw new Error("no asset id");
                this.assetManager.remove(asset.id);
            }],
            ["FileSystem.removeFile(Editor.Path)", () => {
                if (!path) throw new Error("no path");
                FileSystem.removeFile(new Editor.Path(String(path)));
            }],
            ["assetManager.remove(asset)", () => {
                this.assetManager.remove(asset);
            }],
            ["assetManager.removeAsset(asset)", () => {
                this.assetManager.removeAsset(asset);
            }],
            ["asset.remove()", () => {
                asset.remove();
            }],
        ];

        for (const [label, fn] of attempts) {
            try {
                fn();
                this.log(`  ✓ removed via ${label}`);
                return true;
            } catch (e) {
                this.log(`  ✗ ${label}: ${e.message}`);
            }
        }
        this.log(`  All remove APIs failed for ${name}.`);
        return false;
    }

    /** Returns existing asset (or null) matching the texture name for an anim. */
    _findExistingTexture(base, animName) {
        const expected = `${base}_${animName}_vat`;
        try {
            const assets = this.assetManager.assets || [];
            for (const a of assets) {
                const n = String(a.name || "").replace(/\.png$/i, "");
                if (n === expected) return a;
            }
        } catch (_) {}
        return null;
    }

    async _askConflictResolution(conflictNames) {
        // Modal with three buttons. Returns "overwrite" | "skip" | "cancel".
        return await new Promise(resolve => {
            const dialog = this.gui.dialogs.createDialog();
            dialog.windowTitle = "VAT Import — Conflict";
            dialog.resize(480, 200);
            dialog.setModal(true);

            const layout = new Ui.BoxLayout();
            layout.setDirection(Ui.Direction.TopToBottom);

            const title = new Ui.Label(dialog);
            title.text = "Animations already imported";
            try { title.foregroundRole = Ui.ColorRole.BrightText; } catch (_) {}
            layout.addWidget(title);

            const body = new Ui.Label(dialog);
            const preview = conflictNames.slice(0, 8).join(", ");
            const extra = conflictNames.length > 8 ? ` (+${conflictNames.length - 8} more)` : "";
            body.text =
                `${conflictNames.length} animation(s) already exist in this project:\n` +
                `  ${preview}${extra}\n\n` +
                `Overwrite the existing assets, skip them, or cancel the whole import?`;
            layout.addWidget(body);

            const btnRow = new Ui.BoxLayout();
            btnRow.setDirection(Ui.Direction.LeftToRight);

            const finish = (choice) => { resolve(choice); try { dialog.close(); } catch (_) {} };

            const overwriteBtn = new Ui.PushButton(dialog);
            overwriteBtn.text = "Overwrite";
            overwriteBtn.primary = true;
            overwriteBtn.onClick.connect(() => finish("overwrite"));
            btnRow.addWidget(overwriteBtn);

            const skipBtn = new Ui.PushButton(dialog);
            skipBtn.text = "Skip existing";
            skipBtn.onClick.connect(() => finish("skip"));
            btnRow.addWidget(skipBtn);

            const cancelBtn = new Ui.PushButton(dialog);
            cancelBtn.text = "Cancel";
            cancelBtn.onClick.connect(() => finish("cancel"));
            btnRow.addWidget(cancelBtn);

            layout.addLayout(btnRow);
            layout.setContentsMargins(
                Ui.Sizes.DialogContentMargin, Ui.Sizes.DialogContentMargin,
                Ui.Sizes.DialogContentMargin, Ui.Sizes.DialogContentMargin
            );
            layout.spacing = Ui.Sizes.Padding;
            dialog.layout = layout;

            dialog.onClose.connect(() => resolve("cancel"));
            dialog.show();
        });
    }

    // ---------- main import ----------

    async importSelected() {
        if (!this._scan) {
            this.statusLabel.text = "Scan a folder first.";
            return;
        }
        let selected = this._scan.animations.filter(a => a.selected);
        if (selected.length === 0) {
            this.statusLabel.text = "Tick at least one animation.";
            return;
        }

        const { folder, base } = this._scan;

        // Organized folder layout — defined UP-FRONT so the conflict logic below
        // can guess on-disk paths for textures that don't expose `.path` directly.
        const root = `VAT/${base}`;
        const paths = {
            mesh:    new Editor.Path(root),
            mat:     new Editor.Path(`${root}/Materials`),
            shader:  new Editor.Path(`${root}/Materials/Shaders`),
            script:  new Editor.Path(`${root}/Script`),
            tex:     new Editor.Path(`${root}/Textures (Remove Compression)`),
        };

        // Read user policy from inline combos — no modal dialogs.
        const conflictPolicy = ["overwrite", "skip"][this.conflictCombo.currentIndex] || "overwrite";

        // Conflict check: which selected animations already have a texture asset?
        const conflicts = selected.filter(a => this._findExistingTexture(base, a.name) !== null);
        if (conflicts.length > 0) {
            this.log(`${conflicts.length} conflict(s): [${conflicts.map(a => a.name).join(", ")}] - policy=${conflictPolicy}`);
            if (conflictPolicy === "skip") {
                const conflictSet = new Set(conflicts.map(a => a.name));
                selected = selected.filter(a => !conflictSet.has(a.name));
                if (selected.length === 0) {
                    this.statusLabel.text = "All selected animations already exist — nothing to do.";
                    return;
                }
            } else {
                // overwrite — delete old texture assets so the import doesn't create " 2" copies.
                for (const a of conflicts) {
                    const old = this._findExistingTexture(base, a.name);
                    if (old) {
                        const guessedPath = `${paths.tex}/${old.name}.png`;
                        this._removeAssetSafely(old, guessedPath);
                    }
                }
            }
        }

        this.statusLabel.text = `Importing ${selected.length} animation(s)...`;

        // Existing scene object → use the policy combo to decide what to do.
        const targetName = `${base}_VAT`;
        const existingObj = this._findExistingVATObject(base);
        let sceneAction = "create"; // "create" | "update" | "replace" | "skip"
        if (existingObj) {
            sceneAction = ["update", "replace", "skip"][this.sceneCombo.currentIndex] || "update";
            this.log(`Found existing "${existingObj.name}" — policy=${sceneAction}`);
        } else {
            let totalCount = "?";
            try { totalCount = (this.scene.sceneObjects || []).length; } catch (_) {}
            this.log(`No existing "${targetName}" in scene (scanned ${totalCount} object(s)). Will create new.`);
        }

        try {
            // Controller imported FIRST so LS has the longest possible window to
            // compile its TypeScript before we try to write @input fields on it.
            const controllerAsset = await this.importBundled(
                "VATAnimationController.ts", paths.script, Editor.Model.ResultType.Auto
            );
            this.log("Imported controller script");

            // FBX rest mesh (only needed when we're spawning a fresh object).
            let meshResult = null;
            // Snapshot the asset list BEFORE FBX import so we can identify
            // which Texture assets the FBX brought with it.
            const assetsBeforeFbx = new Set();
            try {
                for (const a of (this.assetManager.assets || [])) {
                    if (a && a.id) assetsBeforeFbx.add(String(a.id));
                }
            } catch (_) {}

            if (sceneAction === "create" || sceneAction === "replace") {
                const fbxPath = folder + "/" + base + ".fbx";
                meshResult = await this.assetManager.importExternalFileAsync(
                    new Editor.Path(fbxPath),
                    paths.mesh,
                    Editor.Model.ResultType.Packed
                );
                this.log(`Imported FBX: ${base}.fbx`);
            }

            // Shader graph (one per session) + fresh material via createNativeAsset.
            // For "update" mode we reuse the existing material on the existing object.
            let materialAsset = null;
            let passInfo = null;
            if (sceneAction === "update" && existingObj) {
                materialAsset = this._findMaterialOnObject(existingObj);
                if (materialAsset) {
                    passInfo = materialAsset.mainPass ||
                               (materialAsset.getPass ? materialAsset.getPass(0) : null);
                    this.log(`Reusing existing material: ${materialAsset.name}`);
                }
            }
            if (!materialAsset) {
                const shaderGraph = await this.importBundled(
                    "VAT.ss_graph", paths.shader, Editor.Model.ResultType.Auto
                );
                materialAsset = this.assetManager.createNativeAsset(
                    "Material",
                    `${base}_VAT_Material`,
                    paths.mat
                );
                passInfo = materialAsset.addPass(shaderGraph);
                this.log(`Created material: ${materialAsset.name}`);
            }

            // Per-animation textures.
            const textures = [];
            for (const anim of selected) {
                const result = await this.assetManager.importExternalFileAsync(
                    new Editor.Path(anim.png),
                    paths.tex,
                    Editor.Model.ResultType.Auto
                );
                textures.push(result.primary);
                this.log(`Imported texture: ${anim.png.split("/").pop()}`);
            }

            // BaseTex detection deferred until after the prefab is spawned —
            // we walk the FBX-imported materials and pick their actual base
            // texture, not a guess by filename.

            // Configure passInfo with the FIRST animation's params (initial pose).
            const first = selected[0];
            const firstTex = textures[0];
            if (passInfo) this._setPassParams(passInfo, firstTex, first);

            // Scene mutation per the user's choice.
            let rootObj = null;
            let sc = null;

            if (sceneAction === "skip") {
                // Assets are already imported by this point (textures + material +
                // controller). Leaving the scene alone — useful if the user just
                // wanted to refresh assets and will wire them up manually.
                this.statusLabel.text =
                    `Imported ${selected.length} texture(s): ${selected.map(a => a.name).join(", ")}\n` +
                    `Material: ${materialAsset.name}\n` +
                    `Scene left unchanged (Skip).`;
                this.log(this.statusLabel.text.replace(/\n/g, " | "));
                return;
            }

            if (sceneAction === "replace") {
                try { existingObj.destroy(); }
                catch (_) {
                    try { this.scene.destroySceneObject(existingObj); }
                    catch (e) { this.log(`Could not destroy old object: ${e.message}`); }
                }
            }

            if (sceneAction === "update" && existingObj) {
                rootObj = existingObj;
                this._applyMaterialRecursive(rootObj, materialAsset);
                sc = this._findControllerComponent(rootObj);
                if (!sc) {
                    this.log("No existing controller found on object — attaching a fresh one.");
                    sc = rootObj.addComponent("ScriptComponent");
                    sc.scriptAsset = controllerAsset;
                    this._populateController(sc, materialAsset, selected, textures);
                } else {
                    // Merge new animations into the existing controller so
                    // previously-imported ones aren't lost.
                    const merged = this._mergeControllerData(sc, selected, textures);
                    this.log(`Merged controller: ${merged.before.length} existing + ` +
                             `${selected.length} new -> ${merged.list.length} total ` +
                             `(${merged.replaced} replaced, ${merged.added} added)`);
                    this._populateController(sc, materialAsset, merged.list, merged.textures);
                }
            } else {
                // create OR replace -> brand-new object
                rootObj = this._spawnPrefab(meshResult, base);

                // Inspect FBX-imported materials BEFORE we replace them with our
                // VAT material, so we can carry their base-color texture forward.
                let baseTex = null;
                if (rootObj) {
                    baseTex = this._findBaseTextureOnObject(rootObj);
                    if (baseTex) this.log(`Found base texture via material walk: ${baseTex.name || "?"}`);
                }
                if (!baseTex && meshResult) {
                    // Fallback 1: any Texture asset that appeared in the project
                    // AFTER the FBX import — that's what the FBX brought with it.
                    baseTex = this._findNewTextureAsset(assetsBeforeFbx);
                    if (baseTex) this.log(`Fallback (delta) picked: ${baseTex.name || "?"}`);
                }
                if (!baseTex && meshResult) {
                    // Fallback 2: enumerate meshResult.files (older LS).
                    baseTex = this._findTextureInImportFiles(meshResult);
                    if (baseTex) this.log(`Fallback (files) picked: ${baseTex.name || "?"}`);
                }
                if (!baseTex && meshResult) {
                    // Fallback 3: meshResult.assets if present (oldest LS).
                    for (const a of (meshResult.assets || [])) {
                        if (String(a.type || "").toLowerCase().includes("texture")) {
                            baseTex = a;
                            this.log(`Fallback (assets) picked: ${a.name}`);
                            break;
                        }
                    }
                }
                if (baseTex && passInfo) this._applyBaseTexToPass(passInfo, baseTex);
                else this.log("No base texture found anywhere. Re-bake in Blender with the latest addon (embed_textures=True), or the FBX material has no image.");

                if (rootObj) this._applyMaterialRecursive(rootObj, materialAsset);
                sc = this._attachController(rootObj, controllerAsset, materialAsset, selected, textures);
            }

            const animNames = selected.map(a => a.name).join(", ");
            this.statusLabel.text =
                `Imported ${selected.length} animation(s): ${animNames}\n` +
                `Default: ${first.name}\n` +
                `Controller: VATAnimationController on "${rootObj.name}" (${sceneAction})`;
            this.log(this.statusLabel.text.replace(/\n/g, " | "));
        } catch (e) {
            this.statusLabel.text = "Error: " + e.message;
            console.error("[VAT] " + e.message + "\n" + e.stack);
        }
    }

    /** Diff the project's asset list against a pre-import snapshot, return
     *  the first NEW Texture asset that's plausibly a BASE color (not
     *  roughness/metallic/normal/white/etc). */
    _findNewTextureAsset(beforeIds) {
        try {
            const all = this.assetManager.assets || [];
            this.log(`Scanning ${all.length} project asset(s) for new textures...`);
            const found = [];
            for (const a of all) {
                if (!a || !a.id) continue;
                if (beforeIds.has(String(a.id))) continue;
                const t = String(a.type || "").toLowerCase();
                if (t.includes("texture")) {
                    found.push(a);
                    this.log(`  new texture: ${a.name} (type=${a.type})`);
                }
            }
            const isObviouslyNotBase = (name) => {
                const n = name.toLowerCase();
                return n === "white" || n === "black" || n === "default" ||
                       n.includes("rough") || n.includes("metal") || n.includes("normal") ||
                       n.includes("_orm") || n.includes("_arm") || n.includes("specular") ||
                       n.includes("emiss") || n.includes("_ao") || n.includes("occlusion") ||
                       /_vat$/i.test(name); // our own position maps
            };
            // Pass 1: skip both _vat AND obvious non-base names.
            for (const a of found) {
                if (!isObviouslyNotBase(String(a.name || ""))) return a;
            }
            // Pass 2: at least skip our _vat maps.
            for (const a of found) {
                if (!/_vat$/i.test(String(a.name || ""))) return a;
            }
            return found[0] || null;
        } catch (e) {
            this.log(`asset-delta scan failed: ${e.message}`);
            return null;
        }
    }

    /** Walks meshResult.files[].getNativePackageItems() looking for Texture
     *  assets. This is the right path for packed FBX imports — `meshResult.assets`
     *  is often empty even though the package contains textures internally. */
    _findTextureInImportFiles(meshResult) {
        const files = meshResult.files || [];
        this.log(`Scanning ${files.length} import file(s) for textures...`);
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            let items = [];
            try {
                items = f.getNativePackageItems(
                    Editor.Model.AssetImportMetadata.PackageIterate.Recursive
                );
            } catch (e1) {
                try {
                    items = f.getNativePackageItems(
                        Editor.Model.AssetImportMetadata.PackageIterate.Shallow
                    );
                } catch (e2) {
                    this.log(`  file[${i}] getNativePackageItems failed: ${e1.message}`);
                    continue;
                }
            }
            this.log(`  file[${i}] -> ${items.length} item(s)`);
            for (const item of items) {
                const pa = item.primaryAsset;
                if (!pa) continue;
                const typeName = String(pa.type || "").toLowerCase();
                this.log(`    - ${pa.name} (type=${pa.type})`);
                if (typeName.includes("texture")) return pa;
            }
        }
        return null;
    }

    /** Walks the spawned FBX prefab tree, finds the first material on any
     *  MeshVisual, then inspects that material's pass for a Texture-typed
     *  property — that's the texture the artist actually bound to the mesh.
     *  Robust to whatever the texture was named in Blender. */
    _findBaseTextureOnObject(obj) {
        if (!obj) return null;
        try {
            const components = obj.components || [];
            for (const c of components) {
                const t = c.getTypeName();
                if (t !== "RenderMeshVisual" && t !== "MaterialMeshVisual" &&
                    t !== "MeshVisual" && t !== "BaseMeshVisual") continue;
                const mats = c.materials || (c.mainMaterial ? [c.mainMaterial] : []);
                for (const mat of mats) {
                    const tex = this._extractTextureFromMaterial(mat);
                    if (tex) return tex;
                }
            }
        } catch (_) {}
        try {
            const children = obj.children || [];
            for (const child of children) {
                const found = this._findBaseTextureOnObject(child);
                if (found) return found;
            }
        } catch (_) {}
        return null;
    }

    /** Try to pull the BASE COLOR texture out of a material's pass.
     *  Strong preference for properties named "base*". Avoids
     *  roughness/metallic/normal/AO maps even when iterating.
     *  Logs what it sees so we can diagnose unknown shader layouts. */
    _extractTextureFromMaterial(mat) {
        if (!mat) return null;
        const pass = mat.mainPass || (mat.getPass ? mat.getPass(0) : null);
        if (!pass) { this.log("  material has no pass"); return null; }

        // Step 1: try preferred base-color names.
        const preferred = [
            "baseTexture", "baseColorTexture", "baseColor",
            "baseTex", "BaseTex", "BaseTexture", "BaseColor",
            "Base Color", "Base Texture",
            "mainTexture", "diffuseTexture", "diffuseMap",
            "albedoMap", "albedo", "albedoTexture",
        ];
        for (const key of preferred) {
            try {
                const v = pass[key];
                if (v && (v.id || v.texture || v.asset)) {
                    this.log(`  matched preferred key '${key}'`);
                    return v.texture || v.asset || v;
                }
            } catch (_) {}
        }

        // Step 2: enumerate, with a strong NEGATIVE filter for known non-base maps.
        const isNotBase = (key) => {
            const k = key.toLowerCase();
            return k.includes("rough") || k.includes("metal") || k.includes("normal") ||
                   k.includes("specular") || k.includes("ao") || k.includes("occlusion") ||
                   k.includes("emiss") || k.includes("rim") || k.includes("opacity") ||
                   k.includes("recolor") || k.includes("vertex") || k.includes("lighting") ||
                   k.includes("lod") || k.startsWith("port_");
        };
        const seenKeys = [];
        try {
            for (const key in pass) {
                seenKeys.push(key);
                if (isNotBase(key)) continue;
                let v;
                try { v = pass[key]; } catch (_) { continue; }
                if (!v) continue;
                const looksLikeTex = (v.id !== undefined && v.sampler !== undefined) ||
                                     (v.type !== undefined && String(v.type).toLowerCase().includes("texture"));
                if (looksLikeTex) {
                    this.log(`  matched enumerated key '${key}' (base-name fallback)`);
                    return v.texture || v.asset || v;
                }
            }
        } catch (_) {}
        this.log(`  material pass had no usable base texture. Keys seen: [${seenKeys.join(", ")}]`);
        return null;
    }

    /** Assign a base texture to the VAT material. Accepts either a raw asset
     *  or a TextureParameter — the shader may expose BaseTex as either. */
    _applyBaseTexToPass(pass, baseTex) {
        // Unwrap if we were handed a TextureParameter from a source material.
        let assetForId = baseTex;
        if (baseTex && baseTex.texture) assetForId = baseTex.texture;
        else if (baseTex && baseTex.asset) assetForId = baseTex.asset;

        const name = String((assetForId && assetForId.name) || baseTex.name || "<unnamed>");
        this.log(`Carrying base texture from FBX material: ${name}`);

        try {
            pass.BaseTex = assetForId;
            this.log("  -> set passInfo.BaseTex (asset form)");
            return;
        } catch (e1) {
            try {
                pass.BaseTex = new Editor.Assets.TextureParameter(assetForId.id);
                this.log("  -> set passInfo.BaseTex (TextureParameter form)");
                return;
            } catch (e2) {
                this.log(`  -> could not set BaseTex: ${e1.message} / ${e2.message}`);
            }
        }
    }

    /** Reads current @input arrays off a ScriptComponent and merges new
     *  selections into them. New entries with the same name as an existing
     *  one REPLACE; otherwise APPEND. Returns the merged list + textures. */
    _mergeControllerData(sc, newSelected, newTextures) {
        const safeArr = (v) => {
            if (!v) return [];
            // Some LS array bindings expose .length / index access without being plain arrays.
            try { return Array.from(v); } catch (_) {}
            try {
                const out = [];
                for (let i = 0; i < v.length; i++) out.push(v[i]);
                return out;
            } catch (_) { return []; }
        };
        const names    = safeArr(sc.animationNames);
        const maps     = safeArr(sc.positionMaps);
        const frames   = safeArr(sc.numFramesArr);
        const bboxes   = safeArr(sc.bboxMaxArr);
        const speeds   = safeArr(sc.speedArr);

        this.log(`  existing controller state: ${names.length} anim(s): [${names.join(", ")}]`);

        // Build a parallel list of existing anims as {name, numFrames, ...}.
        const list = [];
        const textures = [];
        for (let i = 0; i < names.length; i++) {
            list.push({
                name: String(names[i]),
                numFrames: Number(frames[i]),
                bboxMax: Number(bboxes[i]),
                speed: Number(speeds[i]),
            });
            textures.push(maps[i]);
        }
        const before = list.slice();

        let replaced = 0, added = 0;
        for (let i = 0; i < newSelected.length; i++) {
            const anim = newSelected[i];
            const tex = newTextures[i];
            const at = list.findIndex(a => a.name === anim.name);
            if (at >= 0) {
                list[at] = anim;
                textures[at] = tex;
                replaced++;
            } else {
                list.push(anim);
                textures.push(tex);
                added++;
            }
        }
        return { list, textures, before, replaced, added };
    }

    /** Walks an object tree, returns the first material found on any visual. */
    _findMaterialOnObject(obj) {
        if (!obj) return null;
        try {
            const components = obj.components || [];
            for (const c of components) {
                const t = c.getTypeName();
                if (t === "RenderMeshVisual" || t === "MaterialMeshVisual" ||
                    t === "MeshVisual" || t === "BaseMeshVisual") {
                    const mats = c.materials;
                    if (mats && mats.length > 0) return mats[0];
                    if (c.mainMaterial) return c.mainMaterial;
                }
            }
        } catch (_) {}
        try {
            const children = obj.children || [];
            for (const child of children) {
                const m = this._findMaterialOnObject(child);
                if (m) return m;
            }
        } catch (_) {}
        return null;
    }

    _setPassParams(pass, texture, anim) {
        // The shader exposes: positionMap (Texture2D), numFrames, speed,
        // bbox (vec2 = {x: max, y: min}), TimeOffset (set per-instance manually).
        if (!pass) throw new Error("No pass to configure.");

        const texParam = new Editor.Assets.TextureParameter(texture.id);
        // VAT must read raw pixels; LS-default filtering would corrupt the encoding.
        // Try string enum then int fallback so we don't end up silently bilinear.
        let filterSet = false;
        try { texParam.filteringMode = "Nearest"; filterSet = true; } catch (_) {}
        if (!filterSet) { try { texParam.filteringMode = 0; filterSet = true; } catch (_) {} }
        if (!filterSet) { this.log("WARNING: could not set Nearest filtering — VAT will look broken."); }
        try { texParam.wrapModeU = "Repeat"; } catch (_) {}
        try { texParam.wrapModeV = "Repeat"; } catch (_) {}
        try { texParam.mipmaps = false; } catch (_) {}

        try { pass.positionMap = texParam; } catch (e) { this.log("set positionMap failed: " + e.message); }
        try { pass.numFrames = anim.numFrames; } catch (_) {}
        try { pass.speed = anim.speed; } catch (_) {}
        try { pass.bbox = new vec2(anim.bboxMax, -anim.bboxMax); }
        catch (_) {
            try { pass.bbox = { x: anim.bboxMax, y: -anim.bboxMax }; } catch (_) {}
        }
    }

    _spawnPrefab(meshImportResult, base) {
        let rootObj = null;

        // Primary asset is usually the ObjectPrefab.
        if (meshImportResult && meshImportResult.primary) {
            try { rootObj = this.scene.instantiatePrefab(meshImportResult.primary, null); }
            catch (_) {}
        }
        // Fallback: iterate sibling assets for the first prefab/mesh.
        if (!rootObj && meshImportResult && meshImportResult.assets) {
            for (const asset of meshImportResult.assets) {
                const typeName = String(asset.type || "");
                if (typeName === "ObjectPrefab" || typeName.includes("Prefab")) {
                    try {
                        rootObj = this.scene.instantiatePrefab(asset, null);
                        if (rootObj) break;
                    } catch (_) {}
                }
            }
        }
        if (!rootObj) {
            this.log("Could not instantiate prefab — creating empty object as fallback.");
            rootObj = this.scene.addSceneObject(null);
        }
        rootObj.name = base + "_VAT";
        return rootObj;
    }

    _applyMaterialRecursive(sceneObject, material) {
        if (!sceneObject) return;
        try {
            const components = sceneObject.components || [];
            for (const comp of components) {
                const typeName = comp.getTypeName();
                if (typeName === "RenderMeshVisual" ||
                    typeName === "MaterialMeshVisual" ||
                    typeName === "MeshVisual" ||
                    typeName === "BaseMeshVisual") {
                    try { comp.materials = [material]; }
                    catch (_) { try { comp.mainMaterial = material; } catch (_) {} }
                }
            }
        } catch (_) {}
        try {
            const children = sceneObject.children || [];
            for (const child of children) this._applyMaterialRecursive(child, material);
        } catch (_) {}
    }

    _attachController(rootObj, controllerAsset, material, selected, textures) {
        const sc = rootObj.addComponent("ScriptComponent");
        sc.scriptAsset = controllerAsset;
        return this._populateController(sc, material, selected, textures);
    }

    _populateController(sc, material, selected, textures) {
        // @input fields populated by name. Names MUST match VATAnimationController.ts.
        // Verbose-log every set so we can see exactly what stuck.
        const set = (key, value) => {
            try {
                sc[key] = value;
                const after = sc[key];
                const readBack = Array.isArray(after) ? `[${after.length}]` : String(after);
                this.log(`  set ${key} = ${JSON.stringify(value)} -> read=${readBack}`);
            } catch (e) {
                this.log(`  set ${key} FAILED: ${e.message}`);
            }
        };

        // Explicit Number() coercion in case LS rejects mixed/inferred types.
        set("material", material);
        set("animationNames", selected.map(a => String(a.name)));
        set("positionMaps", textures);
        set("numFramesArr", selected.map(a => Number(a.numFrames)));
        set("bboxMaxArr", selected.map(a => Number(a.bboxMax)));
        set("speedArr", selected.map(a => Number(a.speed)));
        set("defaultIndex", 0);
        set("autoPlayOnStart", true);
    }

    /** Search the scene for a SceneObject named `${base}_VAT`.
     *  Uses `scene.sceneObjects` (flat recursive list) — the API exposed
     *  by all official plugin samples. */
    _findExistingVATObject(base) {
        const targetName = `${base}_VAT`;
        try {
            const all = this.scene.sceneObjects || [];
            for (let i = 0; i < all.length; i++) {
                if (all[i] && all[i].name === targetName) return all[i];
            }
        } catch (e) {
            this.log(`scene.sceneObjects unavailable: ${e.message}`);
        }
        // Fallback: walk rootSceneObjects + .children if the flat list is missing.
        try {
            const visit = (o) => {
                if (!o) return null;
                if (o.name === targetName) return o;
                const ch = o.children || [];
                for (const c of ch) {
                    const f = visit(c);
                    if (f) return f;
                }
                return null;
            };
            const roots = this.scene.rootSceneObjects || [];
            for (const r of roots) {
                const f = visit(r);
                if (f) return f;
            }
        } catch (_) {}
        return null;
    }

    /** Returns the first ScriptComponent on `obj` whose asset name suggests
     *  it's our VATAnimationController. Null if none. */
    _findControllerComponent(obj) {
        if (!obj) return null;
        try {
            const components = obj.components || [];
            for (const c of components) {
                if (c.getTypeName() !== "ScriptComponent") continue;
                const asset = c.scriptAsset;
                const name = String((asset && asset.name) || "");
                if (name.indexOf("VATAnimationController") >= 0) return c;
            }
        } catch (_) {}
        return null;
    }

    async _askSceneObjectAction(existingName) {
        // Modal with three choices. Returns "update" | "replace" | "skip".
        return await new Promise(resolve => {
            const dialog = this.gui.dialogs.createDialog();
            dialog.windowTitle = "VAT Import — Scene Object Exists";
            dialog.resize(520, 240);
            dialog.setModal(true);

            const layout = new Ui.BoxLayout();
            layout.setDirection(Ui.Direction.TopToBottom);

            const title = new Ui.Label(dialog);
            title.text = "Scene object already exists";
            try { title.foregroundRole = Ui.ColorRole.BrightText; } catch (_) {}
            layout.addWidget(title);

            const body = new Ui.Label(dialog);
            body.text =
                `Scene contains "${existingName}".\n\n` +
                `Update existing controller — refresh its animation list and material on the same object.\n` +
                `Replace object — delete the old and spawn a fresh one.\n` +
                `Skip — leave the scene alone (only refresh imported assets).`;
            layout.addWidget(body);

            const btnRow = new Ui.BoxLayout();
            btnRow.setDirection(Ui.Direction.LeftToRight);
            const finish = (choice) => { resolve(choice); try { dialog.close(); } catch (_) {} };

            const updBtn = new Ui.PushButton(dialog);
            updBtn.text = "Update existing";
            updBtn.primary = true;
            updBtn.onClick.connect(() => finish("update"));
            btnRow.addWidget(updBtn);

            const repBtn = new Ui.PushButton(dialog);
            repBtn.text = "Replace object";
            repBtn.onClick.connect(() => finish("replace"));
            btnRow.addWidget(repBtn);

            const skipBtn = new Ui.PushButton(dialog);
            skipBtn.text = "Skip";
            skipBtn.onClick.connect(() => finish("skip"));
            btnRow.addWidget(skipBtn);

            layout.addLayout(btnRow);
            layout.setContentsMargins(
                Ui.Sizes.DialogContentMargin, Ui.Sizes.DialogContentMargin,
                Ui.Sizes.DialogContentMargin, Ui.Sizes.DialogContentMargin
            );
            layout.spacing = Ui.Sizes.Padding;
            dialog.layout = layout;

            dialog.onClose.connect(() => resolve("skip"));
            dialog.show();
        });
    }

    log(msg) { console.log("[SimpleVAT] " + msg); }
}
