/** The key silhouette drawn for a room (PRD FR-12.5). Teeth come from the room's shape bytes. */
export const KEY_TEETH = 10;

export const keyDepths = (shape: Uint8Array): number[] =>
  Array.from({ length: KEY_TEETH }, (_, i) => 10 + (shape[i] % 5) * 9);

export const blankDepths = (): number[] => Array(KEY_TEETH).fill(4);

/** SVG path of the blade in a 600×190 viewBox. */
export function bladePath(depths: number[]): string {
  const top = 74;
  const base = 112;
  const x0 = 196;
  const w = 34;
  let d = `M150,${top} L556,${top} L586,${(top + base) / 2} L556,${base} `;
  for (let i = KEY_TEETH - 1; i >= 0; i--) {
    const a = x0 + i * w;
    const depth = depths[i];
    d += `L${a + w},${base} L${a + w - 9},${base + depth} L${a + 9},${base + depth} L${a},${base} `;
  }
  return d + `L150,${base} Z`;
}

export function bowPath(): string {
  const circle = (cx: number, cy: number, r: number) =>
    `M${cx - r},${cy} a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0 Z`;
  return `${circle(92, 93, 72)} ${circle(80, 93, 22)}`;
}
