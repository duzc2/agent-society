/**
 * 将 CSS 颜色字符串解析为 [r, g, b]（0-255 范围）
 * 支持 hex (#rgb, #rrggbb)、rgb()、rgba()
 */
function parseColorToRgb(color: string): [number, number, number] | null {
  if (!color || color === 'transparent') return null;

  // hex
  const hex = color.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) {
      return [
        parseInt(h[0] + h[0], 16),
        parseInt(h[1] + h[1], 16),
        parseInt(h[2] + h[2], 16),
      ];
    }
    if (h.length >= 6) {
      return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
      ];
    }
  }

  // rgb / rgba
  const rgb = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) {
    return [parseInt(rgb[1]), parseInt(rgb[2]), parseInt(rgb[3])];
  }

  return null;
}

/**
 * WCAG 相对亮度公式
 * Y = 0.2126*R + 0.7152*G + 0.0722*B（线性化后）
 */
function relativeLuminance(r: number, g: number, b: number): number {
  const linearize = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/**
 * 判断一组 mood 颜色整体是否偏暗。
 * 对所有非 transparent 的颜色取平均亮度，低于阈值判为暗。
 */
export function isMoodDark(colors: string[] | null | undefined): boolean {
  if (!colors) return false;
  const luminances: number[] = [];
  for (const c of colors) {
    const rgb = parseColorToRgb(c);
    if (rgb) luminances.push(relativeLuminance(rgb[0], rgb[1], rgb[2]));
  }
  if (luminances.length === 0) return false;
  const avg = luminances.reduce((a, b) => a + b, 0) / luminances.length;
  return avg < 0.3;
}
