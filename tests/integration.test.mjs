import { test } from "node:test";
import assert from "node:assert/strict";

import {
  calculateConstantProductOutput,
  calculateOptimalSplit,
  calculateSlippageBounds,
  calculatePriceImpact
} from "@qmoosa/dex-aggregator-protocol";

import {
  DexAggregatorEngine
} from "@qmoosa/dex-aggregator-engine";

import {
  DexAggregatorClient,
  generateKeyPair
} from "@qmoosa/dex-aggregator-sdk";

test("1. Cross-Repo Mathematical Invariant Verification", () => {
  const reserveIn = 1_000_000n * 10n ** 6n;
  const reserveOut = 500n * 10n ** 18n;
  const amountIn = 10_000n * 10n ** 6n;

  const out = calculateConstantProductOutput(amountIn, reserveIn, reserveOut, 30n);
  assert.ok(out > 4n * 10n ** 18n && out < 5n * 10n ** 18n);

  const { minAmountOut } = calculateSlippageBounds(out, 50n);
  assert.ok(minAmountOut < out);
});

test("2. End-to-End Multi-Repo Split Route Discovery and Execution", async () => {
  const { publicKey } = generateKeyPair();
  const engine = new DexAggregatorEngine(publicKey, 31337);

  // Pool 1: QmoosaAMM (USDC -> WETH)
  engine.registerPoolDirect({
    id: "pool_qmoosa_usdc_weth",
    dexName: "QmoosaAMM",
    tokenIn: "USDC",
    tokenOut: "WETH",
    reserveIn: 1_000_000n * 10n ** 6n,
    reserveOut: 500n * 10n ** 18n,
    feeBps: 30n
  });

  // Pool 2: Sushiswap (USDC -> WETH)
  engine.registerPoolDirect({
    id: "pool_sushi_usdc_weth",
    dexName: "Sushiswap",
    tokenIn: "USDC",
    tokenOut: "WETH",
    reserveIn: 1_000_000n * 10n ** 6n,
    reserveOut: 500n * 10n ** 18n,
    feeBps: 30n
  });

  const client = new DexAggregatorClient(engine);

  // Large trade: 100,000 USDC -> Engine should split across both pools
  const quote = client.getBestRoute("USDC", "WETH", 100_000n * 10n ** 6n);
  assert.equal(quote.paths.length, 2);

  const receipt = await client.executeSwap(quote, "0xArbitrageTrader");
  assert.equal(receipt.success, true);
  assert.equal(receipt.recipient, "0xArbitrageTrader");
  assert.ok(receipt.actualAmountOut >= quote.minAmountOut);
  assert.equal(receipt.pathsUsed, 2);
});

test("3. Multi-Hop Sequential Route Across Intermediary Pools", async () => {
  const { publicKey } = generateKeyPair();
  const engine = new DexAggregatorEngine(publicKey, 31337);

  // Hop 1: USDC -> WETH
  engine.registerPoolDirect({
    id: "pool_usdc_weth",
    dexName: "QmoosaAMM",
    tokenIn: "USDC",
    tokenOut: "WETH",
    reserveIn: 1_000_000n * 10n ** 6n,
    reserveOut: 500n * 10n ** 18n,
    feeBps: 30n
  });

  // Hop 2: WETH -> DAI
  engine.registerPoolDirect({
    id: "pool_weth_dai",
    dexName: "Curve",
    tokenIn: "WETH",
    tokenOut: "DAI",
    reserveIn: 500n * 10n ** 18n,
    reserveOut: 1_000_000n * 10n ** 18n,
    feeBps: 10n
  });

  const client = new DexAggregatorClient(engine);
  const quote = client.getBestRoute("USDC", "DAI", 10_000n * 10n ** 6n);

  assert.equal(quote.tokenIn, "USDC");
  assert.equal(quote.tokenOut, "DAI");
  assert.ok(quote.paths[0].hops.length >= 2);

  const receipt = await client.executeSwap(quote, "0xUserMultiHop");
  assert.equal(receipt.success, true);
  assert.ok(receipt.actualAmountOut >= quote.minAmountOut);
});
