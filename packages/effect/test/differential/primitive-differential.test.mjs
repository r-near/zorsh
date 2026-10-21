import { it } from "vite-plus/test"
import { parseOptions, runSuite } from "./run.mjs"

it("native Effect primitives agree with typed borsh-rs, with shrinking", async () => {
  const args = []
  // Test-boundary configuration; the standalone command also accepts these as
  // explicit flags, including --schema/--family/--path for minimized replay.
  for (const [name, flag] of [
    ["ZORSH_BORSH_ORACLE", "--oracle"],
    ["ZORSH_DIFFERENTIAL_RUNS", "--runs"],
    ["ZORSH_DIFFERENTIAL_SEED", "--seed"],
    ["ZORSH_DIFFERENTIAL_OUTPUT", "--output"],
  ]) {
    if (process.env[name]) args.push(flag, process.env[name])
  }
  await runSuite(parseOptions(args))
}, 120000)
