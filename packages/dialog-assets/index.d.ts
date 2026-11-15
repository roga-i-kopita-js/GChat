export declare const stickerIds: readonly string[];

export declare const reactionCatalog: readonly { readonly emoji: string; readonly label: string }[];

export declare const reactionEmojis: readonly string[];

export declare function normalizeReaction(value: unknown): string | null;

export declare function reactionGlyph(emoji: string): string;
