/** One file in a bundle. `mode` defaults to 0o644; scripts use 0o755. */
export interface TarEntry {
  path: string;
  content: Buffer;
  mode?: number;
}

/** Bundle wire-format version. Bumped only on a breaking layout change. */
export const BUNDLE_FORMAT_VERSION = 1;
