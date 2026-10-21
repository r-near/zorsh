import fc from "fast-check"
import { HarnessError } from "./oracle-client.mjs"

// A dead persistent child cannot evaluate smaller inputs. Preserve the actual
// trigger and interrupt before another predicate call; codec assertions still
// receive fast-check's normal shrinking and seed/path replay.
export async function checkProperty(arbitrary, predicate, parameters) {
  let infrastructureFailure
  const property = fc.asyncProperty(arbitrary, async (input) => {
    if (infrastructureFailure) throw new fc.PreconditionFailure(true)
    try {
      await predicate(input)
    } catch (error) {
      if (error instanceof HarnessError)
        infrastructureFailure = { input: structuredClone(input), error }
      throw error
    }
  })
  const result = await fc.check(property, { ...parameters, endOnFailure: false })
  return {
    ...result,
    infrastructureFailure: infrastructureFailure && {
      ...infrastructureFailure,
      path: result.counterexamplePath,
    },
    classification: result.failed
      ? infrastructureFailure
        ? "infrastructure"
        : "codec_mismatch"
      : undefined,
  }
}
