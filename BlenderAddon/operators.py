import bpy
import bmesh
import os
import math
import json
import subprocess
from mathutils import Vector


TAG = "[VAT]"

# Spectacles texture limit. Anything above this gets silently downscaled
# by Lens Studio, which corrupts the per-pixel VAT encoding and produces
# garbage animation. We refuse to bake instead.
MAX_TEX_DIM = 2048


# ---------- helpers ----------

def _find_armature(obj):
    for mod in obj.modifiers:
        if mod.type == 'ARMATURE' and mod.object:
            return mod.object
    return None


def _iter_action_fcurves(action):
    """Yield all fcurves in an action — works for both legacy (pre-4.4)
    and slotted (4.4+) action structures. For slotted actions also yields
    the (slot, fcurve) pair via fc._slot attribute we tack on."""
    legacy = getattr(action, 'fcurves', None)
    if legacy is not None:
        try:
            for fc in legacy:
                yield None, fc
            return
        except (AttributeError, TypeError):
            pass
    layers = getattr(action, 'layers', None)
    if not layers:
        return
    for layer in layers:
        for strip in getattr(layer, 'strips', ()) or ():
            channelbags = getattr(strip, 'channelbags', None)
            if not channelbags:
                continue
            for cb in channelbags:
                # In 4.4+ each channelbag is tied to a slot.
                slot = getattr(cb, 'slot', None)
                for fc in getattr(cb, 'fcurves', ()) or ():
                    yield slot, fc


def _action_has_bone_curves(action):
    """True if the action drives any `pose.bones.*` channel."""
    try:
        for _slot, fc in _iter_action_fcurves(action):
            if fc.data_path.startswith('pose.bones'):
                return True
        return False
    except Exception:
        return True  # be permissive if we can't introspect


def _slot_frame_range(action, slot):
    """Return (start, end) frame range computed from THIS slot's actual
    keyframes, ignoring other slots in the same action. Falls back to
    `action.frame_range` for legacy (slot-less) actions."""
    if slot is None:
        return (int(action.frame_range[0]), int(action.frame_range[1]))

    f_min = float('inf')
    f_max = float('-inf')
    try:
        for layer in (getattr(action, 'layers', None) or []):
            for strip in (getattr(layer, 'strips', None) or []):
                cb = None
                # Try .channelbag(slot) (method form) first.
                try:
                    cb = strip.channelbag(slot)
                except Exception:
                    pass
                if cb is None:
                    # Walk channelbags list and match by slot.
                    for c in (getattr(strip, 'channelbags', None) or []):
                        if getattr(c, 'slot', None) is slot:
                            cb = c
                            break
                if not cb:
                    continue
                for fc in (getattr(cb, 'fcurves', None) or []):
                    for kp in fc.keyframe_points:
                        f = kp.co[0]
                        if f < f_min:
                            f_min = f
                        if f > f_max:
                            f_max = f
    except Exception:
        pass

    if f_min == float('inf'):
        # No keyframes found on this slot — fall back.
        return (int(action.frame_range[0]), int(action.frame_range[1]))
    return (int(f_min), int(f_max))


def _find_armature_slot(action, armature_name=None):
    """For 4.4+ slotted actions: choose the slot that should drive an armature.
    Priority: (1) slot identifier contains the armature name, (2) slot has
    pose.bones fcurves AND target_id_type=='OBJECT', (3) any slot with
    pose.bones fcurves. Returns None for legacy actions or if no fit."""
    if getattr(action, 'fcurves', None) is not None:
        return None  # legacy

    bone_slots = {}  # slot -> list[fcurve]
    try:
        for slot, fc in _iter_action_fcurves(action):
            if slot is None:
                continue
            if fc.data_path.startswith('pose.bones'):
                bone_slots.setdefault(slot, []).append(fc)
    except Exception:
        return None

    if not bone_slots:
        return None

    # 1. Name match — most reliable when user explicitly picked the slot.
    if armature_name:
        for slot in bone_slots:
            ident = getattr(slot, 'identifier', '') or ''
            if armature_name in ident:
                return slot

    # 2. OBJECT-type slot (typical for armature object animation).
    for slot in bone_slots:
        if getattr(slot, 'target_id_type', None) == 'OBJECT':
            return slot

    # 3. First slot with bone curves.
    return next(iter(bone_slots))


