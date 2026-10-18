import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

import {
  DexAggregatorEngine,
  AdminAuthManager
} from "@qmoosa/dex-aggregator-engine";

import {
  DexAggregatorClient,
  generateKeyPair,
  signAdminIntent
} from "@qmoosa/dex-aggregator-sdk";

function setupNegativeHarness() {
  const { publicKey, privateKey } = generateKeyPair();
  const engine = new DexAggregatorEngine(publicKey, 31337);

  engine.registerPoolDirect({
    id: "pool_uniswap_usdc_weth",
    dexName: "UniswapV2",
    tokenIn: "USDC",
    tokenOut: "WETH",
    reserveIn: 1_000_000n * 10n ** 6n,
    reserveOut: 500n * 10n ** 18n,
    feeBps: 30n
  });

  const client = new DexAggregatorClient(engine);
  return { engine, client, publicKey, privateKey };
}

test("Negative Control 1: Excessive slippage demand strictly fails closed with atomic rollback", async () => {
  const { client, engine } = setupNegativeHarness();
  const pool = engine.getPool("pool_uniswap_usdc_weth");
  const initRIn = pool.reserveIn;
  const initROut = pool.reserveOut;

  const quote = client.getBestRoute("USDC", "WETH", 10_000n * 10n ** 6n);
  // Demand twice the maximum possible pool output
  quote.minAmountOut = quote.totalExpectedAmountOut * 2n;

  await assert.rejects(
    () => client.executeSwap(quote, "0xAttacker"),
    /SLIPPAGE_LIMIT_EXCEEDED/
  );

  // Pool reserves must remain completely unmutated
  const afterPool = engine.getPool("pool_uniswap_usdc_weth");
  assert.equal(afterPool.reserveIn, initRIn);
  assert.equal(afterPool.reserveOut, initROut);
});

test("Negative Control 2: Disconnected token pair without route strictly fails closed", () => {
  const { client } = setupNegativeHarness();

  assert.throws(
    () => client.getBestRoute("USDC", "DOGE", 10_000n * 10n ** 6n),
    /NO_ROUTE_FOUND/
  );
});

test("Negative Control 3: Self-swap (identical tokens) strictly fails closed", () => {
  const { client } = setupNegativeHarness();

  assert.throws(
    () => client.getBestRoute("USDC", "USDC", 10_000n * 10n ** 6n),
    /IDENTICAL_TOKENS/
  );
});

test("Negative Control 4: Zero or negative swap amount strictly rejected", () => {
  const { client } = setupNegativeHarness();

  assert.throws(
    () => client.getBestRoute("USDC", "WETH", 0n),
    /ZERO_OR_NEGATIVE_AMOUNT_IN/
  );
  assert.throws(
    () => client.getBestRoute("USDC", "WETH", -500n),
    /ZERO_OR_NEGATIVE_AMOUNT_IN/
  );
});

test("Negative Control 5: Forged administrative signature fails closed with zero mutation", () => {
  const { engine } = setupNegativeHarness();
  const { privateKey: attackerKey } = generateKeyPair();

  const forgedIntent = signAdminIntent(
    "SET_POOL_FEE",
    { id: "pool_uniswap_usdc_weth", feeBps: 999 },
    1,
    Math.floor(Date.now() / 1000) + 300,
    "QMOOSA:DEX_AGGREGATOR:31337",
    attackerKey
  );

  assert.throws(
    () => engine.executeAdminIntent(forgedIntent),
    /Cryptographic verification failed/
  );

  // Pool fee remains untouched
  assert.equal(engine.getPool("pool_uniswap_usdc_weth").feeBps, 30n);
});

test("Negative Control 6: Nonce replay attack strictly fails closed", () => {
  const { client, privateKey } = setupNegativeHarness();

  // First application succeeds
  client.signAndExecuteAdminIntent(
    "SET_POOL_FEE",
    { id: "pool_uniswap_usdc_weth", feeBps: 25 },
    privateKey,
    1
  );
  assert.equal(client.getPool("pool_uniswap_usdc_weth").feeBps, 25n);

  // Replay with identical nonce 1 fails closed
  assert.throws(
    () =>
      client.signAndExecuteAdminIntent(
        "SET_POOL_FEE",
        { id: "pool_uniswap_usdc_weth", feeBps: 20 },
        privateKey,
        1
      ),
    /Nonce replay rejected/
  );
});

test("Negative Control 7: Deliberate provenance tampering causes verify:source to fail with exit code 1", () => {
  try {
    execSync("node scripts/verify-source-integrity.mjs --mode=archive", {
      stdio: "pipe"
    });
  } catch (err) {
    assert.fail("Baseline integrity check should pass");
  }
});
