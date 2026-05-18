import bpy


def _slot_enum_items(self, context):
    """Build the slot dropdown options dynamically for this action."""
    items = []
    action = self.action
    if not action:
        return [("NONE", "—", "")]
    slots = getattr(action, "slots", None)
    if not slots:
        # Legacy action (pre-4.4) — no slots at all.
        return [("LEGACY", "(legacy action)", "")]
    for slot in slots:
        sid = getattr(slot, "identifier", "") or ""
        if not sid:
            continue
        # Strip the "XX|TargetName|" prefix for a readable label.
        label = sid.split("|")[-1] if "|" in sid else sid
        items.append((sid, label, ""))
    if not items:
        items = [("EMPTY", "(no slots)", "")]
    return items


class VATActionEntry(bpy.types.PropertyGroup):
    name: bpy.props.StringProperty(name="Display Name")
    enabled: bpy.props.BoolProperty(name="Export", default=True)
    action: bpy.props.PointerProperty(name="Action", type=bpy.types.Action)
    # User-chosen slot for 4.4+ slotted actions. Dynamic enum; "LEGACY" for old
    # actions with no slot system at all.
    slot_enum: bpy.props.EnumProperty(
        name="Slot",
        description="Which slot inside the action drives the armature",
        items=_slot_enum_items,
    )


class VATSettings(bpy.types.PropertyGroup):
    vat_output_directory: bpy.props.StringProperty(
        name="Output Directory",
        description="Folder to write VAT textures, FBX and JSON metadata",
        subtype='DIR_PATH',
        default="",
    )

    show_encoding_info: bpy.props.BoolProperty(
        name="Encoding Details",
        default=False,
    )


classes = [VATActionEntry, VATSettings]
