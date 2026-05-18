bl_info = {
    "name": "VAT Pipeline — Lens Studio Exporter",
    "version": (2, 0, 0),
    "blender": (4, 2, 0),
    "description": "Export Vertex Animation Textures to Snap Lens Studio",
    "author": "Pavlo Tkachenko & Stijn Spanhove — https://pavlo-stijn.dev",
    "category": "Export",
    "doc_url": "https://github.com/PtPavloTkachenko/LensStudio-SimpleVAT",
}

import bpy

from . import props, operators, panels

classes = []
classes.extend(props.classes)
classes.extend(operators.classes)
classes.extend(panels.classes)


def register():
    for cls in classes:
        bpy.utils.register_class(cls)
    bpy.types.Scene.vat_settings = bpy.props.PointerProperty(type=props.VATSettings)
    bpy.types.Scene.vat_action_list = bpy.props.CollectionProperty(type=props.VATActionEntry)


def unregister():
    for cls in reversed(classes):
        bpy.utils.unregister_class(cls)
    del bpy.types.Scene.vat_settings
    del bpy.types.Scene.vat_action_list


if __name__ == "__main__":
    register()
