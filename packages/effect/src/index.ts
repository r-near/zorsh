/**
 * Borsh codecs derived from native Effect schemas.
 *
 * @since 0.1.0
 */

/**
 * Borsh widths, layouts and codec construction for native Effect schemas.
 *
 * **Example** (Deriving a codec)
 *
 * ```ts
 * import { Borsh } from "@zorsh/effect"
 * import { Schema } from "effect"
 *
 * const codec = Borsh.toCodec(Borsh.U16)
 * const bytes = Schema.encodeSync(codec)(0x1234)
 * // Uint8Array [52, 18]
 * ```
 *
 * @since 0.1.0
 */
export * as Borsh from "./Borsh.js"
