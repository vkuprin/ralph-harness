import { describe, expect, test } from "bun:test";
import { addCost, addTokens, claudeText } from "../../src/loop/cost.ts";

describe("claudeText reads what a run said and what it cost", () => {
  test("one result object", () => {
    const r = claudeText(JSON.stringify({ type: "result", result: "done", total_cost_usd: 0.01234, usage: { input_tokens: 100, output_tokens: 50 } }));
    expect(r).toEqual({ text: "done\n", cost: "0.0123", tokens: "150" });
  });
  test("a failed run carries its text in errors[]", () => {
    const r = claudeText(JSON.stringify({ type: "result", is_error: true, errors: ["You've hit your limit"], total_cost_usd: 0 }));
    expect(r.text).toBe("You've hit your limit\n");
    expect(r.cost).toBe("0.0000");
    expect(r.tokens).toBe("-");
  });
  test("errors that are not strings are written as JSON with sorted keys", () => {
    expect(claudeText(JSON.stringify({ errors: [{ b: 1, a: 2 }, "x"] })).text).toBe('{"a":2,"b":1}\nx\n');
  });
  test("a result wins over errors", () => {
    expect(claudeText(JSON.stringify({ result: "ok", errors: ["no"] })).text).toBe("ok\n");
  });
  test("verbose mode: an array whose last result is the one", () => {
    const r = claudeText(
      JSON.stringify([
        { type: "system" },
        { type: "result", result: "first", total_cost_usd: 1 },
        { type: "assistant" },
        { type: "result", result: "last", total_cost_usd: 2 },
      ]),
    );
    expect(r).toEqual({ text: "last\n", cost: "2.0000", tokens: "-" });
  });
  test("output that is not JSON — a run killed before it answered — is kept as it is", () => {
    expect(claudeText("partial output")).toEqual({ text: "partial output", cost: "-", tokens: "-" });
    expect(claudeText("")).toEqual({ text: "", cost: "-", tokens: "-" });
  });
  test("an object with no result and no errors is kept whole", () => {
    const raw = JSON.stringify({ type: "system" });
    expect(claudeText(raw).text).toBe(`${raw}\n`);
  });
  test("tokens are input plus output, and one of them is enough", () => {
    expect(claudeText(JSON.stringify({ result: "", usage: { output_tokens: 7 } })).tokens).toBe("7");
  });
});

describe("sums in which - means unknown", () => {
  test("cost", () => {
    expect(addCost("-", "-")).toBe("-");
    expect(addCost("0.0123", "-")).toBe("0.0123");
    expect(addCost("0.0123", "0.0020")).toBe("0.0143");
  });
  test("tokens", () => {
    expect(addTokens("-", "-")).toBe("-");
    expect(addTokens("150", "50")).toBe("200");
    expect(addTokens("-", "50")).toBe("50");
  });
});
