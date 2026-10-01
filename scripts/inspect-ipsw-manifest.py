"""Read only: retain identity boundaries; never guess the largest/first OS image.

plistlib is used because BuildManifest contains Data values that plutil cannot
convert to JSON. No firmware keys or unrelated manifest data are emitted.
"""
import hashlib
import json
import pathlib
import plistlib
import re
import sys


def inspect(data):
    manifest = plistlib.loads(data)
    identities = []
    for index, identity in enumerate(manifest["BuildIdentities"]):
        info = identity["Info"]
        images = {}
        for name, component in identity["Manifest"].items():
            path = component.get("Info", {}).get("Path", "")
            if re.search(r"\.dmg(?:\.aea)?$", path):
                images[name] = path
        identities.append({
            "index": index,
            "product": identity.get("Ap,ProductType"),
            "board": info.get("DeviceClass"),
            "variant": info.get("Variant"),
            "restoreBehavior": info.get("RestoreBehavior"),
            "images": images,
        })
    return {
        "formatVersion": 1,
        "sha256": hashlib.sha256(data).hexdigest(),
        "version": manifest["ProductVersion"],
        "build": manifest["ProductBuildVersion"],
        "products": manifest["SupportedProductTypes"],
        "identities": identities,
    }


if __name__ == "__main__":
    print(json.dumps(inspect(pathlib.Path(sys.argv[1]).read_bytes()), indent=2))
