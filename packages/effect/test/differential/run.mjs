import assert from "node:assert/strict"
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import fc from "fast-check"
import { checkProperty } from "./support/check-property.mjs"
import { OracleClient, HarnessError } from "./support/oracle-client.mjs"
const { primitives, hex, bytes, same, attempt, normalizeOracle, rawArbitrary } =
  await import("./support/primitives.mjs").catch((cause) => {
    throw new Error(
      "Cannot load built Effect exports. From the repository root run vp run test-effect-differential to build both prerequisites.",
      { cause },
    )
  })

const root = fileURLToPath(new URL("../../../../", import.meta.url))
const require = createRequire(import.meta.url)
const version = (name) => require(`${name}/package.json`).version
const quote = (arg) =>
  /^[A-Za-z0-9_./:=+-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'"
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex")
function codecIdentity() {
  const path = fileURLToPath(import.meta.resolve("@zorsh/effect"))
  return {
    path,
    sha256: sha256(path),
    files: readdirSync(dirname(path))
      .filter((name) => name.endsWith(".js"))
      .sort()
      .map((name) => ({ name, sha256: sha256(resolve(dirname(path), name)) })),
  }
}
const durableValue = (value) =>
  value instanceof Uint8Array
    ? { hex: hex(value) }
    : typeof value === "bigint"
      ? { bigint: String(value) }
      : Array.isArray(value)
        ? value.map(durableValue)
        : value

function failureRecord(error) {
  return {
    name: error?.name,
    kind: error?.kind,
    message: String(error?.message ?? error),
    stack: error?.stack,
  }
}
function offsetView(input) {
  const backing = new Uint8Array(input.length + 7).fill(0xa5)
  backing.set(input, 3)
  return { backing, view: backing.subarray(3, input.length + 3) }
}
async function decodeParity(entry, raw, oracle, mutation) {
  const { backing, view } = offsetView(raw)
  const before = backing.slice()
  const ts = attempt(() => entry.decode(view))
  same(backing, before, "decode modified input backing storage")
  const rust = await oracle.request(entry.id, "decode", { hex: hex(raw) })
  same(ts.ok, rust.ok, `${entry.id} raw acceptance differs: ${hex(raw)}`)
  if (!ts.ok) return false
  const normalized = entry.normalize(mutation === "decoded-value" ? ts.value + 1 : ts.value)
  same(normalized, normalizeOracle(entry, rust.value), `${entry.id} decoded values differ`)
  same(hex(entry.encode(ts.value)), hex(raw), `${entry.id} TS accepted noncanonical bytes`)
  // Canonicality is checked by an independent Rust serialization call too.
  const canonical = await oracle.request(entry.id, "encode", { value: rust.value })
  assert.ok(canonical.ok, "Rust rejected re-encoding its accepted value")
  same(canonical.hex, hex(raw), `${entry.id} Rust accepted noncanonical bytes`)
  if (ts.value instanceof Uint8Array) {
    const owned = ts.value.slice()
    backing.fill(0)
    same(ts.value, owned, "decoded bytes alias input backing storage")
  }
  return true
}

async function valueInvariant(
  entry,
  transport,
  oracle,
  mutation,
  prefixSelector,
  suffix = Uint8Array.of(0x97),
) {
  let value = entry.fromTransport(transport)
  let backing
  if (value instanceof Uint8Array) {
    const offset = offsetView(value)
    backing = offset.backing
    value = offset.view
  }
  const before = backing?.slice()
  const ts = attempt(() => entry.encode(value))
  if (backing) same(backing, before, "encode modified byte-view input")
  const rust = await oracle.request(entry.id, "encode", { value: transport })
  same(ts.ok, rust.ok, `${entry.id} encode acceptance differs`)
  if (!ts.ok) {
    // Only valid NaN float transports may be rejected in this value domain.
    assert.ok((entry.id === "f32" || entry.id === "f64") && Number.isNaN(value))
    return false
  }
  let actualHex = hex(ts.value)
  // Deliberately wrong adapter, confined to the controlled proof invocation.
  if (mutation === "encoded-bitflip") {
    const corrupted = ts.value.slice()
    corrupted[0] ^= 1
    actualHex = hex(corrupted)
  }
  same(actualHex, rust.hex, `${entry.id} independently encoded bytes differ`)
  const expected = entry.normalize(value)
  same(normalizeOracle(entry, rust.value), expected, "Rust encode changed value")
  const rustDecoded = await oracle.request(entry.id, "decode", { hex: actualHex })
  assert.ok(rustDecoded.ok, "Rust rejected TS-encoded bytes")
  same(normalizeOracle(entry, rustDecoded.value), expected, "Rust decode of TS bytes changed value")
  const rustBytes = bytes(rust.hex)
  const decoded = entry.decode(rustBytes)
  same(entry.normalize(decoded), expected, "TS decode of Rust bytes changed value")
  same(hex(entry.encode(decoded)), rust.hex, "TS canonical re-encode changed bytes")
  // Repeat on the same codec after rejection. Failure must leave no operation
  // state and strict whole-input decoding must reject all tested suffixes.
  const suffixed = new Uint8Array(rustBytes.length + suffix.length)
  suffixed.set(rustBytes)
  suffixed.set(suffix, rustBytes.length)
  assert.equal(attempt(() => entry.decode(suffixed)).ok, false, "TS accepted nonempty suffix")
  if (suffixed.length <= 65536) {
    const suffixRust = await oracle.request(entry.id, "decode", { hex: hex(suffixed) })
    assert.equal(suffixRust.ok, false, "Rust accepted nonempty suffix")
  }
  if (rustBytes.length) {
    // A proper prefix selected independently from content; deterministic examples
    // below additionally enumerate every prefix of critical small encodings.
    const cut =
      prefixSelector === undefined
        ? Math.floor(rustBytes.length / 2)
        : prefixSelector % rustBytes.length
    const prefix = rustBytes.subarray(0, cut)
    assert.equal(attempt(() => entry.decode(prefix)).ok, false, "TS accepted proper prefix")
    const prefixRust = await oracle.request(entry.id, "decode", { hex: hex(prefix) })
    assert.equal(prefixRust.ok, false, "Rust accepted proper prefix")
  }
  same(hex(entry.encode(value)), rust.hex, "prior failed operation corrupted encoder state")
  same(
    entry.normalize(entry.decode(rustBytes)),
    expected,
    "prior failed operation corrupted decoder state",
  )
  if (backing) {
    const encodedBefore = ts.value.slice()
    backing.fill(0)
    same(ts.value, encodedBefore, "encoded output aliases input storage")
  }
  if (decoded instanceof Uint8Array) {
    const decodedBefore = decoded.slice()
    rustBytes.fill(0)
    same(decoded, decodedBefore, "decoded output aliases encoded input storage")
    decoded.fill(0)
    same(
      entry.normalize(entry.decode(ts.value)),
      expected,
      "decoded mutation corrupted later operation",
    )
  }
  return true
}

export function parseOptions(args) {
  const options = {
    runs: 1000,
    seed: 20261020,
    output: resolve(root, ".artifacts/primitive-differential"),
    oracle: resolve(root, "rust/borsh-oracle/target/debug/zorsh-borsh-oracle"),
  }
  const names = {
    "--runs": "runs",
    "--seed": "seed",
    "--path": "path",
    "--schema": "schema",
    "--family": "family",
    "--output": "output",
    "--oracle": "oracle",
    "--mutation": "mutation",
    "--exact-case": "exactCase",
  }
  for (let i = 0; i < args.length; i++) {
    const name = names[args[i]]
    if (!name || args[i + 1] === undefined)
      throw new Error(`unknown or missing argument ${args[i]}`)
    options[name] = ["runs", "seed"].includes(name) ? Number(args[++i]) : args[++i]
  }
  options.oracle = resolve(options.oracle)
  options.output = resolve(options.output)
  if (
    !Number.isSafeInteger(options.runs) ||
    options.runs < 1 ||
    options.runs > 100000 ||
    !Number.isSafeInteger(options.seed) ||
    options.seed < -2147483648 ||
    options.seed > 2147483647
  )
    throw new Error("runs must be 1..100000; seed must be signed 32-bit integer")
  if (options.path !== undefined && (!options.schema || !options.family))
    throw new Error("replay path requires --schema and --family")
  if (options.schema && !primitives.some((s) => s.id === options.schema))
    throw new Error("unknown primitive schema")
  if (options.family && !["value", "raw"].includes(options.family))
    throw new Error("family must be value or raw")
  if (options.exactCase && (options.schema || options.family || options.path))
    throw new Error("--exact-case cannot be combined with --schema, --family or --path")
  const exact =
    options.exactCase && deterministicCases.find((item) => item.id === options.exactCase)
  if (options.exactCase && !exact) throw new Error("unknown exact case")
  const mutationSchema = exact?.schemaId ?? options.schema
  const mutationFamily = exact?.family ?? options.family
  if (
    options.mutation &&
    (mutationSchema !== "u16" ||
      !(
        (options.mutation === "encoded-bitflip" && mutationFamily === "value") ||
        (options.mutation === "decoded-value" && mutationFamily === "raw")
      ))
  )
    throw new Error(
      "controlled mutation requires u16 value/encoded-bitflip or u16 raw/decoded-value",
    )
  return options
}

// Stable IDs name concrete inputs rather than positions in the whole campaign.
// Preparing prefix bytes is part of that named case, so oracle failures there
// also retain the originating value and an exact replay command.
const deterministicCases = []
for (const entry of primitives) {
  for (const [index, value] of (entry.examples ?? []).entries())
    deterministicCases.push({
      id: `${entry.id}-value-${index}`,
      schemaId: entry.id,
      family: "value",
      value,
    })
  const value =
    entry.id === "string"
      ? "é😀"
      : entry.id === "bytes"
        ? "000102ff"
        : (entry.examples ?? [entry.id === "bool" ? false : null])[0]
  const length =
    entry.width ??
    (entry.id === "string" ? 4 + Buffer.byteLength(value, "utf8") : 4 + value.length / 2)
  for (let cut = 0; cut < length; cut++)
    deterministicCases.push({
      id: `${entry.id}-prefix-${cut}`,
      schemaId: entry.id,
      family: "prefix",
      value,
      length,
      cut,
    })
}
for (const tag of [2, 128, 255])
  deterministicCases.push({
    id: `bool-tag-${tag}`,
    schemaId: "bool",
    family: "raw",
    hex: hex(Uint8Array.of(tag)),
    accepted: false,
  })
for (const entry of primitives.filter((item) => item.id === "f32" || item.id === "f64")) {
  for (const value of entry.examples)
    deterministicCases.push({
      id: `${entry.id}-bits-${value.bits}`,
      schemaId: entry.id,
      family: "raw",
      hex: hex(bytes(value.bits).reverse()),
      accepted: !Number.isNaN(entry.fromTransport(value)),
    })
}
for (const [index, value] of ["\uD800", "a\uDC00", "\uD800x", "\uD800\uD800"].entries())
  deterministicCases.push({
    id: `string-surrogate-${index}`,
    schemaId: "string",
    family: "utf16",
    value,
  })
for (const payload of [
  [0xc0, 0xaf],
  [0xed, 0xa0, 0x80],
  [0xf4, 0x90, 0x80, 0x80],
  [0x80],
  [0xe2, 0x82],
]) {
  const raw = Uint8Array.of(payload.length, 0, 0, 0, ...payload)
  deterministicCases.push({
    id: `string-utf8-${hex(Uint8Array.from(payload))}`,
    schemaId: "string",
    family: "raw",
    hex: hex(raw),
    accepted: false,
  })
}
for (const schemaId of ["string", "bytes"])
  deterministicCases.push({
    id: `${schemaId}-boundary`,
    schemaId,
    family: "boundary",
    value: schemaId === "string" ? "x".repeat(65532) : "7f".repeat(65532),
  })

async function runExactCase(testCase, oracle, mutation) {
  const entry = primitives.find((item) => item.id === testCase.schemaId)
  switch (testCase.family) {
    case "value":
      return valueInvariant(entry, testCase.value, oracle, mutation)
    case "prefix": {
      testCase.phase = "prepare-prefix"
      const encoded = await oracle.request(entry.id, "encode", { value: testCase.value })
      assert.ok(encoded.ok, "Rust rejected prefix preparation value")
      assert.equal(encoded.hex.length / 2, testCase.length, "unexpected prefix preparation width")
      testCase.hex = hex(bytes(encoded.hex).subarray(0, testCase.cut))
      testCase.phase = "decode-prefix"
      assert.equal(await decodeParity(entry, bytes(testCase.hex), oracle), false)
      break
    }
    case "raw":
      assert.equal(
        await decodeParity(entry, bytes(testCase.hex), oracle, mutation),
        testCase.accepted,
      )
      break
    case "utf16":
      // Lone UTF-16 surrogates cannot denote Rust Strings; no oracle request.
      assert.equal(
        attempt(() => entry.encode(testCase.value)).ok,
        false,
        "TS accepted malformed UTF-16",
      )
      break
    case "boundary": {
      await valueInvariant(entry, testCase.value, oracle)
      const boundary = await oracle.request(entry.id, "encode", { value: testCase.value })
      assert.ok(boundary.ok)
      await decodeParity(entry, bytes(boundary.hex), oracle)
      break
    }
    default:
      throw new Error("unknown exact case family")
  }
}

function saveFailure(options, report, detail, selection) {
  const replayArgs = [
    "vp",
    "exec",
    "node",
    fileURLToPath(import.meta.url),
    "--oracle",
    options.oracle,
    ...selection,
    ...(options.mutation ? ["--mutation", options.mutation] : []),
  ]
  const record = {
    ...detail,
    node: process.version,
    versions: report.versions,
    oracle: report.oracle,
    codecEntry: report.codecEntry,
    replayArgs,
    replay: replayArgs.map(quote).join(" "),
  }
  const name = detail.exactCase?.id ?? `${detail.schemaId}-${detail.family}`
  const path = resolve(options.output, `failure-${name}-${Date.now()}.json`)
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n")
  return path
}

export async function runSuite(options) {
  mkdirSync(options.output, { recursive: true })
  const started = Date.now()
  if (!existsSync(options.oracle))
    throw new Error(
      `Missing Rust oracle: ${options.oracle}. From the repository root run vp run test-effect-differential to build both prerequisites.`,
    )
  const report = {
    node: process.version,
    versions: { effect: version("effect"), fastCheck: version("fast-check") },
    codecEntry: codecIdentity(),
    options,
    oracle: { path: options.oracle, sha256: sha256(options.oracle) },
    startedAt: new Date().toISOString(),
    status: "running",
    properties: [],
    deterministicCases: 0,
  }
  const oracle = new OracleClient(options.oracle)
  try {
    if (
      options.exactCase ||
      (!options.path && !options.mutation && !options.schema && !options.family)
    ) {
      for (const original of deterministicCases.filter(
        (item) => !options.exactCase || item.id === options.exactCase,
      )) {
        const testCase = { ...original }
        try {
          await runExactCase(testCase, oracle, options.mutation)
          if (oracle.failure) throw oracle.failure
          report.deterministicCases++
        } catch (error) {
          const path = saveFailure(
            options,
            report,
            {
              exactCase: testCase,
              classification: error instanceof HarnessError ? "infrastructure" : "codec_mismatch",
              error: failureRecord(error),
            },
            ["--exact-case", testCase.id],
          )
          throw new Error(`Exact differential case failed; replay saved in ${path}`, {
            cause: error,
          })
        }
      }
    }
    for (const entry of primitives.filter(
      (entry) => !options.exactCase && (!options.schema || entry.id === options.schema),
    )) {
      for (const family of ["value", "raw"].filter(
        (family) => !options.family || family === options.family,
      )) {
        const arbitrary =
          family === "value"
            ? fc.record({
                value: entry.arbitrary,
                prefixSelector: fc.nat(65535),
                suffixHex: fc.uint8Array({ minLength: 1, maxLength: 8 }).map(hex),
              })
            : rawArbitrary(entry)
        const outcomes = { accepted: 0, rejected: 0 }
        const result = await checkProperty(
          arbitrary,
          async (input) => {
            const accepted =
              family === "value"
                ? await valueInvariant(
                    entry,
                    input.value,
                    oracle,
                    options.mutation,
                    input.prefixSelector,
                    bytes(input.suffixHex),
                  )
                : await decodeParity(entry, input, oracle, options.mutation)
            // A response can resolve before a same-chunk unsolicited suffix
            // records a sticky client failure. Attribute it to this input.
            if (oracle.failure) throw oracle.failure
            outcomes[accepted ? "accepted" : "rejected"]++
          },
          {
            numRuns: options.runs,
            seed: options.seed,
            ...(options.path === undefined ? {} : { path: options.path }),
          },
        )
        const item = {
          schemaId: entry.id,
          family,
          failed: result.failed,
          classification: result.classification,
          numRuns: result.numRuns,
          numShrinks: result.numShrinks,
          seed: result.seed,
          path: result.counterexamplePath,
          outcomes,
        }
        report.properties.push(item)
        if (result.failed) {
          const path = saveFailure(
            options,
            report,
            {
              ...item,
              counterexample: durableValue(result.counterexample),
              infrastructureFailure: result.infrastructureFailure && {
                input: durableValue(result.infrastructureFailure.input),
                path: result.infrastructureFailure.path,
                error: failureRecord(result.infrastructureFailure.error),
              },
              error: failureRecord(result.errorInstance),
            },
            [
              "--schema",
              entry.id,
              "--family",
              family,
              "--seed",
              String(result.seed),
              "--path",
              result.counterexamplePath,
              "--runs",
              String(options.runs),
            ],
          )
          throw new Error(`Differential ${result.classification} failed; replay saved in ${path}`, {
            cause: result.errorInstance,
          })
        }
        console.log(JSON.stringify({ ...item, elapsedMs: Date.now() - started }))
      }
    }
    report.status = "passed"
  } catch (error) {
    report.status = "failed"
    report.error = failureRecord(error)
    throw error
  } finally {
    const termination = await oracle.close()
    // A late unsolicited frame or watchdog failure must not turn into a passing
    // suite just because the final property request already resolved.
    const finalFailure = report.status === "passed" ? oracle.failure : undefined
    if (finalFailure) {
      report.status = "failed"
      report.error = failureRecord(finalFailure)
    }
    Object.assign(report, {
      elapsedMs: Date.now() - started,
      requests: oracle.requests,
      peakRssBytes: oracle.peakRssBytes,
      termination,
      childPid: oracle.pid,
      harnessFailure: oracle.failure ? failureRecord(oracle.failure) : undefined,
    })
    writeFileSync(
      resolve(options.output, `run-${started}.json`),
      JSON.stringify(report, null, 2) + "\n",
    )
  }
  if (oracle.failure) throw oracle.failure
  return report
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await runSuite(parseOptions(process.argv.slice(2)))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