def _read_mesh_positions(obj, context):
    depsgraph = context.evaluated_depsgraph_get()
    obj_eval = obj.evaluated_get(depsgraph)
    mesh_eval = obj_eval.to_mesh()
    positions = [Vector(v.co) for v in mesh_eval.vertices]
    obj_eval.to_mesh_clear()
    return positions


def _capture_rest_positions(obj, scene, context):
    """Read true rest pose: temporarily put armature in REST + zero out all
    shape keys, sample positions, then restore original state before returning.
    The pose/shape-key state is restored INSIDE this function — the caller
    must not rely on it staying in REST."""
    armature_obj = _find_armature(obj)
    old_pose = None
    if armature_obj:
        old_pose = armature_obj.data.pose_position
        armature_obj.data.pose_position = 'REST'

    old_shape_key_values = []
    if obj.data.shape_keys:
        for kb in obj.data.shape_keys.key_blocks:
            old_shape_key_values.append((kb, kb.value))
            kb.value = 0.0

    scene.frame_set(scene.frame_start)
    bpy.context.view_layer.update()

    try:
        rest_positions = _read_mesh_positions(obj, context)
    finally:
        for kb, val in old_shape_key_values:
            kb.value = val
        if armature_obj and old_pose:
            armature_obj.data.pose_position = old_pose
        bpy.context.view_layer.update()

    return rest_positions, len(rest_positions), armature_obj


def _collect_offsets(obj, context, scene, frame_start, frame_end, rest_positions):
    """Per-frame vertex offsets from rest. Returns list[list[Vector]]."""
    num_verts = len(rest_positions)
    all_offsets = []
    for frame in range(frame_start, frame_end + 1):
        scene.frame_set(frame)
        positions = _read_mesh_positions(obj, context)
        if len(positions) != num_verts:
            raise RuntimeError(
                f"Frame {frame} vertex count {len(positions)} != rest {num_verts}. "
                "Topology must remain constant across frames."
            )
        all_offsets.append([positions[i] - rest_positions[i] for i in range(num_verts)])
    return all_offsets


def _compute_sym_bbox(all_offsets):
    """Symmetric BBOX: largest absolute component across all frames, rounded up to 0.1."""
    global_max = 0.0
    for frame_offsets in all_offsets:
        for o in frame_offsets:
            global_max = max(global_max, abs(o.x), abs(o.y), abs(o.z))
    sym = math.ceil(global_max * 10) / 10
    return sym if sym > 0 else 0.1


def _write_position_png(img_name, png_path, all_offsets, sym, num_verts, num_frames):
    width = num_verts
    height = num_frames

    if img_name in bpy.data.images:
        bpy.data.images.remove(bpy.data.images[img_name])

    img = bpy.data.images.new(img_name, width=width, height=height, alpha=True)
    img.colorspace_settings.name = 'Non-Color'
    pixels = [0.0] * (width * height * 4)

    for frame_idx, frame_offsets in enumerate(all_offsets):
        y = height - 1 - frame_idx  # frame 0 = top row
        for vert_idx, offset in enumerate(frame_offsets):
            r = max(0.0, min(1.0, (offset.x + sym) / (2.0 * sym)))
            g = max(0.0, min(1.0, (offset.y + sym) / (2.0 * sym)))
            b = max(0.0, min(1.0, (offset.z + sym) / (2.0 * sym)))
            pi = (y * width + vert_idx) * 4
            pixels[pi] = r
            pixels[pi + 1] = g
            pixels[pi + 2] = b
            pixels[pi + 3] = 1.0

    img.pixels.foreach_set(pixels)
    img.filepath_raw = png_path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def _export_rest_fbx(obj, context, scene, output_dir, fbx_name, num_verts):
    """Export rest-pose mesh as FBX with VAT_UV layer for shader sampling."""
    armature_obj = _find_armature(obj)
    if armature_obj:
        old_pose = armature_obj.data.pose_position
        armature_obj.data.pose_position = 'REST'

    old_shape_key_values = []
    if obj.data.shape_keys:
        for kb in obj.data.shape_keys.key_blocks:
            old_shape_key_values.append((kb, kb.value))
            kb.value = 0.0

    scene.frame_set(scene.frame_start)
    bpy.context.view_layer.update()
    depsgraph = context.evaluated_depsgraph_get()
    obj_eval = obj.evaluated_get(depsgraph)
    rest_mesh = bpy.data.meshes.new_from_object(obj_eval)
    rest_obj = bpy.data.objects.new(fbx_name, rest_mesh)
    scene.collection.objects.link(rest_obj)

    bm = bmesh.new()
    bm.from_mesh(rest_mesh)
    if len(bm.loops.layers.uv) == 0:
        bm.loops.layers.uv.new("UVMap")
    vat_uv = bm.loops.layers.uv.new("VAT_UV")
    pixel_size_x = 1.0 / num_verts
    for vert in bm.verts:
        i = vert.index
        uv_x = i / num_verts + pixel_size_x / 2
        for loop in vert.link_loops:
            loop[vat_uv].uv = (uv_x, 0.975)
    bm.to_mesh(rest_mesh)
    bm.free()

    bpy.ops.object.select_all(action='DESELECT')
    rest_obj.select_set(True)
    context.view_layer.objects.active = rest_obj

    fbx_path = os.path.join(output_dir, f"{fbx_name}.fbx")
    bpy.ops.export_scene.fbx(
        filepath=fbx_path,
        use_selection=True,
        object_types={'MESH'},
        use_mesh_modifiers=False,
        mesh_smooth_type='OFF',
        use_tspace=True,
        add_leaf_bones=False,
        bake_anim=False,
        bake_space_transform=False,
        # Embed referenced textures (base color etc.) so LS imports them
        # with the FBX instead of getting bare materials.
        path_mode='COPY',
        embed_textures=True,
    )

    bpy.data.objects.remove(rest_obj)
    bpy.data.meshes.remove(rest_mesh)

    for kb, val in old_shape_key_values:
        kb.value = val
    if armature_obj:
        armature_obj.data.pose_position = old_pose

    return fbx_path


