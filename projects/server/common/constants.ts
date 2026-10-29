/**
 * Base URL of the external HoF Viewer, a third-party website to browse Hall of Fame content.
 * Its URL path scheme is an external contract.
 * Deliberately hardcoded rather than configurable, since that URL scheme is code anyway.
 */
export const viewerBaseUrl = 'https://viewer.halloffame.mtq.io';

/**
 * A mod's page on Paradox Mods.
 * The platform is mandatory, and Windows is the one platform where everything is available, the
 * "Any" platform only listing portable assets.
 */
export function paradoxModUrl(paradoxModId: number): string {
  return `https://mods.paradoxplaza.com/mods/${paradoxModId}/Windows`;
}
