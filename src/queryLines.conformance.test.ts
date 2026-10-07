import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertQueryEvidenceConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./TextClojure.ts";

const h = new Handler({"mimetype":"text/x-clojure","glyph":"🌿","extensions":[".clj",".cljs",".cljc",".edn"]});
const src = "(defn f [x] x)\n";

describe("{§mimetype-query-conformance} source evidence", () => {
    it("classifies structural nodes and computed values without inventing exact bounds", async () => {
        const region = {"startLine":1,"startColumn":1,"endLine":2,"endColumn":1};
        await assertQueryEvidenceConformance(h, [
            { source: src, dialect: "jsonpath", pattern: "$", verdict: "exact", expectRegions: [[region]] },
            { source: src, dialect: "xpath", pattern: "/*", verdict: "exact", expectRegions: [[region]] },
            { source: src, dialect: "jsonpath", pattern: "$.type", verdict: "enclosing", expectRegions: [[region]] },
            { source: src, dialect: "xpath", pattern: "/*/@pk:line", verdict: "enclosing", expectRegions: [[region]] },
            { source: src, dialect: "xpath", pattern: "count(//*)", verdict: "locator-only" },
            { source: src, dialect: "regex", pattern: "^...", verdict: "exact", expectRegions: [[{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 }]] },
            { source: src, dialect: "glob", pattern: "?de*", verdict: "exact", expectRegions: [[{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 15 }]] },
        ]);
    });

    for (const [dialect, pattern] of [["jsonpath", "$..*"], ["xpath", "//*"]] as const) {
        it(dialect + " wildcard preserves addressable source context for every result", async () => {
            const matches = await h.query(src, dialect, pattern);
            assert.ok(matches.length > 0);
            const lines = src.split("\n");
            for (const match of matches) {
                assert.ok(match.matching);
                assert.notEqual(match.regions !== undefined, match.enclosingRegions !== undefined,
                    "exact selection and enclosing context are distinct, present evidence");
                const regions = match.regions ?? match.enclosingRegions;
                assert.ok(regions && regions.length > 0);
                for (const region of regions) {
                    for (const [line, column] of [[region.startLine, region.startColumn], [region.endLine, region.endColumn]]) {
                        assert.ok(Number.isSafeInteger(line) && line >= 1 && line <= lines.length);
                        assert.ok(Number.isSafeInteger(column) && column >= 1 && column <= [...lines[line - 1]!].length + 1);
                    }
                    assert.ok(region.endLine > region.startLine || (region.endLine === region.startLine && region.endColumn >= region.startColumn));
                }
            }
        });
    }
});