def _write_anim_metadata(output_dir, base, action_name, sym, num_frames, frame_range):
    """Per-animation JSON next to the PNG. Self-contained — copy the PNG+JSON
    pair to another folder and it's still importable."""
    path = os.path.join(output_dir, f"{base}_{action_name}.json")
    with open(path, 'w') as f:
        json.dump({
            "name": action_name,
            "mesh": f"{base}.fbx",
            "position_map": f"{base}_{action_name}_vat.png",
            "num_frames": num_frames,
            "bbox_max": sym,
            "bbox_min": -sym,
            "speed": 1.0,
            "frame_range": f"{int(frame_range[0])}-{int(frame_range[1])}",
        }, f, indent=4)


# ---------- operators ----------

class OBJECT_OT_OpenOutputDirectory(bpy.types.Operator):
    bl_idname = "vat.open_output_directory"
    bl_label = "Open Output Directory"

    def execute(self, context):
        output_dir = bpy.path.abspath(context.scene.vat_settings.vat_output_directory)
        if not os.path.isdir(output_dir):
            self.report({'ERROR'}, "Directory does not exist")
            return {'CANCELLED'}
        if os.name == 'nt':
            os.startfile(output_dir)
        elif os.uname().sysname == 'Darwin':
            subprocess.Popen(['open', output_dir])
        else:
            subprocess.Popen(['xdg-open', output_dir])
        return {'FINISHED'}


class OBJECT_OT_RefreshVATActions(bpy.types.Operator):
    bl_idname = "vat.refresh_actions"
    bl_label = "Refresh Actions"
    bl_description = "Scan all Actions in the .blend file. Each action becomes one row with a slot dropdown."

    def execute(self, context):
        scene = context.scene
        action_list = scene.vat_action_list
        action_list.clear()

        for action in bpy.data.actions:
            if action.users == 0:
                continue
            item = action_list.add()
            item.name = action.name
            item.action = action
            item.enabled = True
            # Pre-select the most likely bone slot so the user doesn't have to
            # click the dropdown for the common case.
            bone_slot = _find_armature_slot(action)
            if bone_slot is not None:
                try:
                    item.slot_enum = getattr(bone_slot, "identifier", "")
                except Exception:
                    pass

        self.report({'INFO'}, f"Found {len(action_list)} action(s)")
        return {'FINISHED'}


