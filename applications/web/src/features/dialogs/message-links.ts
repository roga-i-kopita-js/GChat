export function messageLinks(text: string): string[] {
  const result = new Set<string>();
  const starts = /https?:\/\//gi;

  for (const match of text.matchAll(starts)) {
    const index = match.index;

    if (index > 0 && /[\p{L}\p{N}_]/u.test(Array.from(text.slice(0, index)).at(-1) ?? '')) {
      continue;
    }

    let address = text.slice(index).split(/[\p{White_Space}\p{Cc}<>"'«»‘’“”`]/u, 1)[0]!;

    for (;;) {
      const old = address;

      address = address.replace(/[.,!?;:]+$/, '');
      const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
      const end = address.at(-1) ?? '';

      if (
        pairs[end] &&
        [...address].filter((c) => c === end).length >
          [...address].filter((c) => c === pairs[end]).length
      ) {
        address = address.slice(0, -1);
      }

      if (old === address) {
        break;
      }
    }

    try {
      const url = new URL(address);

      if (['http:', 'https:'].includes(url.protocol) && url.host) {
        result.add(address);
      }
    } catch {
      /* Not an absolute HTTP URL. */
    }
  }

  return [...result];
}
