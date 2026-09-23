// Graphics quality tiers. The game has to run on laptops with no discrete
// GPU - integrated graphics, or no GPU at all (Chrome then rasterizes WebGL
// on the CPU via SwiftShader) - so every expensive rendering choice hangs
// off one of three tiers, and "auto" picks a tier from the renderer at
// load and steps down live if the frame rate can't hold.
export type GraphicsQuality = "low" | "medium" | "high";
export type GraphicsPref = GraphicsQuality | "auto";

export interface QualitySettings {
  /** Device-pixel-ratio ceiling - the biggest single cost lever (a 2x
   * HiDPI panel is four times the pixels of 1x). */
  maxDpr: number;
  /** Floor the live adapter may lower the DPR to before stepping down a
   * whole tier. */
  minDpr: number;
  antialias: boolean;
  /** Sun shadows (a tight map that follows the player's car). */
  shadows: boolean;
  shadowMapSize: number;
  /** Lambert (per-vertex-ish, cheap) instead of PBR standard materials. */
  cheapMaterials: boolean;
  /** Fraction of trackside trees kept. */
  floraDensity: number;
  /** Fog end = draw distance: nothing past it is visible, so the camera's
   * far plane sits just behind it and the GPU clips the rest. */
  fogFar: number;
}

export const QUALITY_SETTINGS: Record<GraphicsQuality, QualitySettings> = {
  low: {
    maxDpr: 0.75,
    minDpr: 0.5,
    antialias: false,
    shadows: false,
    shadowMapSize: 0,
    cheapMaterials: true,
    floraDensity: 0.45,
    fogFar: 190,
  },
  medium: {
    maxDpr: 1,
    minDpr: 0.7,
    antialias: false,
    shadows: true,
    shadowMapSize: 1024,
    cheapMaterials: false,
    floraDensity: 0.8,
    fogFar: 240,
  },
  high: {
    maxDpr: 1.75,
    minDpr: 1,
    antialias: true,
    shadows: true,
    shadowMapSize: 2048,
    cheapMaterials: false,
    floraDensity: 1,
    fogFar: 320,
  },
};

export const GRAPHICS_OPTIONS: { id: GraphicsPref; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

const STORAGE_KEY = "lift-and-coast.graphics.v1";

export function parseGraphicsPref(raw: string | null | undefined): GraphicsPref {
  return raw === "low" || raw === "medium" || raw === "high" ? raw : "auto";
}

export function loadGraphicsPref(): GraphicsPref {
  try {
    return parseGraphicsPref(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return "auto";
  }
}

export function saveGraphicsPref(pref: GraphicsPref): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Non-fatal: the next visit falls back to auto.
  }
}

/** Software rasterizers: Chrome's SwiftShader, Mesa's llvmpipe/softpipe,
 * Microsoft's WARP ("Basic Render Driver"). */
export function isSoftwareRenderer(renderer: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|basic render|warp/i.test(renderer);
}

/**
 * The tier "auto" starts from. Software rendering is always low; otherwise
 * medium, since integrated graphics is the common laptop case and the live
 * adapter only ever steps down - high is an explicit choice.
 */
export function pickAutoQuality(args: { renderer: string }): GraphicsQuality {
  return isSoftwareRenderer(args.renderer) ? "low" : "medium";
}

export function stepDownQuality(quality: GraphicsQuality): GraphicsQuality {
  return quality === "high" ? "medium" : "low";
}

export function nextGraphicsPref(pref: GraphicsPref): GraphicsPref {
  const order: GraphicsPref[] = ["auto", "low", "medium", "high"];
  return order[(order.indexOf(pref) + 1) % order.length];
}

/** The unmasked renderer string, or "" where the browser hides it. */
export function detectRenderer(): string {
  if (typeof document === "undefined") return "";
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return "software (no webgl)";
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return renderer;
  } catch {
    return "";
  }
}

/** Resolve a preference to a concrete tier at load. */
export function resolveGraphicsQuality(pref: GraphicsPref): GraphicsQuality {
  return pref === "auto" ? pickAutoQuality({ renderer: detectRenderer() }) : pref;
}
