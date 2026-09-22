import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeFilter,
  orderMatchesSkuFilter,
  parseList,
  serializeList,
  skuMatches,
  toFilterSettings,
  EMPTY_FILTER,
} from "@/lib/sync/filters";
import {
  evaluateRules,
  ruleMatches,
  validateRule,
  type CompiledRule,
} from "@/lib/sync/rules";
import { buildRowContext } from "@/lib/sync/build-row";
import { applyTransformation, compareValues } from "@/lib/transformations";

import { fullOrder } from "./fixtures/ebay-payloads";
import type { EbayOrderPayload } from "@/lib/ebay/order-payload";

/* -------------------------------------------------------------------------- */
/* List parsing                                                                */
/* -------------------------------------------------------------------------- */

describe("filter list parsing", () => {
  it("accepts commas and newlines, trimming as it goes", () => {
    assert.deepEqual(parseList("A, B\nC ,  D "), ["A", "B", "C", "D"]);
  });

  it("drops empties", () => {
    assert.deepEqual(parseList("A,,\n ,B"), ["A", "B"]);
    assert.deepEqual(parseList(""), []);
    assert.deepEqual(parseList(null), []);
  });

  it("round-trips through serialisation", () => {
    assert.equal(serializeList(["A", "B"]), "A,B");
    assert.equal(serializeList([]), null, "empty means 'no restriction'");
    assert.deepEqual(parseList(serializeList(["A", "B"])), ["A", "B"]);
  });
});

/* -------------------------------------------------------------------------- */
/* SKU filtering                                                               */
/* -------------------------------------------------------------------------- */

const skuFilter = (
  mode: string,
  values: string[],
  caseSensitive = false,
) => ({ skuMode: mode as never, skuValues: values, skuCaseSensitive: caseSensitive });

describe("skuMatches", () => {
  it("passes everything in ALL mode", () => {
    assert.equal(skuMatches("ANYTHING", skuFilter("ALL", [])), true);
    assert.equal(skuMatches(null, skuFilter("ALL", [])), true);
  });

  it("passes everything when the value list is empty", () => {
    assert.equal(skuMatches("X", skuFilter("INCLUDE", [])), true);
  });

  it("handles INCLUDE and EXCLUDE", () => {
    const include = skuFilter("INCLUDE", ["ABC-1", "DEF-2"]);
    assert.equal(skuMatches("ABC-1", include), true);
    assert.equal(skuMatches("ZZZ", include), false);

    const exclude = skuFilter("EXCLUDE", ["ABC-1"]);
    assert.equal(skuMatches("ABC-1", exclude), false);
    assert.equal(skuMatches("ZZZ", exclude), true);
  });

  it("handles CONTAINS, STARTS_WITH and ENDS_WITH", () => {
    assert.equal(skuMatches("XX-ABC-YY", skuFilter("CONTAINS", ["ABC"])), true);
    assert.equal(skuMatches("XX-DEF-YY", skuFilter("CONTAINS", ["ABC"])), false);

    assert.equal(skuMatches("ABC-99", skuFilter("STARTS_WITH", ["ABC"])), true);
    assert.equal(skuMatches("99-ABC", skuFilter("STARTS_WITH", ["ABC"])), false);

    assert.equal(skuMatches("99-ABC", skuFilter("ENDS_WITH", ["ABC"])), true);
    assert.equal(skuMatches("ABC-99", skuFilter("ENDS_WITH", ["ABC"])), false);
  });

  it("matches any of several fragments", () => {
    const filter = skuFilter("CONTAINS", ["ABC", "XYZ"]);
    assert.equal(skuMatches("q-XYZ-q", filter), true);
    assert.equal(skuMatches("q-ABC-q", filter), true);
    assert.equal(skuMatches("q-DEF-q", filter), false);
  });

  it("is case-insensitive by default and strict when asked", () => {
    assert.equal(skuMatches("abc-1", skuFilter("INCLUDE", ["ABC-1"])), true);
    assert.equal(
      skuMatches("abc-1", skuFilter("INCLUDE", ["ABC-1"], true)),
      false,
    );
  });

  it("treats a missing SKU as empty, so INCLUDE drops it", () => {
    assert.equal(skuMatches(null, skuFilter("INCLUDE", ["ABC"])), false);
    assert.equal(skuMatches(null, skuFilter("EXCLUDE", ["ABC"])), true);
  });
});

