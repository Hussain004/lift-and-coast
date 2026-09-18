// Plan section 8 (garage showroom): the driver figure as data, not JSX.
// A suited figure with helmet on - no face, no sculpted meshes - built from
// the same stepped-box vocabulary as the car (see lib/race/carBody.ts).
// Stands on y=0 (feet at the ground plane), faces -z like the car. Origin,
// axes and units are meters; the component maps color roles onto the
// selected team and driver (see app/Showroom.tsx).
//
// Nothing here touches physics: pure showroom scenery for the home page.

export type FigureColor = "suit" | "trim" | "carbon" | "helmet" | "visor";

export interface FigurePanel {
  size: [number, number, number];
  position: [number, number, number];
  color: FigureColor;
}

export interface DriverFigureGeometry {
  panels: FigurePanel[];
  /** Helmet sphere: radius + center. */
  helmet: { radius: number; position: [number, number, number] };
}

export function computeDriverFigure(): DriverFigureGeometry {
  const panels: FigurePanel[] = [];
  const box = (
    size: [number, number, number],
    position: [number, number, number],
    color: FigureColor
  ) => {
    panels.push({ size, position, color });
  };

  // Boots and legs.
  for (const side of [-1, 1] as const) {
    box([0.16, 0.12, 0.28], [side * 0.12, 0.06, 0], "carbon");
    box([0.15, 0.72, 0.17], [side * 0.12, 0.48, 0], "suit");
  }
  // Torso with a trim band proud of the surface, neck bridging to the lid.
  box([0.46, 0.62, 0.26], [0, 1.15, 0], "suit");
  box([0.48, 0.1, 0.28], [0, 1.3, 0], "trim");
  box([0.14, 0.12, 0.14], [0, 1.47, 0], "carbon");
  // Arms with gloves.
  for (const side of [-1, 1] as const) {
    box([0.12, 0.6, 0.15], [side * 0.31, 1.08, 0], "suit");
    box([0.12, 0.12, 0.15], [side * 0.31, 0.72, 0], "carbon");
  }
  // Visor strip proud of the helmet's forward face.
  box([0.22, 0.09, 0.06], [0, 1.68, -0.15], "visor");

  return {
    panels,
    helmet: { radius: 0.17, position: [0, 1.66, 0] },
  };
}
