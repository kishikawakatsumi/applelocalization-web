// Select by evidence, never by the order of hdiutil's system-entities.
export function selectImageVolume(volumes, expectedVersion) {
  if (!Array.isArray(volumes) || volumes.length === 0) throw new Error('No mounted image volumes');
  if (!expectedVersion) {
    if (volumes.length !== 1) throw new Error('Unversioned image must have exactly one volume');
    return volumes[0];
  }
  if (!expectedVersion.ProductVersion || !expectedVersion.ProductBuildVersion) throw new Error('Incomplete expected version');
  const matches = volumes.filter(v => v.internalVersion?.ProductVersion === expectedVersion.ProductVersion
    && v.internalVersion?.ProductBuildVersion === expectedVersion.ProductBuildVersion);
  if (matches.length !== 1) throw new Error(`Expected exactly one matching OS volume, found ${matches.length}`);
  return matches[0];
}