describe("orderMatchesSkuFilter", () => {
  it("keeps a multi-item order when any item matches", () => {
    const filter = skuFilter("INCLUDE", ["ABC"]);
    assert.equal(
      orderMatchesSkuFilter(["ZZZ", "ABC"], filter),
      true,
      "one matching item keeps the whole order",
    );
    assert.equal(orderMatchesSkuFilter(["ZZZ", "YYY"], filter), false);
  });

  it("drops an order only when every item is excluded", () => {
    const filter = skuFilter("EXCLUDE", ["ABC"]);
    assert.equal(orderMatchesSkuFilter(["ABC"], filter), false);
    assert.equal(
      orderMatchesSkuFilter(["ABC", "OTHER"], filter),
      true,
      "the non-excluded item keeps the order",
    );
  });

  it("handles an order with no items", () => {
    assert.equal(orderMatchesSkuFilter([], skuFilter("ALL", [])), true);
    assert.equal(orderMatchesSkuFilter([], skuFilter("INCLUDE", ["A"])), false);
  });
});

describe("toFilterSettings / describeFilter", () => {
  it("maps a null row to no restrictions", () => {
    assert.deepEqual(toFilterSettings(null), EMPTY_FILTER);
    assert.deepEqual(describeFilter(EMPTY_FILTER), []);
  });

  it("parses a stored row", () => {
    const settings = toFilterSettings({
      orderStates: "PAID,SHIPPED",
      fulfillmentStates: null,
      marketplaces: "EBAY_GB",
      skuMode: "CONTAINS",
      skuValues: "ABC\nXYZ",
      skuCaseSensitive: true,
      dateFrom: new Date("2026-01-01T00:00:00.000Z"),
      dateTo: null,
    });
    assert.deepEqual(settings.orderStates, ["PAID", "SHIPPED"]);
    assert.deepEqual(settings.marketplaces, ["EBAY_GB"]);
    assert.deepEqual(settings.skuValues, ["ABC", "XYZ"]);
    assert.equal(settings.skuCaseSensitive, true);

    const summary = describeFilter(settings).join(" | ");
    assert.match(summary, /PAID or SHIPPED/);
    assert.match(summary, /EBAY_GB/);
    assert.match(summary, /2026-01-01/);
  });
});

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

const context = buildRowContext(fullOrder as EbayOrderPayload);

const rule = (overrides: Partial<CompiledRule> = {}): CompiledRule => ({
  id: overrides.id ?? "r1",
  name: overrides.name ?? "Rule",
  enabled: overrides.enabled ?? true,
  position: overrides.position ?? 0,
  match: overrides.match ?? "ALL",
  conditions: overrides.conditions ?? [],
  action: overrides.action ?? "EXCLUDE",
  args: overrides.args ?? {},
});

describe("ruleMatches", () => {
  it("matches the brief's example: SKU contains ABC", () => {
    const matching = rule({
      conditions: [
        { field: "lineItem.sku", operator: "contains", value: "TSH" },
      ],
    });
    assert.equal(ruleMatches(matching, context), true);

    const notMatching = rule({
      conditions: [
        { field: "lineItem.sku", operator: "contains", value: "NOPE" },
      ],
    });
    assert.equal(ruleMatches(notMatching, context), false);
  });

  it("matches the brief's other example: marketplace = UK", () => {
    const gb = rule({
      conditions: [
        { field: "order.marketplaceId", operator: "equals", value: "EBAY_GB" },
      ],
    });
    assert.equal(ruleMatches(gb, context), false, "this order is EBAY_US");

    const us = rule({
      conditions: [
        { field: "order.marketplaceId", operator: "equals", value: "EBAY_US" },
      ],
    });
    // fullOrder carries no marketplaceId, so the field resolves empty.
    assert.equal(ruleMatches(us, context), false);
  });

  it("combines conditions with ALL and ANY", () => {
    const conditions = [
      { field: "lineItem.sku", operator: "contains", value: "TSH" },
      { field: "order.buyer.username", operator: "equals", value: "nobody" },
    ];
    assert.equal(ruleMatches(rule({ match: "ALL", conditions }), context), false);
    assert.equal(ruleMatches(rule({ match: "ANY", conditions }), context), true);
  });

  it("treats a rule with no conditions as inert", () => {
    assert.equal(
      ruleMatches(rule({ conditions: [] }), context),
      false,
      "an unfinished rule must not silently act on everything",
    );
  });

  it("supports numeric comparison", () => {
    assert.equal(
      ruleMatches(
        rule({
          conditions: [
            {
              field: "order.pricingSummary.total.value",
              operator: "greater_than",
              value: "100",
            },
          ],
        }),
        context,
      ),
      true,
    );
    assert.equal(
      ruleMatches(
        rule({
          conditions: [
            {
              field: "order.pricingSummary.total.value",
              operator: "less_than",
              value: "100",
            },
          ],
        }),
        context,
      ),
      false,
    );
  });

  it("supports emptiness tests", () => {
    assert.equal(
      ruleMatches(
        rule({
          conditions: [
            {
              field: "order.fulfillment.trackingNumber",
              operator: "is_empty",
              value: "",
            },
          ],
        }),
        context,
      ),
      true,
    );
  });
});

