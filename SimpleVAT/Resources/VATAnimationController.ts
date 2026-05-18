// Standalone logger — no SIK / external package dependency so the controller
// drops cleanly into any Lens Studio project.
const TAG = "VATAnimationController";
const log = {
    d: (m: string) => print(`[${TAG}] ${m}`),
    w: (m: string) => print(`[${TAG}][WARN] ${m}`),
    e: (m: string) => print(`[${TAG}][ERROR] ${m}`),
};

/**
 * VATAnimationController
 *
 * Owns a list of vertex-animation tracks imported by the SimpleVAT plugin
 * and switches between them at runtime by writing new values into the
 * material's shader parameters (positionMap, numFrames, bbox, speed).
 *
 * The plugin populates the @input arrays at import time; everything below
 * them is the public, agent-facing API.
 *
 * Usage from another script:
 *
 *     @input vatController: VATAnimationController
 *
 *     // ...
 *     this.vatController.play("Run");
 *     this.vatController.setTimeOffset(0.25);
 *     const names = this.vatController.getAnimations();
 *
 * Authors:  Pavlo Tkachenko & Stijn Spanhove
 * Portfolio: https://pavlo-stijn.dev
 * Repo:      https://github.com/PtPavloTkachenko/LensStudio-SimpleVAT
 */
@component
export class VATAnimationController extends BaseScriptComponent {
    // ---------- Inputs (populated by the importer plugin) ----------

    @input material: Material;
    @input animationNames: string[] = [];
    @input positionMaps: Texture[] = [];
    @input numFramesArr: number[] = [];
    @input bboxMaxArr: number[] = [];
    @input speedArr: number[] = [];

    @input
    @hint("Index of the animation to apply on Awake (0 = first).")
    defaultIndex: number = 0;

    @input autoPlayOnStart: boolean = true;

    // ---------- Internal state ----------

    private _currentIndex: number = -1;

    onAwake() {
        if (!this.material) {
            log.e("No material assigned — animation switching will not work.");
            return;
        }
        if (this.animationNames.length === 0) {
            log.w("No animations populated. Importer should fill these.");
            return;
        }
        if (this.autoPlayOnStart) {
            this.playIndex(this.defaultIndex);
        }
    }

    // ---------- Public API ----------

    /**
     * Switch to the animation with the given name. Returns true on success.
     * Case-sensitive. Use {@link getAnimations} to discover valid names.
     */
    play(name: string): boolean {
        const idx = this.animationNames.indexOf(name);
        if (idx < 0) {
            log.w(`play("${name}"): not in list. Available: ${this.animationNames.join(", ")}`);
            return false;
        }
        return this.playIndex(idx);
    }

    /**
     * Switch to the animation at this index. Returns true on success.
     */
    playIndex(index: number): boolean {
        if (index < 0 || index >= this.animationNames.length) {
            log.w(`playIndex(${index}): out of range (0..${this.animationNames.length - 1}).`);
            return false;
        }
        if (index === this._currentIndex) return true;

        const pass: any = this.material.mainPass;
        const bboxMax = this.bboxMaxArr[index];
        try {
            pass.positionMap = this.positionMaps[index];
            pass.numFrames = this.numFramesArr[index];
            pass.speed = this.speedArr[index];
            pass.bbox = new vec2(bboxMax, -bboxMax);
        } catch (e) {
            log.e(`Failed to write material params for "${this.animationNames[index]}": ${e}`);
            return false;
        }

        this._currentIndex = index;
        log.d(`Playing "${this.animationNames[index]}" (${this.numFramesArr[index]}f, ±${bboxMax})`);
        return true;
    }

    /**
     * Per-instance phase offset in seconds. Useful when several objects share
     * the same animation — give each a different offset so they don't tick in
     * lockstep. Has no effect on which animation is playing.
     */
    setTimeOffset(seconds: number): void {
        try { (this.material.mainPass as any).TimeOffset = seconds; }
        catch (e) { log.w(`setTimeOffset failed: ${e}`); }
    }

    /**
     * Multiplier on top of the animation's authored speed (from the bake).
     * Resets to authored speed when you switch animations via play/playIndex.
     */
    setSpeed(speed: number): void {
        try { (this.material.mainPass as any).speed = speed; }
        catch (e) { log.w(`setSpeed failed: ${e}`); }
    }

    /** Names of every animation the importer attached, in order. */
    getAnimations(): string[] {
        return this.animationNames.slice();
    }

    /** Name of the currently-playing animation, or empty string if none. */
    current(): string {
        return this._currentIndex >= 0 ? this.animationNames[this._currentIndex] : "";
    }

    /** Index of the currently-playing animation, or -1 if none. */
    currentIndex(): number {
        return this._currentIndex;
    }
}
