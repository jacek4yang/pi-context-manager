// Tests for the byte-accurate cacheability analyzer ([C-*] context-layer).
// The analyzer measures the LOCAL stable prefix between serialized
// projections; nothing here may be reported as a provider cache-hit rate.

import assert from "node:assert/strict";
import { test } from "node:test";
import { compareProjections, compareProjectionSeries } from "../src/core/cacheability.ts";

test("[C] identical projections are fully byte-stable", () => {
  const a = JSON.stringify({ messages: [{ role: "user", content: "hello" }] });
  const c = compareProjections(a, a);
  assert.equal(c.bytesA, Buffer.byteLength(a, "utf8"));
  assert.equal(c.bytesB, c.bytesA);
  assert.equal(c.commonPrefixBytes, c.bytesA);
  assert.equal(c.commonPrefixRatio, 1);
  assert.equal(c.firstChangedByte, c.bytesA);
  assert.equal(c.changedSuffixBytesB, 0);
});

test("[C] appended tail keeps the whole earlier projection as prefix", () => {
  const a = "stable-head-".repeat(10);
  const b = a + "new-turn-appended";
  const c = compareProjections(a, b);
  assert.equal(c.commonPrefixBytes, Buffer.byteLength(a, "utf8"));
  assert.equal(c.commonPrefixRatio, 1);
  assert.equal(c.firstChangedByte, c.bytesA);
  assert.equal(c.changedSuffixBytesB, Buffer.byteLength("new-turn-appended", "utf8"));
});

test("[C] single early change bounds the stable prefix at the change", () => {
  const head = "A".repeat(1000);
  const tail = "B".repeat(500);
  const a = head + tail;
  // one byte flipped at offset 400
  const b = "A".repeat(400) + "X" + "A".repeat(599) + tail;
  const c = compareProjections(a, b);
  assert.equal(c.firstChangedByte, 400);
  assert.equal(c.commonPrefixBytes, 400);
  assert.equal(c.changedSuffixBytesB, Buffer.byteLength(b, "utf8") - 400);
});

test("[C] CJK/UTF-8 multi-byte content compares byte-accurately", () => {
  const a = "上下文管理器·缓存前缀稳定性测试";
  const b = "上下文管理器·缓存前缀稳定性测試"; // last char differs
  const c = compareProjections(a, b);
  const prefixChar = "上下文管理器·缓存前缀稳定性测";
  // Byte-accurate, not char-aligned: 试 (E8 AF 95) and 試 (E8 A9 A6) share
  // their first UTF-8 byte, so the stable prefix extends one byte past the
  // last common character boundary.
  assert.equal(c.commonPrefixBytes, Buffer.byteLength(prefixChar, "utf8") + 1);
  assert.ok(c.commonPrefixBytes < c.bytesA);
  // byte offsets are not required to land on character boundaries
  assert.equal(c.commonPrefixBytes % 1, 0);
});

test("[C] change inside a multi-byte character splits at the byte", () => {
  const a = "ok" + "文" + "tail";
  const b = "ok" + "字" + "tail";
  const c = compareProjections(a, b);
  assert.equal(c.commonPrefixBytes, Buffer.byteLength("ok", "utf8"));
  assert.equal(c.firstChangedByte, 2);
});

test("[C] large projections compare in reasonable time and exactly", () => {
  const block = "x".repeat(1024);
  const a = block.repeat(1024); // 1 MiB
  const b = block.repeat(1023) + "y".repeat(1024);
  const start = process.hrtime.bigint();
  const c = compareProjections(a, b);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(c.commonPrefixBytes, 1024 * 1023);
  assert.equal(c.changedSuffixBytesB, 1024);
  assert.ok(elapsedMs < 1000, `comparison took ${elapsedMs.toFixed(1)}ms`);
});

test("[C] empty projections", () => {
  const bothEmpty = compareProjections("", "");
  assert.equal(bothEmpty.commonPrefixBytes, 0);
  assert.equal(bothEmpty.commonPrefixRatio, 1);
  assert.equal(bothEmpty.changedSuffixBytesB, 0);

  const aEmpty = compareProjections("", "content");
  assert.equal(aEmpty.commonPrefixBytes, 0);
  assert.equal(aEmpty.commonPrefixRatio, 0);
  assert.equal(aEmpty.firstChangedByte, 0);
  assert.equal(aEmpty.changedSuffixBytesB, Buffer.byteLength("content", "utf8"));

  const bEmpty = compareProjections("content", "");
  assert.equal(bEmpty.commonPrefixBytes, 0);
  assert.equal(bEmpty.commonPrefixRatio, 0);
});

test("[C] binary-safe on non-UTF8-clean byte sequences", () => {
  const a = Buffer.from([0x00, 0xff, 0xfe, 0x01]);
  const b = Buffer.from([0x00, 0xff, 0xfd, 0x01]);
  const c = compareProjections(a, b);
  assert.equal(c.firstChangedByte, 2);
});

test("[C] prefix series averages consecutive stable-prefix ratios", () => {
  const t1 = "turn-one";
  const t2 = t1 + "turn-two";
  const t3 = t2 + "turn-three";
  const series = compareProjectionSeries([t1, t2, t3]);
  assert.equal(series.comparisons.length, 2);
  assert.equal(series.averageStablePrefixRatio, 1);
  assert.equal(series.finalCommonPrefixBytes, Buffer.byteLength(t2, "utf8"));
  assert.throws(() => compareProjectionSeries(["only-one"]));
});