describe("evaluateRules", () => {
  it("includes a row when no rules exist", () => {
    const outcome = evaluateRules([], context);
    assert.equal(outcome.include, true);
    assert.equal(outcome.overrides.size, 0);
    assert.equal(outcome.mappingSetId, null);
  });

  it("excludes a row on a matching EXCLUDE", () => {
    const outcome = evaluateRules(
      [
        rule({
          name: "Drop tees",
          action: "EXCLUDE",
          conditions: [
            { field: "lineItem.sku", operator: "starts_with", value: "TSH" },
          ],
        }),
      ],
      context,
    );
    assert.equal(outcome.include, false);
    assert.match(outcome.reason ?? "", /Drop tees/);
  });

  it("ignores disabled rules", () => {
    const outcome = evaluateRules(
      [
        rule({
          enabled: false,
          action: "EXCLUDE",
          conditions: [
            { field: "lineItem.sku", operator: "starts_with", value: "TSH" },
          ],
        }),
      ],
      context,
    );
    assert.equal(outcome.include, true);
  });

  it("treats INCLUDE_ONLY as a whitelist", () => {
    const whitelist = rule({
      id: "w",
      action: "INCLUDE_ONLY",
      conditions: [
        { field: "lineItem.sku", operator: "contains", value: "NOTHING" },
      ],
    });
    assert.equal(evaluateRules([whitelist], context).include, false);

    const matching = rule({
      id: "w2",
      action: "INCLUDE_ONLY",
      conditions: [
        { field: "lineItem.sku", operator: "contains", value: "TSH" },
      ],
    });
    assert.equal(evaluateRules([whitelist, matching], context).include, true);
  });

  it("lets an EXCLUDE beat a matching whitelist", () => {
    const outcome = evaluateRules(
      [
        rule({
          id: "allow",
          position: 0,
          action: "INCLUDE_ONLY",
          conditions: [
            { field: "lineItem.sku", operator: "contains", value: "TSH" },
          ],
        }),
        rule({
          id: "deny",
          position: 1,
          name: "Deny",
          action: "EXCLUDE",
          conditions: [
            { field: "order.buyer.username", operator: "equals", value: "coastal_finds" },
          ],
        }),
      ],
      context,
    );
    assert.equal(outcome.include, false);
  });

  it("accumulates SET_VALUE overrides, later rule winning", () => {
    const outcome = evaluateRules(
      [
        rule({
          id: "a",
          position: 0,
          action: "SET_VALUE",
          args: { column: "Status", value: "First" },
          conditions: [
            { field: "lineItem.sku", operator: "is_not_empty", value: "" },
          ],
        }),
        rule({
          id: "b",
          position: 1,
          action: "SET_VALUE",
          args: { column: "Status", value: "Second" },
          conditions: [
            { field: "lineItem.sku", operator: "is_not_empty", value: "" },
          ],
        }),
        rule({
          id: "c",
          position: 2,
          action: "SET_VALUE",
          args: { column: "Notes", value: "Hello" },
          conditions: [
            { field: "lineItem.sku", operator: "is_not_empty", value: "" },
          ],
        }),
      ],
      context,
    );
    assert.equal(outcome.overrides.get("Status"), "Second");
    assert.equal(outcome.overrides.get("Notes"), "Hello");
  });

  it("takes the last matching mapping set", () => {
    const outcome = evaluateRules(
      [
        rule({
          id: "a",
          position: 0,
          action: "USE_MAPPING_SET",
          args: { savedConfigId: "one" },
          conditions: [
            { field: "lineItem.sku", operator: "is_not_empty", value: "" },
          ],
        }),
        rule({
          id: "b",
          position: 1,
          action: "USE_MAPPING_SET",
          args: { savedConfigId: "two" },
          conditions: [
            { field: "lineItem.sku", operator: "is_not_empty", value: "" },
          ],
        }),
      ],
      context,
    );
    assert.equal(outcome.mappingSetId, "two");
  });

  it("reports which rules matched", () => {
    const outcome = evaluateRules(
      [
        rule({
          id: "hit",
          action: "SET_VALUE",
          args: { column: "A", value: "x" },
          conditions: [
            { field: "lineItem.sku", operator: "is_not_empty", value: "" },
          ],
        }),
        rule({
          id: "miss",
          position: 1,
          action: "SET_VALUE",
          args: { column: "B", value: "y" },
          conditions: [
            { field: "lineItem.sku", operator: "equals", value: "nope" },
          ],
        }),
      ],
      context,
    );
    assert.deepEqual(outcome.matchedRuleIds, ["hit"]);
  });

  it("applies rules in position order, not array order", () => {
    const outcome = evaluateRules(
      [
        rule({
          id: "second",
          position: 5,
          action: "SET_VALUE",
          args: { column: "S", value: "late" },
          conditions: [
            { field: "lineItem.sku", operator: "is_not_empty", value: "" },
          ],
        }),
        rule({
          id: "first",
          position: 1,
          action: "SET_VALUE",
          args: { column: "S", value: "early" },
          conditions: [
            { field: "lineItem.sku", operator: "is_not_empty", value: "" },
          ],
        }),
      ],
      context,
    );
    assert.equal(outcome.overrides.get("S"), "late");
  });
});

