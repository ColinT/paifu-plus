/** Tiny DOM helpers. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<Record<string, any>> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v as string;
    else if (k === 'style') e.setAttribute('style', v as string);
    else if (k.startsWith('on') && typeof v === 'function') (e as any)[k.toLowerCase()] = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, String(v));
  }
  for (const c of children) e.append(c);
  return e;
}

export function clear(node: HTMLElement) { while (node.firstChild) node.removeChild(node.firstChild); }
