/*
 * Read-only view of a recorded Project Capability Profile (projects.capability_profile) for the System page. The stored value is
 * jsonb written by the detector (see ./profile); it is read defensively and never re-detected or written here.
 */

export type CapabilityCell = { available: true; command: string | null } | { available: false };

export interface CapabilityRow {
  language: string;
  framework: string;
  packageManager: string;
  build: CapabilityCell;
  test: CapabilityCell;
  lint: CapabilityCell;
  typecheck: CapabilityCell;
  browserTests: CapabilityCell;
}

export const NOT_DETECTED = "Not detected";

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const command = (v: unknown): CapabilityCell => {
  const c = text(v);
  return c ? { available: true, command: c } : { available: false };
};

/** null when no profile has been recorded yet; otherwise the cells of the "Project Capabilities" table. */
export function capabilityRow(profile: unknown): CapabilityRow | null {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
  const p = profile as Record<string, unknown>;
  const languages = Array.isArray(p.languages) ? p.languages.map(text).filter((l): l is string => l !== null) : [];
  const cmds = p.commands && typeof p.commands === "object" ? (p.commands as Record<string, unknown>) : {};
  return {
    language: languages.length ? languages.join(", ") : NOT_DETECTED,
    framework: text(p.framework) ?? NOT_DETECTED,
    packageManager: text(p.packageManager) ?? NOT_DETECTED,
    build: command(cmds.build),
    test: command(cmds.test),
    lint: command(cmds.lint),
    typecheck: command(cmds.typecheck),
    browserTests: p.browserTests === true ? { available: true, command: null } : { available: false },
  };
}