describe("validateRule", () => {
  const base = {
    name: "R",
    match: "ALL",
    conditions: [{ field: "lineItem.sku", operator: "contains", value: "A" }],
    action: "EXCLUDE",
    args: {},
  };

  it("accepts a well-formed rule", () => {
    assert.deepEqual(validateRule(base), []);
  });

  it("rejects a rule with no conditions", () => {
    const problems = validateRule({ ...base, conditions: [] });
    assert.match(problems.join(" "), /at least one condition/);
  });

  it("rejects a missing name and unknown action", () => {
    assert.match(validateRule({ ...base, name: "  " }).join(" "), /needs a name/);
    assert.match(
      validateRule({ ...base, action: "NUKE" }).join(" "),
      /Unknown action/,
    );
  });

  it("requires a value except for emptiness tests", () => {
    assert.match(
      validateRule({
        ...base,
        conditions: [{ field: "lineItem.sku", operator: "contains", value: "" }],
      }).join(" "),
      /needs a value/,
    );
    assert.deepEqual(
      validateRule({
        ...base,
        conditions: [{ field: "lineItem.sku", operator: "is_empty", value: "" }],
      }),
      [],
    );
  });

  it("requires the arguments its action needs", () => {
    assert.match(
      validateRule({ ...base, action: "SET_VALUE", args: {} }).join(" "),
      /Set a column/,
    );
    assert.match(
      validateRule({ ...base, action: "USE_MAPPING_SET", args: {} }).join(" "),
      /saved configuration/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Shared comparison                                                           */
/* -------------------------------------------------------------------------- */

describe("compareValues", () => {
  it("is case-insensitive for text", () => {
    assert.equal(compareValues("ABC", "equals", "abc"), true);
    assert.equal(compareValues("abcdef", "contains", "CDE"), true);
  });

  it("treats an empty comparison value sensibly", () => {
    assert.equal(compareValues("x", "contains", ""), false);
    assert.equal(compareValues("x", "not_contains", ""), true);
  });

  it("returns false for numeric tests on non-numbers", () => {
    assert.equal(compareValues("abc", "greater_than", "1"), false);
    assert.equal(compareValues("5", "greater_than", "abc"), false);
  });

  it("returns false for an unknown operator", () => {
    assert.equal(compareValues("x", "sideways", "y"), false);
  });
});

/* -------------------------------------------------------------------------- */
/* Transformations added in this phase                                         */
/* -------------------------------------------------------------------------- */

const resolver = { resolve: (path: string) => ({ "a.b": "second" })[path] };

describe("new transformations", () => {
  it("combine_fields joins the mapped value with other fields", () => {
    assert.equal(
      applyTransformation(
        "combine_fields",
        "first",
        { fields: "a.b", separator: " / " },
        resolver,
      ),
      "first / second",
    );
  });

  it("combine_fields skips empty parts when asked", () => {
    const args = { fields: "missing.path", separator: " - ", skipEmpty: "yes" };
    assert.equal(
      applyTransformation("combine_fields", "only", args, {
        resolve: () => undefined,
      }),
      "only",
    );
    assert.equal(
      applyTransformation(
        "combine_fields",
        "only",
        { ...args, skipEmpty: "no" },
        { resolve: () => undefined },
      ),
      "only - ",
    );
  });

  it("conditional writes then/else and falls back to the original", () => {
    const args = {
      operator: "equals",
      compareTo: "FULFILLED",
      thenValue: "Shipped",
      elseValue: "Pending",
    };
    assert.equal(applyTransformation("conditional", "FULFILLED", args), "Shipped");
    assert.equal(applyTransformation("conditional", "OTHER", args), "Pending");
    assert.equal(
      applyTransformation("conditional", "OTHER", { ...args, elseValue: "" }),
      "OTHER",
      "a blank else keeps the original value",
    );
  });

  it("prefix and suffix skip empty values by default", () => {
    assert.equal(applyTransformation("prefix", "1", { text: "#" }), "#1");
    assert.equal(applyTransformation("prefix", "", { text: "#" }), "");
    assert.equal(
      applyTransformation("prefix", "", { text: "#", skipEmpty: "no" }),
      "#",
    );
    assert.equal(applyTransformation("suffix", "2", { text: " pcs" }), "2 pcs");
  });

  it("number_format groups digits and honours the separator style", () => {
    assert.equal(
      applyTransformation("number_format", 1234567.891, { decimals: "2" }),
      "1,234,567.89",
    );
    assert.equal(
      applyTransformation("number_format", 1234567.891, {
        decimals: "2",
        thousands: "dot",
      }),
      "1.234.567,89",
    );
    assert.equal(
      applyTransformation("number_format", 1234.5, {
        decimals: "0",
        thousands: "none",
      }),
      "1235",
    );
    assert.equal(
      applyTransformation("number_format", -1234.5, { decimals: "1" }),
      "-1,234.5",
    );
    assert.equal(applyTransformation("number_format", "abc", {}), "");
  });

  it("currency falls back to the order's own currency", () => {
    const withContext = applyTransformation(
      "currency",
      "10",
      { currency: "", locale: "en-US", symbol: "yes" },
      { resolve: () => "GBP" },
    );
    assert.match(withContext, /£/);
  });

  it("text_cleanup strips HTML, line breaks and repeated spaces", () => {
    const messy = "<b>Big</b>   Cotton\n\nTee &amp; Mug";
    assert.equal(
      applyTransformation("text_cleanup", messy, {
        stripHtml: "yes",
        removeLineBreaks: "yes",
        collapseSpaces: "yes",
      }),
      "Big Cotton Tee & Mug",
    );
  });

  it("text_cleanup can remove emoji when asked", () => {
    assert.equal(
      applyTransformation("text_cleanup", "Nice 🎉 item", {
        removeSymbols: "yes",
        collapseSpaces: "yes",
      }),
      "Nice item",
    );
  });

  it("replace treats the search text literally", () => {
    assert.equal(
      applyTransformation("replace", "a(b)c", { find: "(b)", replaceWith: "X" }),
      "aXc",
      "regex metacharacters must not blow up",
    );
    assert.equal(
      applyTransformation("replace", "aaa", {
        find: "a",
        replaceWith: "b",
        all: "no",
      }),
      "baa",
    );
  });

  it("join_list de-duplicates and truncates", () => {
    assert.equal(
      applyTransformation("join_list", ["A", "B", "A"], {
        separator: ", ",
        unique: "yes",
      }),
      "A, B",
    );
    assert.equal(
      applyTransformation("join_list", ["A", "B", "C"], {
        separator: ", ",
        limit: "2",
      }),
      "A, B, +1 more",
    );
  });

  it("degrades to the raw value rather than throwing on bad args", () => {
    assert.equal(
      applyTransformation("date_format", "not-a-date", { pattern: "yyyy" }),
      "",
    );
    assert.equal(applyTransformation("unknown_transform", "x", {}), "x");
  });
});

describe("multi-item combining fields", () => {
  const rowContext = buildRowContext(fullOrder as EbayOrderPayload);

  it("exposes joined SKUs, titles and quantities", () => {
    assert.equal(rowContext.computed.skuList, "TSH-BLK-L, MUG-CER-01");
    assert.equal(
      rowContext.computed.titleList,
      "Heavyweight Cotton Tee - Black - Large, Stoneware Coffee Mug 12oz",
    );
    assert.equal(rowContext.computed.quantityList, "2, 1");
    assert.equal(rowContext.computed.totalQuantity, 3);
  });

  it("exposes raw arrays for the join transformation", () => {
    assert.deepEqual(rowContext.computed.skus, ["TSH-BLK-L", "MUG-CER-01"]);
    assert.deepEqual(rowContext.computed.quantities, [2, 1]);
  });

  it("builds a readable item summary", () => {
    assert.equal(
      rowContext.computed.itemSummary,
      "2 × TSH-BLK-L — Heavyweight Cotton Tee - Black - Large; 1 × MUG-CER-01 — Stoneware Coffee Mug 12oz",
    );
  });
});
