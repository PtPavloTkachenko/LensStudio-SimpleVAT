import bpy
import os


class OBJECT_PT_VAT_PIPELINE(bpy.types.Panel):
    bl_idname = "OBJECT_PT_vat_pipeline"
    bl_label = "VAT Pipeline — Lens Studio"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'VAT'

    def draw(self, context):
        layout = self.layout
        obj = context.object
        scene = context.scene
        settings = scene.vat_settings
        abs_path = bpy.path.abspath(settings.vat_output_directory)

        # Output folder
        box = layout.box()
        box.label(text="Output", icon='FILE_FOLDER')
        box.prop(settings, "vat_output_directory", text="")

        # Validation
        if not obj or obj.type != 'MESH' or len(obj.data.polygons) == 0:
            layout.label(text="Select a mesh object", icon='ERROR')
            return

        # Action list
        box = layout.box()
        row = box.row(align=True)
        row.label(text="Actions to Bake", icon='ACTION')
        row.operator("vat.refresh_actions", text="", icon='FILE_REFRESH')

        action_list = scene.vat_action_list
        if len(action_list) == 0:
            box.label(text="No actions — Refresh or use Timeline", icon='INFO')
        else:
            for item in action_list:
                row = box.row(align=True)
                row.prop(item, "enabled", text="")
                # Action name takes flexible width on the left.
                row.label(text=item.name)
                # Slot dropdown — visible only if the action has slots.
                if item.action and getattr(item.action, "slots", None):
                    row.prop(item, "slot_enum", text="")
                # Frame range on the right.
                if item.action:
                    fr = item.action.frame_range
                    row.label(text=f"{int(fr[0])}-{int(fr[1])}")

        # Bake button
        enabled_count = sum(1 for item in action_list if item.enabled)
        timeline_frames = scene.frame_end - scene.frame_start + 1

        row = layout.row()
        row.scale_y = 1.6
        if not os.path.isdir(abs_path):
            row.enabled = False
            row.label(text="Set output directory", icon='WARNING_LARGE')
        else:
            if enabled_count > 0:
                label = f"Bake {enabled_count} Action(s)"
            else:
                label = f"Bake Timeline ({timeline_frames} frames)"
            row.operator("vat.bake", text=label, icon='EXPORT')

        # Encoding info (collapsible)
        box = layout.box()
        row = box.row()
        row.prop(settings, "show_encoding_info", icon="INFO_LARGE", emboss=False)
        if settings.show_encoding_info:
            num_verts = len(obj.data.vertices)
            if enabled_count > 0:
                max_frames = max(
                    (int(item.action.frame_range[1]) - int(item.action.frame_range[0]) + 1
                     for item in action_list if item.enabled and item.action),
                    default=0,
                )
                row_count = enabled_count
            else:
                max_frames = timeline_frames
                row_count = 1

            box.label(text=f"Target: {obj.name}", icon='MESH_DATA')
            box.label(text=f"Vertices: {num_verts}", icon='VERTEXSEL')
            box.label(text=f"Max texture: {num_verts} x {max_frames}", icon='IMAGE_DATA')
            box.label(text=f"Animations to bake: {row_count}", icon='ACTION')

        # Open output folder
        if os.path.isdir(abs_path):
            layout.operator("vat.open_output_directory", text="Open Output Folder", icon='FILE_FOLDER')

        # Credits
        box = layout.box()
        box.label(text="Based on OpenVAT by Luke Stilson")
        box.label(text="Reworked by Pavlo Tkachenko")


classes = [OBJECT_PT_VAT_PIPELINE]