class OBJECT_OT_VATBake(bpy.types.Operator):
    bl_idname = "vat.bake"
    bl_label = "Bake VAT"
    bl_description = (
        "Bake selected actions as VAT textures (one per action). "
        "If no actions are enabled, bakes the scene timeline (NLA/sim/shape keys)"
    )

    def execute(self, context):
        obj = context.active_object
        if not obj or obj.type != 'MESH':
            self.report({'ERROR'}, "Select a mesh object")
            return {'CANCELLED'}

        settings = context.scene.vat_settings
        output_dir = bpy.path.abspath(settings.vat_output_directory)
        if not output_dir or not os.path.isdir(output_dir):
            self.report({'ERROR'}, "Set a valid output directory first")
            return {'CANCELLED'}

        scene = context.scene
        base = obj.name

        # If the active object has no armature, force timeline mode regardless
        # of action-list ticks. This is the path that handles cloth / soft body /
        # shape-key / NLA / sim bakes — there are no bones to drive, so the
        # animation comes from the scene's evaluated state per frame.
        active_has_armature = _find_armature(obj) is not None

        def _row_to_entry(item):
            sid = item.slot_enum or ""
            if sid in ("LEGACY", "EMPTY", "NONE"):
                sid = ""
            return (item.action, sid, item.action.name)
        bake_entries = (
            [_row_to_entry(item)
             for item in scene.vat_action_list
             if item.enabled and item.action]
            if active_has_armature else []
        )
        timeline_mode = len(bake_entries) == 0

        if not active_has_armature and any(item.enabled for item in scene.vat_action_list):
            print(f"{TAG} Active object has no armature — ignoring ticked actions, using timeline mode.")

        print(f"\n{TAG} Bake start — base='{base}', mode={'timeline' if timeline_mode else f'actions ({len(bake_entries)})'}")

        rest_positions, num_verts, armature_obj = _capture_rest_positions(
            obj, scene, context
        )
        print(f"{TAG} Rest pose captured: {num_verts} verts")

        # Hard stop if mesh exceeds the Spectacles texture limit.
        if num_verts > MAX_TEX_DIM:
            msg = (f"Mesh has {num_verts} vertices, max for VAT is {MAX_TEX_DIM}. "
                   f"Decimate the mesh or split it before baking.")
            self.report({'ERROR'}, msg)
            print(f"{TAG} ABORT: {msg}")
            return {'CANCELLED'}

        object_dir = os.path.join(output_dir, f"{base}_vat")
        os.makedirs(object_dir, exist_ok=True)

        # Shared FBX (rest pose) — exported once.
        _export_rest_fbx(obj, context, scene, object_dir, base, num_verts)
        print(f"{TAG} FBX exported: {base}.fbx")

        baked_count = 0

        original_action = None
        if armature_obj and armature_obj.animation_data:
            original_action = armature_obj.animation_data.action

        try:
            if timeline_mode:
                fr_start = scene.frame_start
                fr_end = scene.frame_end
                num_frames = fr_end - fr_start + 1
                action_name = base  # fallback name = object name

                if num_frames > MAX_TEX_DIM:
                    self.report({'ERROR'},
                                f"Timeline is {num_frames} frames, max for VAT is {MAX_TEX_DIM}. "
                                f"Shorten the scene range or split the bake.")
                    return {'CANCELLED'}

                offsets = _collect_offsets(obj, context, scene, fr_start, fr_end, rest_positions)
                sym = _compute_sym_bbox(offsets)
                png_path = os.path.join(object_dir, f"{base}_{action_name}_vat.png")
                _write_position_png(f"{base}_{action_name}_vat", png_path, offsets, sym, num_verts, num_frames)
                _write_anim_metadata(object_dir, base, action_name, sym, num_frames, (fr_start, fr_end))
                baked_count += 1
                print(f"{TAG}   '{action_name}': {num_frames} frames, BBOX +/-{sym}")
            else:
                if not armature_obj:
                    self.report({'ERROR'}, "Action mode requires an armature on the active object")
                    return {'CANCELLED'}
                if not armature_obj.animation_data:
                    armature_obj.animation_data_create()

                # Mute NLA so only the chosen action drives the rig.
                muted_tracks = []
                for track in armature_obj.animation_data.nla_tracks:
                    muted_tracks.append((track, track.mute))
                    track.mute = True

                try:
                    for action, slot_identifier, export_name in bake_entries:
                        action_name = export_name

                        # Sanity: is this an armature action? Material/object actions
                        # produce no bone deformation and would bake a frozen pose.
                        if not _action_has_bone_curves(action):
                            print(f"{TAG}   SKIP '{action_name}': no pose.bones channels "
                                  f"(likely a material/object/shape-key action)")
                            continue

                        # Defensive: re-mute NLA each iteration in case something un-muted them.
                        for track in armature_obj.animation_data.nla_tracks:
                            track.mute = True

                        armature_obj.animation_data.action = action
                        armature_obj.animation_data.action_blend_type = 'REPLACE'

                        # Bind the SPECIFIC slot the user picked in the UI.
                        # Fallback: auto-detect a bone slot if no identifier or
                        # the named one isn't found.
                        bone_slot = None
                        if slot_identifier:
                            try:
                                for s in (getattr(action, 'slots', None) or []):
                                    if getattr(s, 'identifier', '') == slot_identifier:
                                        bone_slot = s
                                        break
                            except Exception:
                                pass
                            if bone_slot is None:
                                print(f"{TAG}   slot '{slot_identifier}' not found, auto-detecting")
                        if bone_slot is None:
                            bone_slot = _find_armature_slot(action, armature_obj.name)

                        bound_slot_name = None
                        if bone_slot is not None:
                            try:
                                armature_obj.animation_data.action_slot = bone_slot
                                bound_slot_name = getattr(bone_slot, 'identifier', '?')
                            except Exception as e:
                                print(f"{TAG}   could not bind slot: {e}")

                        # Frame range comes from the SLOT, not from action.frame_range
                        # — the latter is the union of all slots in 4.4+ and would
                        # include keyframes that don't belong to this animation.
                        fr_start, fr_end = _slot_frame_range(action, bone_slot)
                        num_frames = fr_end - fr_start + 1

                        # Spectacles texture-size guard on the per-action axis too.
                        if num_frames > MAX_TEX_DIM:
                            print(f"{TAG}   ABORT '{action_name}': {num_frames} frames > "
                                  f"{MAX_TEX_DIM} max. Trim the action or split it.")
                            continue

                        # Frame "bounce" — depsgraph sometimes refuses to re-evaluate
                        # an action change unless the scene frame ACTUALLY changes.
                        # Jump to a different frame then back to force a clean re-eval.
                        bounce_frame = fr_start + 1 if fr_end > fr_start else fr_start - 1
                        scene.frame_set(bounce_frame)
                        bpy.context.view_layer.update()
                        scene.frame_set(fr_start)
                        bpy.context.view_layer.update()
                        context.evaluated_depsgraph_get().update()

                        # Verify the action stuck and the armature actually moved between
                        # rest and the first frame of THIS action.
                        active = armature_obj.animation_data.action
                        active_slot = getattr(armature_obj.animation_data, 'action_slot', None)
                        active_slot_name = getattr(active_slot, 'identifier', None) if active_slot else None
                        f0_positions = _read_mesh_positions(obj, context)
                        delta_f0 = max((p - rest_positions[i]).length
                                       for i, p in enumerate(f0_positions))
                        print(f"{TAG}   diag '{action_name}': "
                              f"action={active.name if active else None}, "
                              f"slot={active_slot_name}, "
                              f"frame0 delta = {delta_f0:.4f}")

                        offsets = _collect_offsets(obj, context, scene, fr_start, fr_end, rest_positions)
                        sym = _compute_sym_bbox(offsets)

                        png_path = os.path.join(object_dir, f"{base}_{action_name}_vat.png")
                        _write_position_png(f"{base}_{action_name}_vat", png_path, offsets, sym, num_verts, num_frames)
                        _write_anim_metadata(object_dir, base, action_name, sym, num_frames, (fr_start, fr_end))
                        baked_count += 1
                        print(f"{TAG}   '{action_name}': {num_frames} frames, BBOX +/-{sym}")
                finally:
                    for track, was_muted in muted_tracks:
                        track.mute = was_muted
        finally:
            if armature_obj and original_action is not None:
                armature_obj.animation_data.action = original_action
            scene.frame_set(scene.frame_start)

        self.report({'INFO'}, f"Baked {baked_count} animation(s) -> {object_dir}")
        print(f"{TAG} Done.\n")
        return {'FINISHED'}


classes = [
    OBJECT_OT_OpenOutputDirectory,
    OBJECT_OT_RefreshVATActions,
    OBJECT_OT_VATBake,
]
