import { describe, it } from "node:test";
import { assertQueryLineConformance } from "@plurnk/plurnk-mimetypes/conformance";
import Handler from "./TextClojure.ts";

// #41: structural matches carry source-line spans (coverage gate).
const h = new Handler({"mimetype":"text/x-clojure","glyph":"🌿","extensions":[".clj",".cljs",".cljc",".edn"]});

describe("#41 query-line conformance", () => {
    it("every structural match carries a source-line span", async () => {
        await assertQueryLineConformance(h, [{ source: "(defn f [x] x)\n", dialect: "jsonpath", pattern: "$..*" }]);
    });
});
