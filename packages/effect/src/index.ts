/**
 * Borsh widths, layouts and codecs for native Effect schemas.
 *
 * **Example** (Deriving a codec)
 *
 * ```ts
 * import { Borsh } from "@zorsh/effect"
 * import { Schema } from "effect"
 *
 * const bytes = Schema.encodeSync(Borsh.toCodec(Borsh.U16))(0x1234)
 * // Uint8Array [52, 18]
 * ```
 */
export * as Borsh from "./Borsh.js"
